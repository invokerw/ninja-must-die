class_name CharacterData
extends Resource

@export var character_id: StringName = &"shadow_runner"
@export var display_name: String = "影刃"
@export_multiline var description: String = "月蚀破敌，踏影凌空。"
@export var active_skill: ActiveSkillData
@export var passive: PassiveData

func get_max_jump_count(base_count: int) -> int:
	return base_count + (passive.extra_air_jumps if passive != null else 0)

func get_validation_errors(base_count: int) -> PackedStringArray:
	var errors := PackedStringArray()
	if character_id.is_empty() or display_name.is_empty():
		errors.append("角色必须有 ID 和名称")
	if active_skill == null:
		errors.append("角色必须配置一个主动技能")
	else:
		errors.append_array(active_skill.get_validation_errors())
	if passive == null:
		errors.append("角色必须配置一个被动能力")
	elif passive.passive_id.is_empty() or passive.display_name.is_empty() or passive.effect != PassiveData.Effect.EXTRA_AIR_JUMPS or passive.extra_air_jumps < 0 or passive.extra_air_jumps > 1:
		errors.append("被动能力配置无效")
	if base_count != 2 or get_max_jump_count(base_count) not in [2, 3]:
		errors.append("基础跳跃须为二段，有效跳跃只允许二段或三段")
	return errors
