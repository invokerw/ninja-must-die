class_name RewardService
extends RefCounted

const FIELDS := ["coins", "reward_ledger", "unlocked_level_ids", "unlocked_character_ids"]
const MAX_COINS := 1000000000
const MILESTONES := {6: 120, 10: 200, 15: 300}

static func initial_state(document: Dictionary, history: RunHistory) -> Dictionary:
	if int(document.get("version", 0)) >= 3:
		var state := {}
		for field in FIELDS:
			state[field] = document.get(field).duplicate(true) if document.get(field) is Dictionary or document.get(field) is Array else document.get(field)
		return state
	var state := {
		"coins": 0,
		"reward_ledger": {"grants": {}, "paid_stars": {}, "runs": {}},
		"unlocked_level_ids": [], "unlocked_character_ids": [],
	}
	_claim(state, "starter", 120)
	# v1/v2 contain completed records but no money. Only one-off entitlements
	# migrate; never replay base/collection rewards from completion counters.
	for entry in LevelCatalog.list_levels():
		var record := history.get_record(entry.level_id, &"full")
		if record.is_empty():
			continue
		_claim(state, String(entry.first_clear_reward_id), 160)
		var stars := int(record.get("best_stars", 0))
		state.reward_ledger.paid_stars[String(entry.level_id)] = stars
		_claim(state, "stars:%s:migration" % entry.level_id, stars * 40)
		if record.get("flawless", false):
			_claim(state, "flawless:%s" % entry.level_id, 30)
		var progress: Variant = history.progress_to_dictionary().get(String(entry.level_id), {})
		if progress is Dictionary and progress.get("completed_run_ids") is Dictionary:
			for run_id in progress.completed_run_ids:
				state.reward_ledger.runs[run_id] = {"migrated": true}
	_update_unlocks(state, history)
	_update_milestones(state, history)
	return state

static func complete_run(state: Dictionary, history: RunHistory, result: RunResult) -> Dictionary:
	if not valid_state(state) or result == null or not result.completed or result.mode != &"full":
		return {}
	var entry := LevelCatalog.get_level(result.level_id)
	var snapshot := result.to_snapshot()
	if entry.is_empty() or not LevelProgress.valid_snapshot(snapshot) or snapshot.collectible_total != entry.collectible_total:
		return {}
	if state.reward_ledger.runs.has(result.run_id):
		return {}
	var next_history := RunHistory.new()
	next_history.load_records(history.to_dictionary())
	next_history.load_progress(history.progress_to_dictionary())
	if not next_history.record_completion(result.level_id, &"full", result):
		return {}
	var next := state.duplicate(true)
	var ledger: Dictionary = next.reward_ledger
	var breakdown := {"base": 60, "collection": 0, "first_clear": 0, "stars": 0, "flawless": 0, "milestones": 0}
	@warning_ignore("integer_division")
	var collection := 20 * result.collectible_count / result.collectible_total
	breakdown.collection = collection
	breakdown.first_clear = _claim(next, String(entry.first_clear_reward_id), 160)
	var paid := int(ledger.paid_stars.get(String(entry.level_id), 0))
	var new_stars := maxi(0, result.stars - paid)
	breakdown.stars = new_stars * 40
	ledger.paid_stars[String(entry.level_id)] = maxi(paid, result.stars)
	if result.flawless:
		breakdown.flawless = _claim(next, "flawless:%s" % entry.level_id, 30)
	var before_milestones := int(next.coins)
	_update_milestones(next, next_history)
	breakdown.milestones = int(next.coins) - before_milestones
	next.coins += breakdown.base + collection + breakdown.stars
	var total := 0
	for amount: int in breakdown.values():
		total += amount
	var old_levels: Array = next.unlocked_level_ids.duplicate()
	var old_characters: Array = next.unlocked_character_ids.duplicate()
	_update_unlocks(next, next_history)
	var summary := {
		"run_id": result.run_id, "level_id": String(entry.level_id),
		"breakdown": breakdown, "total": total, "balance": next.coins,
		"new_stars": new_stars, "new_level_ids": [], "new_character_ids": [],
	}
	for id in next.unlocked_level_ids:
		if id not in old_levels:
			summary.new_level_ids.append(id)
	for id in next.unlocked_character_ids:
		if id not in old_characters:
			summary.new_character_ids.append(id)
	ledger.runs[result.run_id] = summary.duplicate(true)
	if not valid_state(next):
		return {}
	return {"state": next, "progress": next_history.progress_to_dictionary(), "summary": summary}

