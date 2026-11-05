class_name PlayerProfile
extends RefCounted

signal equipment_changed(character_id: StringName, weapon_id: StringName)
signal save_status_changed
signal settings_changed

const STARTER_WEAPONS: Array[StringName] = [&"crescent_wheel", &"star_lance"]
const CHARACTERS := {&"shadow_runner": preload("res://data/characters/shadow_runner.tres")}
const WEAPONS := {
	&"crescent_wheel": preload("res://data/weapons/crescent_wheel.tres"),
	&"star_lance": preload("res://data/weapons/star_lance.tres"),
}
static var _shared: PlayerProfile

var selected_character_id: StringName = &"shadow_runner"
var owned_weapon_ids: Array[StringName] = STARTER_WEAPONS.duplicate()
var character_loadouts: Dictionary = {}
var save_path := "user://save.json"
var last_error := ""
var save_pending := false
var load_notice := ""
var history := RunHistory.new()
var feedback_settings := FeedbackSettings.defaults()
var _document: Dictionary = {}
var _reward_state: Dictionary = {}
var _pending_transaction: Dictionary = {}
var _transaction_failed := false
var coins: int:
	get: return int(_reward_state.get("coins", 0))
var pending_transaction: Dictionary:
	get: return _pending_transaction.duplicate(true)

func reward_summary(run_id: String) -> Dictionary:
	var ledger: Dictionary = _reward_state.get("reward_ledger", {})
	var runs: Dictionary = ledger.get("runs", {})
	return (runs.get(run_id, {}) as Dictionary).duplicate(true)

func reward_state() -> Dictionary:
	return _reward_state.duplicate(true)

func can_start_formal_run() -> bool:
	if ProfileStore.is_newer(_document):
		last_error = "存档版本较新，暂不能开始正式挑战；可进入免费练习。"
		return false
	if _transaction_failed:
		last_error = "通关奖励尚未保存，请先重试保存；可进入免费练习。"
		return false
	# Commit starter/legacy entitlements before starting the first formal run.
	if not _pending_transaction.is_empty():
		return save_profile()
	return true

static func current() -> PlayerProfile:
	if _shared == null:
		_shared = PlayerProfile.new()
		_shared.load_profile()
		FeedbackSettings.apply(_shared.feedback_settings)
	return _shared

func _init(path: String = "user://save.json") -> void:
	save_path = path
	_reward_state = RewardService.initial_state({}, history)
	_pending_transaction = {"id": "rewards-migration-v3", "kind": "migration"}
	save_pending = true

func load_profile() -> void:
	var loaded := ProfileStore.read(save_path)
	_document = loaded.document
	load_notice = loaded.notice
	save_pending = false
	last_error = ""
	selected_character_id = &"shadow_runner"
	owned_weapon_ids = STARTER_WEAPONS.duplicate()
	character_loadouts.clear()
	history.load_records(_document.get("run_records", {}))
	history.load_progress(_document.get("level_progress", {}))
	_pending_transaction = {}
	_transaction_failed = false
	if not ProfileStore.is_newer(_document):
		_reward_state = RewardService.initial_state(_document, history)
		if int(_document.get("version", 0)) < 3:
			_pending_transaction = {"id": "rewards-migration-v3", "kind": "migration"}
			save_pending = true
	else:
		_reward_state = {}
	feedback_settings = FeedbackSettings.defaults()
	var settings: Variant = _document.get("settings", {})
	if settings is Dictionary:
		for key in feedback_settings:
			if settings.get(key, null) is bool:
				feedback_settings[key] = settings[key]
	if ProfileStore.is_newer(_document):
		load_notice = "存档来自较新版本，本次更改仅在本次运行中生效。"
	var owned: Variant = _document.get("owned_weapon_ids", null)
	if owned is Array:
		owned_weapon_ids.clear()
		for entry in owned:
			if entry is String and WEAPONS.has(StringName(entry)) and not owned_weapon_ids.has(StringName(entry)):
				owned_weapon_ids.append(StringName(entry))
	# Missing or entirely invalid ownership data recovers the starter set.
	if owned_weapon_ids.is_empty():
		owned_weapon_ids = STARTER_WEAPONS.duplicate()
	var saved: Variant = _document.get("character_loadouts", {})
	if saved is Dictionary:
		character_loadouts = saved.duplicate(true)
	var selected: Variant = _document.get("selected_character_id", "shadow_runner")
	if selected is String and CHARACTERS.has(StringName(selected)):
		selected_character_id = StringName(selected)
	for data: CharacterData in CHARACTERS.values():
		var record: Variant = character_loadouts.get(String(data.character_id), {})
		if not record is Dictionary:
			record = {}
		record["weapon_id"] = String(get_equipped_weapon(data).weapon_id)
		character_loadouts[String(data.character_id)] = record

