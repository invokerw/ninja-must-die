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

func get_validation_errors() -> PackedStringArray:
	var errors := PackedStringArray()
	if skill_id != &"moon_slash" or display_name.is_empty():
		errors.append("当前仅支持具名的月蚀斩技能")
	if not is_finite(cooldown_seconds) or not is_finite(invulnerability_seconds) or invulnerability_seconds <= 0.0 or cooldown_seconds <= invulnerability_seconds:
		errors.append("技能冷却必须大于正数无敌时长")
	if not is_finite(cast_delay_seconds) or cast_delay_seconds < 0.0 or cast_delay_seconds >= invulnerability_seconds:
		errors.append("出招延迟必须非负且小于无敌时长")
	if damage <= 0 or boss_damage <= 0 or boss_damage % 2 != 0 or not is_finite(forward_range) or not is_finite(half_height) or forward_range <= 0.0 or half_height <= 0.0:
		errors.append("技能伤害和范围必须为正")
	return errors
