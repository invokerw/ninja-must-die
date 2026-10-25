class_name RunLoadout
extends RefCounted

var character: CharacterData
var weapon: WeaponData

static func capture(character_data: CharacterData, weapon_data: WeaponData) -> RunLoadout:
	var result := RunLoadout.new()
	result.character = character_data.duplicate(true)
	result.weapon = weapon_data.duplicate(true)
	return result

func copy() -> RunLoadout:
	return capture(character, weapon)
