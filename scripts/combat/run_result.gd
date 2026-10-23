class_name RunResult
extends RefCounted

var time_seconds: float
var damage_count: int
var collectible_count: int
var collectible_total: int
var kills: int
var max_combo: int
var score: int
var rank: String

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
