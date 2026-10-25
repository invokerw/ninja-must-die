class_name WeaponSkillData
extends Resource

@export_enum("volley", "lance") var effect_id := "volley"
@export var cooldown_seconds := 6.0
@export var cast_delay_seconds := 0.0
@export var projectile_count := 3
@export var shot_interval := 0.12
@export var boss_damage := 4
@export var projectile_speed := 1300.0
@export var turn_speed := 6.0
@export var projectile_lifetime := 2.0

func get_validation_errors() -> PackedStringArray:
	var errors := PackedStringArray()
	if effect_id not in ["volley", "lance"] or projectile_count < 1 or projectile_count > 8:
		errors.append("武器发射配置无效")
	for value in [cooldown_seconds, cast_delay_seconds, shot_interval, projectile_speed, turn_speed, projectile_lifetime]:
		if not is_finite(value) or value < 0.0:
			errors.append("武器参数必须是有限非负数")
	if cooldown_seconds <= cast_delay_seconds + shot_interval * (projectile_count - 1) or projectile_speed <= 0.0 or projectile_lifetime <= 0.0 or boss_damage <= 0 or boss_damage % 2 != 0:
		errors.append("武器冷却、伤害或弹体配置无效")
	return errors
