class_name PlayerProfile
extends RefCounted

signal equipment_changed(character_id: StringName, weapon_id: StringName)

const STARTER_WEAPONS: Array[StringName] = [&"crescent_wheel", &"star_lance"]
const CHARACTERS := {&"shadow_runner": preload("res://data/characters/shadow_runner.tres")}
const WEAPONS := {
	&"crescent_wheel": preload("res://data/weapons/crescent_wheel.tres"),
	&"star_lance": preload("res://data/weapons/star_lance.tres"),
}
static var _shared: PlayerProfile

var selected_character_id: StringName = &"shadow_runner"
var owned_weapon_ids: Array[StringName] = STARTER_WEAPONS.duplicate()
var character_loadouts: Dictionary = {}
var save_path := "user://save.json"
var last_error := ""
var save_pending := false
var _document: Dictionary = {}

static func current() -> PlayerProfile:
	if _shared == null:
		_shared = PlayerProfile.new()
		_shared.load_profile()
	return _shared

func _init(path: String = "user://save.json") -> void:
	save_path = path

func load_profile() -> void:
	_document = {}
	save_pending = false
	last_error = ""
	selected_character_id = &"shadow_runner"
	owned_weapon_ids = STARTER_WEAPONS.duplicate()
	character_loadouts.clear()
	if FileAccess.file_exists(save_path):
		var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(save_path))
		if parsed is Dictionary:
			_document = parsed.duplicate(true)
	var owned: Variant = _document.get("owned_weapon_ids", null)
	if owned is Array:
		owned_weapon_ids.clear()
		for entry in owned:
			if entry is String and WEAPONS.has(StringName(entry)) and not owned_weapon_ids.has(StringName(entry)):
				owned_weapon_ids.append(StringName(entry))
	# Missing or entirely invalid ownership data recovers the starter set.
	if owned_weapon_ids.is_empty():
		owned_weapon_ids = STARTER_WEAPONS.duplicate()
	var saved: Variant = _document.get("character_loadouts", {})
	if saved is Dictionary:
		character_loadouts = saved.duplicate(true)
	var selected: Variant = _document.get("selected_character_id", "shadow_runner")
	if selected is String and CHARACTERS.has(StringName(selected)):
		selected_character_id = StringName(selected)
	for data: CharacterData in CHARACTERS.values():
		character_loadouts[String(data.character_id)] = {"weapon_id": String(get_equipped_weapon(data).weapon_id)}

func get_equipped_weapon(character: CharacterData) -> WeaponData:
	var entry: Variant = character_loadouts.get(String(character.character_id), {})
	var id := character.default_weapon_id
	if entry is Dictionary and entry.get("weapon_id", null) is String:
		id = StringName(entry.weapon_id)
	var weapon := WEAPONS.get(id) as WeaponData
	if weapon != null and owned_weapon_ids.has(id) and weapon.allows(character.character_id) and weapon.get_validation_errors().is_empty():
		return weapon
	weapon = WEAPONS.get(character.default_weapon_id) as WeaponData
	if weapon != null and owned_weapon_ids.has(weapon.weapon_id) and weapon.allows(character.character_id):
		return weapon
	for owned_id in owned_weapon_ids:
		weapon = WEAPONS.get(owned_id) as WeaponData
		if weapon != null and weapon.allows(character.character_id) and weapon.get_validation_errors().is_empty():
			return weapon
	for starter in STARTER_WEAPONS:
		weapon = WEAPONS[starter]
		if weapon.allows(character.character_id):
			if not owned_weapon_ids.has(starter):
				owned_weapon_ids.append(starter)
			return weapon
	return WEAPONS[&"crescent_wheel"]

func list_weapons(character: CharacterData) -> Array[WeaponData]:
	var result: Array[WeaponData] = []
	for id in owned_weapon_ids:
		var weapon := WEAPONS.get(id) as WeaponData
		if weapon != null and weapon.allows(character.character_id):
			result.append(weapon)
	return result

func try_equip(character: CharacterData, weapon_id: StringName) -> bool:
	last_error = ""
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null and not tree.get_nodes_in_group("run_sessions").is_empty():
		last_error = "本局装备已固定，请返回准备页更换。"
		return false
	var weapon := WEAPONS.get(weapon_id) as WeaponData
	if character == null or not CHARACTERS.has(character.character_id) or weapon == null or not owned_weapon_ids.has(weapon_id) or not weapon.allows(character.character_id) or not weapon.get_validation_errors().is_empty():
		last_error = "当前角色无法装备这把武器。"
		return false
	var record := CharacterLoadout.new(character.character_id, weapon_id)
	character_loadouts[String(record.character_id)] = {"weapon_id": String(record.weapon_id)}
	save_pending = true
	equipment_changed.emit(record.character_id, record.weapon_id)
	return true

func resolve(character: CharacterData = null) -> RunLoadout:
	if character == null:
		character = CHARACTERS[selected_character_id]
	return RunLoadout.capture(character, get_equipped_weapon(character))

func save_profile() -> bool:
	last_error = ""
	var version: Variant = _document.get("version", 1)
	if (version is int or version is float) and float(version) > 1.0:
		last_error = "本次已更换，存档版本较新，暂未保存。"
		return false
	var document := _document.duplicate(true)
	document["version"] = 1
	document["selected_character_id"] = String(selected_character_id)
	document["owned_weapon_ids"] = owned_weapon_ids.map(func(id: StringName) -> String: return String(id))
	document["character_loadouts"] = character_loadouts.duplicate(true)
	var temporary := save_path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		last_error = "本次已更换，暂未保存。"
		return false
	file.store_string(JSON.stringify(document, "\t"))
	file.flush()
	var write_error := file.get_error()
	file.close()
	if write_error != OK or DirAccess.rename_absolute(ProjectSettings.globalize_path(temporary), ProjectSettings.globalize_path(save_path)) != OK:
		last_error = "本次已更换，暂未保存。"
		return false
	_document = document
	save_pending = false
	return true
