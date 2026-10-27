extends TouchControls

const CandidateSkin := preload("res://scripts/art/candidate_touch_skin.gd")
var skin := CandidateSkin.new()
var _counters: Dictionary = {}
var _status_kinds: Dictionary = {}
var _status_styles: Dictionary = {}

func _ready() -> void:
	_setup_status_styles()
	for action in ACTIONS:
		if action == &"pause":
			continue
		var counter := Label.new()
		counter.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		counter.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		counter.mouse_filter = Control.MOUSE_FILTER_IGNORE
		counter.add_theme_color_override("font_shadow_color", Color("111827"))
		counter.add_theme_constant_override("shadow_offset_x", 0)
		counter.add_theme_constant_override("shadow_offset_y", 1)
		counter.add_theme_color_override("font_outline_color", Color("101a29"))
		counter.add_theme_constant_override("outline_size", 1)
		counter.add_theme_color_override("font_color", Color("f5ead0"))
		counter.z_index = 1
		add_child(counter)
		_counters[action] = counter
	super._ready()

func _setup_status_styles() -> void:
	var boss := StyleBoxFlat.new()
	boss.bg_color = Color("101a29", 0.94)
	boss.border_color = Color("d8b56a", 0.65)
	boss.set_border_width_all(1)
	boss.set_corner_radius_all(5)
	_status_styles[&"boss"] = boss
	var disabled := StyleBoxFlat.new()
	disabled.bg_color = Color("101a29", 0.94)
	disabled.border_color = Color("a99b7a", 0.5)
	disabled.set_border_width_all(1)
	disabled.set_corner_radius_all(5)
	_status_styles[&"disabled"] = disabled

func _layout() -> void:
	super._layout()
	for action in _counters:
		var rect := get_action_rect(action)
		var caption: Label = _labels[action]
		caption.position = rect.position + Vector2(0, rect.size.y * 0.97)
		caption.size = Vector2(rect.size.x, rect.size.y * 0.16)
		caption.position.y = minf(caption.position.y, _safe.end.y - caption.size.y - 2.0)
		caption.add_theme_font_size_override("font_size", maxi(10, roundi(rect.size.x * 0.13)))
		caption.add_theme_color_override("font_shadow_color", Color("111827"))
		caption.add_theme_constant_override("shadow_offset_y", 1)
		var counter: Label = _counters[action]
		counter.position = rect.position
		# Status and cooldown text share the circle's center, not a shortened top area.
		counter.size = rect.size

func visual_state(action: StringName) -> Dictionary:
	var remaining := 0.0
	var duration := 1.0
	match action:
		&"dash":
			remaining = player.dash_cooldown
			duration = player.tuning.dash_duration + player.tuning.dash_recovery
		&"weapon":
			remaining = combat.weapon.cooldown_remaining
			duration = combat.weapon.data.skill.cooldown_seconds
		&"skill":
			remaining = combat.skill_cooldown_remaining
			duration = player.character.active_skill.cooldown_seconds
	return {"available": _is_available(action), "pressed": _fingers.values().has(action), "remaining": remaining, "cooldown": clampf(remaining / duration, 0, 1), "weapon_id": combat.weapon.data.weapon_id, "rope_mode": ("down" if player.rope_side == PlayerController.ROPE_TOP else "up") if player.on_rope else "fall"}

func sync_state() -> void:
	super.sync_state()
	for action in _counters:
		var label: Label = _labels[action]
		var counter: Label = _counters[action]
		counter.visible = label.visible
		if not label.visible:
			continue
		var state := visual_state(action)
		match action:
			&"dash": label.text = "影步"
			&"weapon": label.text = combat.weapon.data.display_name
			&"skill": label.text = player.character.active_skill.display_name
		counter.text = ""
		_status_kinds[action] = &""
		if state["remaining"] > 0.00001:
			counter.text = "%.1f" % maxf(0.1, state["remaining"])
		elif not state["available"]:
			if action == &"weapon":
				counter.text = "首领战"
				_status_kinds[action] = &"boss"
			else:
				counter.text = "禁用"
				_status_kinds[action] = &"disabled"
		var status: StringName = _status_kinds[action]
		counter.add_theme_font_size_override("font_size", roundi(get_action_rect(action).size.x * (0.18 if status != &"" else 0.23)))
		counter.add_theme_color_override("font_color", Color("f5ead0") if status == &"boss" else (Color("d7cfbd") if status == &"disabled" else Color("edf1f3")))

func _draw() -> void:
	for action in ACTIONS:
		if (action == &"pause" and finished) or (action != &"pause" and not _can_play()):
			continue
		if action == &"pause":
			draw_style_box(_styles["normal"], get_action_rect(action))
		else:
			skin.draw_button(self, action, get_action_rect(action), visual_state(action))
		var status: StringName = _status_kinds.get(action, &"")
		if status != &"":
			var rect := get_action_rect(action)
			var badge_size := rect.size * Vector2(0.78 if status == &"boss" else 0.62, 0.30)
			var badge := Rect2(rect.get_center() - badge_size * 0.5, badge_size)
			draw_style_box(_status_styles[status], badge)
