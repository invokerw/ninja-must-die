class_name RunResult
extends RefCounted

const STAR_RULE_VERSION := 1

var time_seconds: float
var damage_count: int
var collectible_count: int
var collectible_total: int
var kills: int
var max_combo: int
var score: int
var rank: String
var completed := false
var stars := 0
var flawless := false
var score_rule_version := 0
var level_id: StringName = &""
var mode: StringName = &""
var run_id := ""
var character_id: StringName = &""
var weapon_id: StringName = &""
var loadout_rules_version := 1
var growth_snapshot: Dictionary = {}
var item_snapshot: Dictionary = {}

static func star_score(collected: int, total: int, damage: int) -> int:
	if total <= 0 or collected < 0 or collected > total or damage < 0:
		return -1
	@warning_ignore("integer_division")
	var collection_points := 1000 * collected / total
	return 1000 + collection_points + maxi(0, 1000 - 150 * damage)

static func stars_for_score(points: int) -> int:
	if points < 0:
		return 0
	return 3 if points >= 2600 else (2 if points >= 2200 else 1)

func apply_formal_rules() -> void:
	score = star_score(collectible_count, collectible_total, damage_count)
	score_rule_version = STAR_RULE_VERSION
	stars = stars_for_score(score) if score >= 0 else 0
	flawless = damage_count == 0

func capture_context(level: StringName, run_mode: StringName, id: String, loadout: RunLoadout) -> void:
	level_id = LevelCatalog.canonicalize(level)
	mode = run_mode
	run_id = id
	character_id = loadout.character.character_id
	weapon_id = loadout.weapon.weapon_id
	loadout_rules_version = loadout.rules_version
	growth_snapshot = loadout.growth_snapshot.duplicate(true)
	item_snapshot = loadout.item_snapshot.duplicate(true)

func to_snapshot() -> Dictionary:
	return {
		"level_id": String(level_id), "mode": String(mode), "run_id": run_id,
		"time_seconds": time_seconds, "damage_count": damage_count,
		"collected": collectible_count, "collectible_total": collectible_total,
		"kills": kills, "max_combo": max_combo, "score": score, "stars": stars,
		"flawless": flawless, "score_rule_version": score_rule_version, "rank": rank,
		"character_id": String(character_id), "weapon_id": String(weapon_id),
		"game_version": str(ProjectSettings.get_setting("application/config/version", "development")),
		"loadout_rules_version": loadout_rules_version,
		"growth_snapshot": growth_snapshot.duplicate(true), "item_snapshot": item_snapshot.duplicate(true),
		"completed_at": Time.get_datetime_string_from_system(true),
	}

static func calculate(elapsed: float, nominal: float, damage: int, collected: int, total: int, defeated: int, best_combo: int) -> RunResult:
	var result := RunResult.new()
	result.time_seconds = elapsed
	result.damage_count = damage
	result.collectible_count = collected
	result.collectible_total = total
	result.kills = defeated
	result.max_combo = best_combo
	var ratio := float(collected) / float(maxi(total, 1))
	var time_bonus := roundi(1000.0 * clampf(nominal / maxf(elapsed, nominal), 0.0, 1.0))
	result.score = 1000 + time_bonus + collected * 20 + defeated * 150 + best_combo * 10 + (500 if damage == 0 else 0)
	if elapsed <= nominal + 1.0 and damage == 0 and ratio >= 0.9:
		result.rank = "S"
	elif elapsed <= nominal + 10.0 and damage <= 1 and ratio >= 0.65:
		result.rank = "A"
	elif elapsed <= nominal + 25.0 and damage <= 2 and ratio >= 0.35:
		result.rank = "B"
	else:
		result.rank = "C"
	return result