func get_equipped_weapon(character: CharacterData) -> WeaponData:
	var entry: Variant = character_loadouts.get(String(character.character_id), {})
	var id := character.default_weapon_id
	if entry is Dictionary and entry.get("weapon_id", null) is String:
		id = StringName(entry.weapon_id)
	var weapon := WEAPONS.get(id) as WeaponData
	if weapon != null and owned_weapon_ids.has(id) and weapon.allows(character.character_id) and weapon.get_validation_errors().is_empty():
		return weapon
	weapon = WEAPONS.get(character.default_weapon_id) as WeaponData
	if weapon != null and owned_weapon_ids.has(weapon.weapon_id) and weapon.allows(character.character_id):
		return weapon
	for owned_id in owned_weapon_ids:
		weapon = WEAPONS.get(owned_id) as WeaponData
		if weapon != null and weapon.allows(character.character_id) and weapon.get_validation_errors().is_empty():
			return weapon
	for starter in STARTER_WEAPONS:
		weapon = WEAPONS[starter]
		if weapon.allows(character.character_id):
			if not owned_weapon_ids.has(starter):
				owned_weapon_ids.append(starter)
			return weapon
	return WEAPONS[&"crescent_wheel"]

func list_weapons(character: CharacterData) -> Array[WeaponData]:
	var result: Array[WeaponData] = []
	for id in owned_weapon_ids:
		var weapon := WEAPONS.get(id) as WeaponData
		if weapon != null and weapon.allows(character.character_id):
			result.append(weapon)
	return result

func try_equip(character: CharacterData, weapon_id: StringName) -> bool:
	last_error = ""
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null and not tree.get_nodes_in_group("run_sessions").is_empty():
		last_error = "本局装备已固定，请返回准备页更换。"
		return false
	var weapon := WEAPONS.get(weapon_id) as WeaponData
	if character == null or not CHARACTERS.has(character.character_id) or weapon == null or not owned_weapon_ids.has(weapon_id) or not weapon.allows(character.character_id) or not weapon.get_validation_errors().is_empty():
		last_error = "当前角色无法装备这把武器。"
		return false
	var loadout := CharacterLoadout.new(character.character_id, weapon_id)
	var record: Variant = character_loadouts.get(String(loadout.character_id), {})
	if not record is Dictionary:
		record = {}
	record["weapon_id"] = String(loadout.weapon_id)
	character_loadouts[String(loadout.character_id)] = record
	save_pending = true
	equipment_changed.emit(loadout.character_id, loadout.weapon_id)
	return true

func resolve(character: CharacterData = null) -> RunLoadout:
	if character == null:
		character = CHARACTERS[selected_character_id]
	return RunLoadout.capture(character, get_equipped_weapon(character))

func save_profile() -> bool:
	last_error = ""
	if ProfileStore.is_newer(_document):
		last_error = "存档版本较新，本次更改暂未保存。"
		save_status_changed.emit()
		return false
	var document := _document.duplicate(true)
	document["version"] = ProfileStore.VERSION
	document["selected_character_id"] = String(selected_character_id)
	document["owned_weapon_ids"] = owned_weapon_ids.map(func(id: StringName) -> String: return String(id))
	document["character_loadouts"] = character_loadouts.duplicate(true)
	document["run_records"] = history.to_dictionary()
	document["level_progress"] = history.progress_to_dictionary()
	for field in RewardService.FIELDS:
		document[field] = _reward_state[field]
	document["pending_transaction"] = null
	var settings: Variant = document.get("settings", {})
	if not settings is Dictionary:
		settings = {}
	for key in feedback_settings:
		settings[key] = feedback_settings[key]
	document["settings"] = settings
	if not ProfileStore.write(save_path, document):
		last_error = "本次更改已生效，暂未保存。"
		_transaction_failed = not _pending_transaction.is_empty()
		save_status_changed.emit()
		return false
	_document = document
	_pending_transaction = {}
	_transaction_failed = false
	save_pending = false
	load_notice = ""
	save_status_changed.emit()
	return true

func set_feedback_setting(key: String, enabled: bool) -> bool:
	if not feedback_settings.has(key):
		return false
	feedback_settings[key] = enabled
	FeedbackSettings.apply(feedback_settings)
	save_pending = true
	settings_changed.emit()
	return save_profile()

func record_completion(level_id: StringName, mode: StringName, result: RunResult) -> bool:
	if mode == &"full" and result != null and result.score_rule_version != 0:
		# Future documents remain read-only; keep understandable records in memory.
		if ProfileStore.is_newer(_document):
			if history.record_completion(level_id, mode, result):
				save_pending = true
			return save_profile()
		if LevelCatalog.canonicalize(level_id) != result.level_id or _transaction_failed or (not _pending_transaction.is_empty() and _pending_transaction.kind != "migration"):
			last_error = "通关奖励尚未保存，请先重试保存。"
			return false
		var transaction := RewardService.complete_run(_reward_state, history, result)
		if transaction.is_empty():
			return false
		_reward_state = transaction.state
		history.load_progress(transaction.progress)
		_pending_transaction = {"id": result.run_id, "kind": "completion", "summary": transaction.summary.duplicate(true)}
		save_pending = true
		return save_profile()
	if not history.record_completion(level_id, mode, result):
		return false
	save_pending = true
	return save_profile()
