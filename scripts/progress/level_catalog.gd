class_name LevelCatalog
extends RefCounted

const FOG_RIDGE_ID := &"chapter_01_01_fog_ridge"
const WIND_BAMBOO_ID := &"chapter_01_02_wind_bamboo"
const LEGACY_ALIASES := {&"fog_ridge_60s": FOG_RIDGE_ID}

const LEVELS := [
	{
		"level_id": FOG_RIDGE_ID,
		"legacy_level_id": &"fog_ridge_60s",
		"chapter_id": &"chapter_01",
		"order": 1,
		"title": "雾岭断桥",
		"description": "穿过雾岭断桥，熟悉上下钢索、机关和远程来袭。",
		"data_path": "res://data/levels/fog_ridge_60s.tres",
		"formal_scene": "res://scenes/main.tscn",
		"practice_scene": "res://scenes/practice.tscn",
		"boss_data_path": "res://data/enemies/bridge_kite.tres",
		"story_id": &"chapter_01_01_fog_ridge",
		"collectible_total": 50,
		"star_rule_version": 1,
		"first_clear_reward_id": &"chapter_01_01_clear",
		"requires": [],
	},
	{
		"level_id": WIND_BAMBOO_ID,
		"legacy_level_id": &"",
		"chapter_id": &"chapter_01",
		"order": 2,
		"title": "风竹渡",
		"description": "竹影随风落下，先观察预警，再切换到安全侧。",
		"data_path": "res://data/levels/wind_bamboo_85s.tres",
		"formal_scene": "res://scenes/main.tscn",
		"practice_scene": "res://scenes/practice.tscn",
		"boss_data_path": "",
		"story_id": &"chapter_01_02_wind_bamboo",
		"collectible_total": 50,
		"star_rule_version": 1,
		"first_clear_reward_id": &"chapter_01_02_clear",
		"requires": [FOG_RIDGE_ID],
	},
]

static func list_levels(chapter_id: StringName = &"") -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for entry: Dictionary in LEVELS:
		if chapter_id.is_empty() or entry.chapter_id == chapter_id:
			result.append(entry.duplicate(true))
	return result

static func get_level(level_id: StringName) -> Dictionary:
	var canonical := canonicalize(level_id)
	for entry: Dictionary in LEVELS:
		if entry.level_id == canonical:
			return entry.duplicate(true)
	return {}

static func canonicalize(level_id: StringName) -> StringName:
	return LEGACY_ALIASES.get(level_id, level_id) as StringName

static func is_unlocked(level_id: StringName, completed_level_ids: Array[StringName]) -> bool:
	var entry := get_level(level_id)
	if entry.is_empty():
		return false
	for requirement: StringName in entry.requires:
		var satisfied := false
		for completed in completed_level_ids:
			if canonicalize(completed) == requirement:
				satisfied = true
				break
		if not satisfied:
			return false
	return true

static func get_data(level_id: StringName) -> RopeLevelData:
	var entry := get_level(level_id)
	if entry.is_empty():
		return null
	return load(entry.data_path) as RopeLevelData
