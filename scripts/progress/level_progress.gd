class_name LevelProgress
extends RefCounted

# Every star/score comes from one complete run. Independent fastest/collection
# records must never be combined into a synthetic star result.
static func update_record(previous: Dictionary, snapshot: Dictionary, character_only := false) -> Dictionary:
	var reusable := valid_record(previous)
	if reusable:
		reusable = previous.best_score_snapshot.level_id == snapshot.level_id
		if character_only:
			reusable = reusable and previous.best_score_snapshot.character_id == snapshot.character_id and previous.fastest_snapshot.character_id == snapshot.character_id
	var record := previous.duplicate(true)
	if not reusable:
		record.merge({
			"best_stars": snapshot.stars, "best_score": snapshot.score,
			"best_time": snapshot.time_seconds, "best_collected": snapshot.collected,
			"collectible_total": snapshot.collectible_total, "completions": 0,
			"flawless": false, "flawless_snapshot": {},
			"best_score_snapshot": snapshot.duplicate(true), "fastest_snapshot": snapshot.duplicate(true),
		}, true)
	if snapshot.score > record.best_score:
		record.best_score = snapshot.score
		record.best_stars = snapshot.stars
		record.best_score_snapshot = snapshot.duplicate(true)
	if snapshot.time_seconds < record.best_time:
		record.best_time = snapshot.time_seconds
		record.fastest_snapshot = snapshot.duplicate(true)
	if snapshot.collected * int(record.collectible_total) > int(record.best_collected) * int(snapshot.collectible_total):
		record.best_collected = snapshot.collected
		record.collectible_total = snapshot.collectible_total
	if snapshot.flawless and not record.flawless:
		record.flawless = true
		record.flawless_snapshot = snapshot.duplicate(true)
	record.completions = int(record.completions) + 1
	return record

static func valid_snapshot(value: Variant) -> bool:
	if not value is Dictionary:
		return false
	for field in ["level_id", "run_id", "character_id", "weapon_id", "completed_at"]:
		if not value.get(field) is String or value[field].is_empty():
			return false
	if value.get("mode") != "full" or value.get("score_rule_version") != RunResult.STAR_RULE_VERSION:
		return false
	if not number(value.get("time_seconds"), true):
		return false
	for field in ["damage_count", "collected", "collectible_total", "kills", "max_combo", "score", "stars"]:
		if not integer(value.get(field)):
			return false
	if value.collectible_total <= 0 or value.collected > value.collectible_total:
		return false
	var points := RunResult.star_score(int(value.collected), int(value.collectible_total), int(value.damage_count))
	return value.score == points and value.stars == RunResult.stars_for_score(points) and value.get("flawless") is bool and value.flawless == (value.damage_count == 0) and value.get("growth_snapshot") is Dictionary and value.get("item_snapshot") is Dictionary

static func valid_record(value: Variant) -> bool:
	if not value is Dictionary or not valid_snapshot(value.get("best_score_snapshot")) or not valid_snapshot(value.get("fastest_snapshot")):
		return false
	for field in ["best_stars", "best_score", "best_collected", "collectible_total", "completions"]:
		if not integer(value.get(field)):
			return false
	if not number(value.get("best_time"), true) or value.completions < 1 or value.collectible_total <= 0 or value.best_collected > value.collectible_total:
		return false
	var best: Dictionary = value.best_score_snapshot
	var fastest: Dictionary = value.fastest_snapshot
	if best.level_id != fastest.level_id or value.best_stars != best.stars or value.best_score != best.score or value.best_time != fastest.time_seconds:
		return false
	if not value.get("flawless") is bool:
		return false
	if value.flawless:
		var stamp: Variant = value.get("flawless_snapshot")
		if not valid_snapshot(stamp) or not stamp.flawless or stamp.level_id != best.level_id:
			return false
	return true

static func integer(value: Variant) -> bool:
	return number(value) and float(value) == floorf(float(value))

static func number(value: Variant, positive := false) -> bool:
	return (value is int or value is float) and is_finite(float(value)) and (float(value) > 0.0 if positive else float(value) >= 0.0) and float(value) < 1.0e12
