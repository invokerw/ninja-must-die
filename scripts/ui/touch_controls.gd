class_name TouchControls
extends Control

signal pause_requested

const ACTIONS: Array[StringName] = [&"jump_only", &"rope_flip", &"dash", &"weapon", &"skill", &"pause"]
static var preview_enabled := false

var player: PlayerController
var combat: RunnerCombat
var enabled := false
var blocked := false
var finished := false
var safe_area_override := Rect2()
var _fingers: Dictionary = {}
var _rects: Dictionary = {}
var _labels: Dictionary = {}
var _styles: Dictionary = {}
var _safe := Rect2()

static func is_requested() -> bool:
	return preview_enabled or OS.has_feature("mobile") or DisplayServer.is_touchscreen_available() or OS.get_cmdline_user_args().has("--touch-controls")

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	for entry in [["normal", "192536", "d8b56a"], ["pressed", "34495e", "f0c36d"], ["disabled", "111827", "526372"]]:
		var style := StyleBoxFlat.new()
		style.bg_color = Color(Color(entry[1]), 0.88)
		style.border_color = Color(Color(entry[2]), 0.85)
		style.set_border_width_all(2)
		style.set_corner_radius_all(18)
		_styles[entry[0]] = style
	for action in ACTIONS:
		var label := Label.new()
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		label.add_theme_font_size_override("font_size", 18)
		add_child(label)
		_labels[action] = label
	player.stopped.connect(release_all)
	get_viewport().size_changed.connect(_layout)
	_layout()
	sync_state()

func sync_state() -> void:
	visible = enabled
	if not enabled:
		release_all()
		return
	if not _can_play():
		release_all()
	var safe := safe_area_override if safe_area_override.has_area() else ScreenLayout.safe_rect(get_viewport())
	if safe != _safe:
		_layout()
	for action in ACTIONS:
		var label := _labels[action] as Label
		label.visible = enabled and (not finished if action == &"pause" else _can_play())
		label.text = get_button_text(action)
		label.modulate = Color("dde7e7") if _is_available(action) else Color("91a1ad")
	queue_redraw()

func _can_play() -> bool:
	return is_instance_valid(player) and player.active and not get_tree().paused and not blocked and not finished

func _is_available(action: StringName) -> bool:
	if action == &"pause":
		return not finished
	if not _can_play():
		return false
	match action:
		&"jump_only": return not player.on_rope or player.rope_side == PlayerController.ROPE_TOP
		&"skill": return combat.is_skill_ready()
		&"weapon": return combat.is_weapon_ready()
		&"dash": return player.dash_cooldown <= 0.00001
	return true

func get_button_text(action: StringName) -> String:
	match action:
		&"jump_only": return "跳跃"
		&"rope_flip": return ("下翻" if player.rope_side == PlayerController.ROPE_TOP else "上翻") if player.on_rope else "快速下落"
		&"dash": return "影步\n%.1fs" % player.dash_cooldown if player.dash_cooldown > 0.00001 else "影步\n就绪"
		&"skill": return "%s\n%.1fs" % [player.character.active_skill.display_name, combat.skill_cooldown_remaining] if combat.skill_cooldown_remaining > 0.00001 else "%s\n就绪" % player.character.active_skill.display_name
		&"weapon":
			var state := "就绪" if combat.is_weapon_ready() else ("%.1fs" % combat.weapon.cooldown_remaining if combat.weapon.cooldown_remaining > 0.00001 else "首领战启用")
			return "%s\n%s" % [combat.weapon.data.display_name, state]
		&"pause": return "继续" if get_tree().paused else "暂停"
	return ""

func _layout() -> void:
	# Button bounds are in viewport coordinates, independent of the scrolling camera.
	_safe = safe_area_override if safe_area_override.has_area() else ScreenLayout.safe_rect(get_viewport())
	var factor := minf(_safe.size.x / 1280.0, _safe.size.y / 720.0)
	var side := 96.0 * factor
	var gap := 16.0 * factor
	var lower_body := get_viewport().get_canvas_transform() * Vector2(player.global_position.x, player.rope_y + player.rope_offset + 30.0)
	var y := maxf(_safe.end.y - side - gap, lower_body.y + 8.0)
	side = minf(side, _safe.end.y - y)
	for index in range(2):
		_rects[ACTIONS[index]] = Rect2(_safe.position.x + 24.0 * factor + float(index) * (side + gap), y, side, side)
	for index in range(3):
		_rects[ACTIONS[index + 2]] = Rect2(_safe.end.x - 24.0 * factor - float(3 - index) * side - float(2 - index) * gap, y, side, side)
	var frame := ScreenLayout.fit_frame(_safe)
	_rects[&"pause"] = Rect2(frame.position + Vector2(744, 24) * factor, Vector2(108, 52) * factor)
	for action in _labels:
		var label := _labels[action] as Label
		label.position = _rects[action].position
		label.size = _rects[action].size
		label.add_theme_font_size_override("font_size", maxi(roundi(18.0 * factor), 14))
	# Resizing cancels old coordinates rather than moving a held button under a finger.
	release_all()

func get_action_rect(action: StringName) -> Rect2:
	return _rects.get(action, Rect2())

func _input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed and not event.canceled:
			if _press_finger(event.index, event.position):
				get_viewport().set_input_as_handled()
		elif _release_finger(event.index):
			get_viewport().set_input_as_handled()
	elif event is InputEventScreenDrag:
		_drag_finger(event.index, event.position)
	elif event is InputEventMouseButton and event.device != InputEvent.DEVICE_ID_EMULATION and event.button_index == MOUSE_BUTTON_LEFT:
		var handled := _press_finger(-1, event.position) if event.pressed else _release_finger(-1)
		if handled:
			get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion and event.device != InputEvent.DEVICE_ID_EMULATION:
		_drag_finger(-1, event.position)

func _press_finger(index: int, point: Vector2) -> bool:
	if not enabled or _fingers.has(index):
		return false
	for action in ACTIONS:
		if not get_action_rect(action).has_point(point) or (action != &"pause" and not _can_play()) or (action == &"pause" and finished):
			continue
		_fingers[index] = action if _is_available(action) else &""
		if not _is_available(action):
			return true
		if action == &"pause":
			release_all()
			pause_requested.emit()
		else:
			player.run_input.press_touch(action)
		return true
	return false

func _release_finger(index: int) -> bool:
	if not _fingers.has(index):
		return false
	var action: StringName = _fingers[index]
	_fingers.erase(index)
	if not _fingers.values().has(action):
		player.run_input.release_touch(action)
	return true

func _drag_finger(index: int, point: Vector2) -> void:
	if not _fingers.has(index):
		return
	var action: StringName = _fingers[index]
	if not get_action_rect(action).has_point(point):
		_release_finger(index)
		_fingers[index] = &""

func release_all() -> void:
	_fingers.clear()
	if is_instance_valid(player):
		player.run_input.clear_touch()

func _notification(what: int) -> void:
	if what in [NOTIFICATION_APPLICATION_FOCUS_OUT, NOTIFICATION_WM_WINDOW_FOCUS_OUT, NOTIFICATION_APPLICATION_PAUSED, NOTIFICATION_PAUSED]:
		release_all()

func _exit_tree() -> void:
	release_all()

func _draw() -> void:
	for action in ACTIONS:
		if (action == &"pause" and finished) or (action != &"pause" and not _can_play()):
			continue
		var style := "disabled" if not _is_available(action) else ("pressed" if _fingers.values().has(action) else "normal")
		draw_style_box(_styles[style], get_action_rect(action))
