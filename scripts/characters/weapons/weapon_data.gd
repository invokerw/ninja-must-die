class_name WeaponData
extends Resource

@export var weapon_id: StringName = &"crescent_wheel"
@export var display_name := "弦月轮"
@export_multiline var description := "三枚弦月刃波连续追击。"
@export var allowed_character_ids: Array[StringName] = []
@export var skill: WeaponSkillData

func allows(character_id: StringName) -> bool:
	return allowed_character_ids.is_empty() or allowed_character_ids.has(character_id)

func get_validation_errors() -> PackedStringArray:
	var errors := PackedStringArray()
	if weapon_id.is_empty() or display_name.is_empty() or skill == null:
		errors.append("武器必须有 ID、名称和技能")
	if skill != null:
		errors.append_array(skill.get_validation_errors())
	return errors
