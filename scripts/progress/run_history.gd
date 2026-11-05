class_name RunHistory
extends RefCounted

const MODES: Array[StringName] = [&"full", &"parkour_practice", &"boss_practice"]
const RANKS := ["C", "B", "A", "S"]
var _records: Dictionary = {}
var _progress: Dictionary = {}

func load_records(document: Variant) -> void:
	_records = document.duplicate(true) if document is Dictionary else {}

func to_dictionary() -> Dictionary:
	return _records.duplicate(true)

func load_progress(document: Variant) -> void:
	_progress = document.duplicate(true) if document is Dictionary else {}

func progress_to_dictionary() -> Dictionary:
	return _progress.duplicate(true)

func get_record(level_id: StringName, mode: StringName, character_id: StringName = &"") -> Dictionary:
	var legacy := _legacy_record(level_id, mode)
	if mode != &"full":
		return legacy
	var entry: Variant = _progress.get(String(LevelCatalog.canonicalize(level_id)), {})
	var record: Variant = {}
	if entry is Dictionary:
		if character_id.is_empty():
			record = entry.get("overall", {})
		elif entry.get("characters") is Dictionary:
			record = entry.characters.get(String(character_id), {})
	if LevelProgress.valid_record(record):
		var same_level: bool = record.best_score_snapshot.level_id == String(LevelCatalog.canonicalize(level_id))
		var same_character := character_id.is_empty()
		if not same_character:
			same_character = record.best_score_snapshot.character_id == String(character_id) and record.fastest_snapshot.character_id == String(character_id)
			if record.flawless:
				same_character = same_character and record.flawless_snapshot.character_id == String(character_id)
		if same_level and same_character:
			var result: Dictionary = record.duplicate(true)
			result["legacy_record"] = legacy
			return result
	# Old aggregate records have no character or raw damage snapshot.
	if not legacy.is_empty() and character_id.is_empty():
		legacy["legacy"] = true
		return legacy
	return {}

func _legacy_record(level_id: StringName, mode: StringName) -> Dictionary:
	var record := _legacy_record_at(level_id, mode)
	if not record.is_empty():
		return record
	var canonical := LevelCatalog.canonicalize(level_id)
	if canonical != level_id:
		return _legacy_record_at(canonical, mode)
	var alias: StringName = LevelCatalog.get_level(canonical).get("legacy_level_id", &"")
	return _legacy_record_at(alias, mode) if not alias.is_empty() else {}

func _legacy_record_at(level_id: StringName, mode: StringName) -> Dictionary:
	var level: Variant = _records.get(String(level_id), {})
	if not level is Dictionary:
		return {}
	var record: Variant = level.get(String(mode), {})
	if not record is Dictionary or not _valid_record(record):
		return {}
	return record.duplicate(true)

func record_completion(level_id: StringName, mode: StringName, result: RunResult) -> bool:
	if level_id.is_empty() or mode not in MODES or not _valid_result(result):
		return false
	if result.score_rule_version != 0:
		return _record_formal(level_id, mode, result)
	var record := _legacy_record_at(level_id, mode)
	if record.is_empty():
		record = {"best_time": result.time_seconds, "best_rank": result.rank, "best_score": result.score, "best_collected": result.collectible_count, "collectible_total": result.collectible_total, "completions": 0}
	record.best_time = minf(float(record.best_time), result.time_seconds)
	record.best_score = maxi(int(record.best_score), result.score)
	if RANKS.find(result.rank) > RANKS.find(record.best_rank):
		record.best_rank = result.rank
	var previous_ratio := float(record.best_collected) / maxf(float(record.collectible_total), 1.0)
	var ratio := float(result.collectible_count) / maxf(float(result.collectible_total), 1.0)
	if ratio > previous_ratio or (is_equal_approx(ratio, previous_ratio) and result.collectible_count > int(record.best_collected)):
		record.best_collected = result.collectible_count
		record.collectible_total = result.collectible_total
	record.completions = int(record.completions) + 1
	var level: Variant = _records.get(String(level_id), {})
	if not level is Dictionary:
		level = {}
	level[String(mode)] = record
	_records[String(level_id)] = level
	return true

func _record_formal(level_id: StringName, mode: StringName, result: RunResult) -> bool:
	var canonical := String(LevelCatalog.canonicalize(level_id))
	var snapshot := result.to_snapshot()
	if mode != &"full" or snapshot.level_id != canonical or not LevelProgress.valid_snapshot(snapshot):
		return false
	var entry: Variant = _progress.get(canonical, {})
	entry = entry.duplicate(true) if entry is Dictionary else {}
	var runs: Variant = entry.get("completed_run_ids", {})
	runs = runs.duplicate(true) if runs is Dictionary else {}
	if runs.has(result.run_id):
		return false
	var characters: Variant = entry.get("characters", {})
	characters = characters.duplicate(true) if characters is Dictionary else {}
	var previous: Variant = characters.get(String(result.character_id), {})
	characters[String(result.character_id)] = LevelProgress.update_record(previous if previous is Dictionary else {}, snapshot, true)
	previous = entry.get("overall", {})
	entry["overall"] = LevelProgress.update_record(previous if previous is Dictionary else {}, snapshot)
	entry["characters"] = characters
	runs[result.run_id] = true
	entry["completed_run_ids"] = runs
	_progress[canonical] = entry
	return true

static func _valid_result(result: RunResult) -> bool:
	return result != null and is_finite(result.time_seconds) and result.time_seconds > 0.0 and result.rank in RANKS and result.score >= 0 and result.damage_count >= 0 and result.collectible_count >= 0 and result.collectible_total >= result.collectible_count

static func _valid_record(record: Dictionary) -> bool:
	if not record.get("best_rank", null) in RANKS or not _number(record.get("best_time", null), true):
		return false
	for field in ["best_score", "best_collected", "collectible_total", "completions"]:
		var value: Variant = record.get(field, null)
		if not _number(value) or float(value) != floorf(float(value)):
			return false
	return int(record.collectible_total) >= int(record.best_collected) and int(record.completions) > 0

static func _number(value: Variant, positive: bool = false) -> bool:
	return (value is int or value is float) and is_finite(float(value)) and (float(value) > 0.0 if positive else float(value) >= 0.0) and float(value) < 1.0e12
