class_name ActiveSkillData
extends Resource

@export var skill_id: StringName = &"moon_slash"
@export var display_name: String = "月蚀斩"
@export var cooldown_seconds: float = 12.0
@export var invulnerability_seconds: float = 2.0
@export var cast_delay_seconds: float = 0.12
@export var forward_range: float = 640.0
@export var half_height: float = 100.0
@export var damage: int = 3
@export var boss_damage: int = 24
@export var pattern: StringName = &"single"
@export var strike_count: int = 1
@export var strike_interval_seconds: float = 0.12
@export var projectile_speed: float = 1400.0
@export var projectile_turn_speed: float = 6.0
@export var projectile_lifetime: float = 1.2

func description() -> String:
	if pattern == &"volley":
		return "%d 枚羽刃分批飞行，每枚 %d 普通 / %d 首领基础伤害" % [strike_count, damage, boss_damage]
	if pattern == &"double":
		return "%d 次前方雷刃，间隔 %.2f 秒，每次 %d 普通 / %d 首领基础伤害" % [strike_count, strike_interval_seconds, damage, boss_damage]
	return "前方 %d 普通 / %d 首领基础伤害" % [damage, boss_damage]

func get_validation_errors() -> PackedStringArray:
	var errors := PackedStringArray()
	if not [&"moon_slash", &"wind_feather", &"thunder_rift"].has(skill_id) or display_name.is_empty():
		errors.append("技能必须使用已注册的忍术 ID")
	if not [&"single", &"volley", &"double"].has(pattern) or strike_count <= 0 or strike_count > 16:
		errors.append("技能攻击模式无效")
	if (pattern == &"single" and strike_count != 1) or not is_finite(strike_interval_seconds) or strike_interval_seconds <= 0.0:
		errors.append("攻击段数 / 间隔无效")
	if not is_finite(projectile_speed) or projectile_speed <= 0.0 or not is_finite(projectile_turn_speed) or projectile_turn_speed < 0.0 or not is_finite(projectile_lifetime) or projectile_lifetime <= 0.0:
		errors.append("忍术弹体参数必须有限且有效")
	if is_finite(strike_interval_seconds) and cast_delay_seconds + (strike_count - 1) * strike_interval_seconds >= invulnerability_seconds:
		errors.append("所有出手必须在保护结束前完成")
	if not is_finite(cooldown_seconds) or not is_finite(invulnerability_seconds) or invulnerability_seconds <= 0.0 or cooldown_seconds <= invulnerability_seconds:
		errors.append("技能冷却必须大于正数无敌时长")
	if not is_finite(cast_delay_seconds) or cast_delay_seconds < 0.0 or cast_delay_seconds >= invulnerability_seconds:
		errors.append("出招延迟必须非负且小于无敌时长")
	if damage <= 0 or boss_damage <= 0 or boss_damage % 2 != 0 or not is_finite(forward_range) or not is_finite(half_height) or forward_range <= 0.0 or half_height <= 0.0:
		errors.append("技能伤害和范围必须为正")
	return errors
