class_name RunNavigation
extends RefCounted

const SETUP_SCENE := "res://scenes/ui/character_setup.tscn"
static var _pending: RunLoadout
static var _pending_path := ""

static func launch(tree: SceneTree, path: String, loadout: RunLoadout) -> Error:
	_pending = loadout.copy()
	_pending_path = path
	tree.paused = false
	var error := tree.change_scene_to_file(path)
	if error != OK:
		_pending = null
		_pending_path = ""
	return error

static func take_pending(path: String) -> RunLoadout:
	if path != _pending_path:
		return null
	var result := _pending
	_pending = null
	_pending_path = ""
	return result

static func return_to_setup(tree: SceneTree) -> Error:
	_pending = null
	_pending_path = ""
	tree.paused = false
	return tree.change_scene_to_file(SETUP_SCENE)
