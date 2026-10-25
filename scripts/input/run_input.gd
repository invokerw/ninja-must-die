class_name RunInput
extends RefCounted

# Touch belongs to one run. Releasing it must never release a held keyboard key.
var _held: Dictionary = {}
var _pressed_tick: Dictionary = {}

func press_touch(action: StringName) -> void:
	if _held.has(action) or not InputMap.has_action(action):
		return
	_held[action] = true
	_pressed_tick[action] = Engine.get_physics_frames() + 1

func release_touch(action: StringName) -> void:
	_held.erase(action)

func clear_touch() -> void:
	_held.clear()
	_pressed_tick.clear()

func is_action_pressed(action: StringName) -> bool:
	return _held.has(action) or Input.is_action_pressed(action)

func is_action_just_pressed(action: StringName) -> bool:
	# Keep even a press/release between physics ticks until the next gameplay tick.
	return int(_pressed_tick.get(action, -1)) == Engine.get_physics_frames() or Input.is_action_just_pressed(action)
