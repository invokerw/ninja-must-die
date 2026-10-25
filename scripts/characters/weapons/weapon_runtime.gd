class_name WeaponRuntime
extends RefCounted

signal shot_requested

var data: WeaponData
var cooldown_remaining := 0.0
var shots_remaining := 0
var next_shot_remaining := 0.0
var casts := 0

func _init(weapon: WeaponData) -> void:
	data = weapon

func tick(delta: float) -> void:
	cooldown_remaining = maxf(cooldown_remaining - delta, 0.0)
	if shots_remaining <= 0:
		return
	next_shot_remaining -= delta
	_emit_due_shots()

func try_cast() -> bool:
	if cooldown_remaining > 0.00001 or shots_remaining > 0:
		return false
	casts += 1
	cooldown_remaining = data.skill.cooldown_seconds
	shots_remaining = data.skill.projectile_count
	next_shot_remaining = data.skill.cast_delay_seconds
	_emit_due_shots()
	return true

func _emit_due_shots() -> void:
	while shots_remaining > 0 and next_shot_remaining <= 0.00001:
		shots_remaining -= 1
		next_shot_remaining += data.skill.shot_interval
		shot_requested.emit()

func cancel() -> void:
	shots_remaining = 0
	next_shot_remaining = 0.0
