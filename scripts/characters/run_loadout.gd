class_name RunLoadout
extends RefCounted

var character: CharacterData
var weapon: WeaponData
var mobility: MobilityData:
	get: return character.mobility
var rules_version := 1
var growth_snapshot: Dictionary = {}
var item_snapshot: Dictionary = {}

static func capture(character_data: CharacterData, weapon_data: WeaponData) -> RunLoadout:
	var result := RunLoadout.new()
	result.character = character_data.duplicate(true)
	result.weapon = weapon_data.duplicate(true)
	result.character.mobility = character_data.get_mobility_data().duplicate(true) if character_data.get_mobility_data() != null else null
	return result

func copy() -> RunLoadout:
	var result := capture(character, weapon)
	result.rules_version = rules_version
	result.growth_snapshot = growth_snapshot.duplicate(true)
	result.item_snapshot = item_snapshot.duplicate(true)
	return result
