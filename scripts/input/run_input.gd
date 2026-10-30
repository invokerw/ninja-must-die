class_name RunInput
extends RefCounted

const TOUCH_ONLY_ACTIONS: Array[StringName] = [&"jump_only", &"rope_flip"]
const KEYBOARD_ACTIONS: Array[StringName] = [&"jump", &"drop", &"mobility", &"dash", &"weapon", &"skill"]

# Touch belongs to one run. Releasing it must never release a held keyboard key.
var _held: Dictionary = {}
var _pressed_tick: Dictionary = {}
var _released_tick: Dictionary = {}
var _blocked_keyboard: Dictionary = {}

var mobility_just_pressed: bool:
	get: return is_action_just_pressed(&"mobility")
var mobility_pressed: bool:
	get: return is_action_pressed(&"mobility")
var mobility_just_released: bool:
	get: return is_action_just_released(&"mobility")

func press_touch(action: StringName) -> void:
	action = _canonical(action)
	if _held.has(action) or (not TOUCH_ONLY_ACTIONS.has(action) and not InputMap.has_action(action)):
		return
	_held[action] = true
	_pressed_tick[action] = Engine.get_physics_frames() + 1

func release_touch(action: StringName) -> void:
	action = _canonical(action)
	if _held.erase(action):
		_released_tick[action] = Engine.get_physics_frames() + 1

func clear_touch() -> void:
	_held.clear()
	_pressed_tick.clear()
	_released_tick.clear()

func clear_all() -> void:
	clear_touch()
	# Freeze held keyboard actions locally until release, without releasing
	# global Input state owned by another control or menu.
	for action in KEYBOARD_ACTIONS:
		if InputMap.has_action(action) and Input.is_action_pressed(action):
			_blocked_keyboard[action] = true

func cancel_action(action: StringName) -> void:
	_held.erase(_canonical(action))
	_pressed_tick.erase(_canonical(action))
	_released_tick.erase(_canonical(action))
	for alias in _aliases(action):
		if InputMap.has_action(alias) and Input.is_action_pressed(alias):
			_blocked_keyboard[alias] = true

func is_action_pressed(action: StringName) -> bool:
	if _held.has(_canonical(action)):
		return true
	for alias in _aliases(action):
		if _keyboard_available(alias) and Input.is_action_pressed(alias):
			return true
	return false

func is_action_just_pressed(action: StringName) -> bool:
	# Preserve even a press/release between ticks until the next gameplay tick.
	if int(_pressed_tick.get(_canonical(action), -1)) == Engine.get_physics_frames():
		return true
	for alias in _aliases(action):
		if _keyboard_available(alias) and Input.is_action_just_pressed(alias):
			return true
	return false

func is_action_just_released(action: StringName) -> bool:
	if int(_released_tick.get(_canonical(action), -1)) == Engine.get_physics_frames() and not is_action_pressed(action):
		return true
	for alias in _aliases(action):
		if InputMap.has_action(alias) and Input.is_action_just_released(alias) and not is_action_pressed(action):
			return true
	return false

func _keyboard_available(action: StringName) -> bool:
	if not InputMap.has_action(action):
		return false
	if _blocked_keyboard.has(action):
		if Input.is_action_pressed(action):
			return false
		_blocked_keyboard.erase(action)
	return true

func _canonical(action: StringName) -> StringName:
	return &"mobility" if action == &"dash" else action

func _aliases(action: StringName) -> Array[StringName]:
	return [&"mobility", &"dash"] if _canonical(action) == &"mobility" else [action]
