class_name RunHistory
extends RefCounted

const MODES: Array[StringName] = [&"full", &"parkour_practice", &"boss_practice"]
const RANKS := ["C", "B", "A", "S"]
var _records: Dictionary = {}

func load_records(document: Variant) -> void:
	_records = document.duplicate(true) if document is Dictionary else {}

func to_dictionary() -> Dictionary:
	return _records.duplicate(true)

func get_record(level_id: StringName, mode: StringName) -> Dictionary:
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
	var record := get_record(level_id, mode)
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
