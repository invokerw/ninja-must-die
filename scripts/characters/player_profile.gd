class_name PlayerProfile
extends RefCounted

signal equipment_changed(character_id: StringName, weapon_id: StringName)
signal save_status_changed
signal settings_changed

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
var load_notice := ""
var history := RunHistory.new()
var feedback_settings := FeedbackSettings.defaults()
var _document: Dictionary = {}

static func current() -> PlayerProfile:
	if _shared == null:
		_shared = PlayerProfile.new()
		_shared.load_profile()
		FeedbackSettings.apply(_shared.feedback_settings)
	return _shared

func _init(path: String = "user://save.json") -> void:
	save_path = path

func load_profile() -> void:
	var loaded := ProfileStore.read(save_path)
	_document = loaded.document
	load_notice = loaded.notice
	save_pending = false
	last_error = ""
	selected_character_id = &"shadow_runner"
	owned_weapon_ids = STARTER_WEAPONS.duplicate()
	character_loadouts.clear()
	history.load_records(_document.get("run_records", {}))
	feedback_settings = FeedbackSettings.defaults()
	var settings: Variant = _document.get("settings", {})
	if settings is Dictionary:
		for key in feedback_settings:
			if settings.get(key, null) is bool:
				feedback_settings[key] = settings[key]
	if ProfileStore.is_newer(_document):
		load_notice = "存档来自较新版本，本次更改仅在本次运行中生效。"
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
		var record: Variant = character_loadouts.get(String(data.character_id), {})
		if not record is Dictionary:
			record = {}
		record["weapon_id"] = String(get_equipped_weapon(data).weapon_id)
		character_loadouts[String(data.character_id)] = record

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
	var loadout := CharacterLoadout.new(character.character_id, weapon_id)
	var record: Variant = character_loadouts.get(String(loadout.character_id), {})
	if not record is Dictionary:
		record = {}
	record["weapon_id"] = String(loadout.weapon_id)
	character_loadouts[String(loadout.character_id)] = record
	save_pending = true
	equipment_changed.emit(loadout.character_id, loadout.weapon_id)
	return true

func resolve(character: CharacterData = null) -> RunLoadout:
	if character == null:
		character = CHARACTERS[selected_character_id]
	return RunLoadout.capture(character, get_equipped_weapon(character))

func save_profile() -> bool:
	last_error = ""
	if ProfileStore.is_newer(_document):
		last_error = "存档版本较新，本次更改暂未保存。"
		save_status_changed.emit()
		return false
	var document := _document.duplicate(true)
	document["version"] = 1
	document["selected_character_id"] = String(selected_character_id)
	document["owned_weapon_ids"] = owned_weapon_ids.map(func(id: StringName) -> String: return String(id))
	document["character_loadouts"] = character_loadouts.duplicate(true)
	document["run_records"] = history.to_dictionary()
	var settings: Variant = document.get("settings", {})
	if not settings is Dictionary:
		settings = {}
	for key in feedback_settings:
		settings[key] = feedback_settings[key]
	document["settings"] = settings
	if not ProfileStore.write(save_path, document):
		last_error = "本次更改已生效，暂未保存。"
		save_status_changed.emit()
		return false
	_document = document
	save_pending = false
	load_notice = ""
	save_status_changed.emit()
	return true

func set_feedback_setting(key: String, enabled: bool) -> bool:
	if not feedback_settings.has(key):
		return false
	feedback_settings[key] = enabled
	FeedbackSettings.apply(feedback_settings)
	save_pending = true
	settings_changed.emit()
	return save_profile()

func record_completion(level_id: StringName, mode: StringName, result: RunResult) -> bool:
	if not history.record_completion(level_id, mode, result):
		return false
	save_pending = true
	return save_profile()