static func claim_milestones(state: Dictionary, chapter_id: StringName, stars: int) -> void:
	for threshold: int in MILESTONES:
		if stars >= threshold:
			_claim(state, "milestone:%s:%d" % [chapter_id, threshold], MILESTONES[threshold])

static func _update_milestones(state: Dictionary, history: RunHistory) -> void:
	var chapter_stars := {}
	for entry in LevelCatalog.list_levels():
		var chapter := String(entry.chapter_id)
		chapter_stars[chapter] = int(chapter_stars.get(chapter, 0)) + int(history.get_record(entry.level_id, &"full").get("best_stars", 0))
	for chapter in chapter_stars:
		claim_milestones(state, StringName(chapter), chapter_stars[chapter])

static func _update_unlocks(state: Dictionary, history: RunHistory) -> void:
	var completed: Array[StringName] = []
	for entry in LevelCatalog.list_levels():
		if not history.get_record(entry.level_id, &"full").is_empty():
			completed.append(entry.level_id)
	for entry in LevelCatalog.list_levels():
		if LevelCatalog.is_unlocked(entry.level_id, completed) and String(entry.level_id) not in state.unlocked_level_ids:
			state.unlocked_level_ids.append(String(entry.level_id))
	for character: CharacterData in CharacterRegistry.CHARACTERS.values():
		if character.unlock_id == &"starter" or state.reward_ledger.grants.has(String(character.unlock_id)):
			if String(character.character_id) not in state.unlocked_character_ids:
				state.unlocked_character_ids.append(String(character.character_id))

static func _claim(state: Dictionary, id: String, amount: int) -> int:
	if state.reward_ledger.grants.has(id):
		return 0
	state.reward_ledger.grants[id] = amount
	state.coins += amount
	return amount

static func valid_state(state: Dictionary) -> bool:
	if not LevelProgress.integer(state.get("coins")) or state.coins > MAX_COINS:
		return false
	for field in ["unlocked_level_ids", "unlocked_character_ids"]:
		if not state.get(field) is Array:
			return false
		for id in state[field]:
			if not id is String or id.is_empty():
				return false
	var ledger: Variant = state.get("reward_ledger")
	if not ledger is Dictionary:
		return false
	for field in ["grants", "paid_stars", "runs"]:
		if not ledger.get(field) is Dictionary:
			return false
	for id in ledger.grants:
		if not id is String or not LevelProgress.integer(ledger.grants[id]) or ledger.grants[id] > MAX_COINS:
			return false
	for id in ledger.paid_stars:
		if not id is String or not LevelProgress.integer(ledger.paid_stars[id]) or ledger.paid_stars[id] > 3:
			return false
	for id in ledger.runs:
		if not id is String or id.is_empty() or not ledger.runs[id] is Dictionary:
			return false
		var receipt: Dictionary = ledger.runs[id]
		if receipt.get("migrated") == true:
			continue
		if receipt.get("run_id") != id or not receipt.get("level_id") is String or not receipt.get("breakdown") is Dictionary:
			return false
		var total := 0
		for field in ["base", "collection", "first_clear", "stars", "flawless", "milestones"]:
			var amount: Variant = receipt.breakdown.get(field)
			if not LevelProgress.integer(amount) or amount > MAX_COINS:
				return false
			total += int(amount)
		if not LevelProgress.integer(receipt.get("total")) or receipt.total != total or not LevelProgress.integer(receipt.get("balance")) or receipt.balance > MAX_COINS:
			return false
		if not LevelProgress.integer(receipt.get("new_stars")) or receipt.new_stars > 3:
			return false
		for field in ["new_level_ids", "new_character_ids"]:
			if not receipt.get(field) is Array:
				return false
			for unlocked_id in receipt[field]:
				if not unlocked_id is String:
					return false
	return true
