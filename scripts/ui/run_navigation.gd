class_name RunNavigation
extends RefCounted

const SETUP_SCENE := "res://scenes/ui/character_setup.tscn"
const LEVEL_SELECT_SCENE := "res://scenes/ui/level_select.tscn"
static var _pending: RunLoadout
static var _pending_path := ""
static var _pending_level_id: StringName = &""
static var _pending_mode: StringName = &""

static func launch(tree: SceneTree, path: String, loadout: RunLoadout) -> Error:
	_pending = loadout.copy()
	_pending_path = path
	_pending_level_id = &""
	_pending_mode = &""
	tree.paused = false
	var error := tree.change_scene_to_file(path)
	if error != OK:
		_pending = null
		_pending_path = ""
		_pending_level_id = &""
		_pending_mode = &""
	return error

static func open_level_select(tree: SceneTree, loadout: RunLoadout) -> Error:
	_pending = loadout.copy()
	_pending_path = LEVEL_SELECT_SCENE
	_pending_level_id = &""
	_pending_mode = &""
	tree.paused = false
	var error := tree.change_scene_to_file(LEVEL_SELECT_SCENE)
	if error != OK:
		_pending = null
		_pending_path = ""
		_pending_level_id = &""
		_pending_mode = &""
	return error

static func launch_level(tree: SceneTree, path: String, loadout: RunLoadout, level_id: StringName) -> Error:
	_pending = loadout.copy()
	_pending_path = path
	_pending_level_id = LevelCatalog.canonicalize(level_id)
	_pending_mode = &"full" if path.ends_with("main.tscn") else &"parkour_practice"
	tree.paused = false
	var error := tree.change_scene_to_file(path)
	if error != OK:
		_pending = null
		_pending_path = ""
		_pending_level_id = &""
		_pending_mode = &""
	return error

static func take_pending(path: String) -> RunLoadout:
	if path != _pending_path:
		return null
	var result := _pending
	_pending = null
	_pending_path = ""
	return result

static func take_pending_level(path: String) -> StringName:
	if path != _pending_path:
		return &""
	var result := _pending_level_id
	_pending_level_id = &""
	return result

static func take_pending_mode(path: String) -> StringName:
	if path != _pending_path:
		return &""
	var result := _pending_mode
	_pending_mode = &""
	return result

static func return_to_setup(tree: SceneTree) -> Error:
	_pending = null
	_pending_path = ""
	_pending_level_id = &""
	_pending_mode = &""
	tree.paused = false
	return tree.change_scene_to_file(SETUP_SCENE)
