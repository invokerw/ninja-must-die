class_name CharacterData
extends Resource

@export var character_id: StringName = &"shadow_runner"
@export var display_name: String = "影刃"
@export_multiline var description: String = "月蚀破敌，踏影凌空。"
@export var active_skill: ActiveSkillData
@export var passive: PassiveData
@export var mobility: MobilityData
@export var unlock_id: StringName = &"starter"
@export var unlock_description: String = "默认拥有"
@export var portrait_texture: Texture2D
@export var preparation_texture: Texture2D
@export var story_name: String = "影刃"
@export var visual_tint: Color = Color.WHITE
@export var default_weapon_id: StringName = &"crescent_wheel"

func get_max_jump_count(base_count: int) -> int:
	# All characters share the same two basic jumps. A third jump is a
	# mobility action and is intentionally consumed outside this count.
	return base_count

func get_validation_errors(base_count: int) -> PackedStringArray:
	var errors := PackedStringArray()
	if character_id.is_empty() or display_name.is_empty():
		errors.append("角色必须有 ID 和名称")
	if active_skill == null:
		errors.append("角色必须配置一个主动技能")
	else:
		errors.append_array(active_skill.get_validation_errors())
	var movement := get_mobility_data()
	if movement == null:
		errors.append("角色必须配置身法或兼容的旧踏影被动")
	else:
		errors.append_array(movement.get_validation_errors())
	if character_id.is_empty() or story_name.is_empty():
		errors.append("角色故事身份不能为空")
	if base_count != 2 or get_max_jump_count(base_count) != 2:
		errors.append("共通基础跳跃须为二段")
	return errors

func get_mobility_data() -> MobilityData:
	if mobility != null:
		return mobility
	# Old character definitions can still be read. The old passive never adds
	# to the basic jump budget; its ability moves to the mobility button.
	if passive != null and passive.effect == PassiveData.Effect.EXTRA_AIR_JUMPS and passive.extra_air_jumps == 1:
		return preload("res://data/characters/mobility/third_jump.tres")
	return null
