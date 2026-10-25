class_name CharacterLoadout
extends RefCounted

var character_id: StringName
var weapon_id: StringName

func _init(character: StringName = &"shadow_runner", weapon: StringName = &"crescent_wheel") -> void:
	character_id = character
	weapon_id = weapon
