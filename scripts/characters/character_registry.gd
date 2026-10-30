class_name CharacterRegistry
extends RefCounted

const CHARACTERS := {
	&"shadow_runner": preload("res://data/characters/shadow_runner.tres"),
	&"wind_scout": preload("res://data/characters/wind_scout.tres"),
	&"thunder_guard": preload("res://data/characters/thunder_guard.tres"),
}

static func get_character(character_id: StringName) -> CharacterData:
	return CHARACTERS.get(character_id) as CharacterData
