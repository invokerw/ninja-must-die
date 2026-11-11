class_name UICombatAction
extends Control

var caption: Label
var counter: Label
var key_hint: Label
var radial: UIRadialMeter
var state: Dictionary = {}
var legacy_art := false

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	theme = PaintedTheme.ui_theme()
	for role in range(3):
		var label := Label.new()
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		label.add_theme_color_override("font_shadow_color", UITokens.INK)
		label.add_theme_constant_override("shadow_offset_y", 1)
		add_child(label)
		if role == 0:
			caption = label
		elif role == 1:
			counter = label
		else:
			key_hint = label
	radial = UIRadialMeter.new()
	add_child(radial)
	resized.connect(_layout)

func set_state(value: Dictionary, keyboard: bool = false) -> void:
	state = value
	# Optional parenthesized development descriptors stay in the tooltip/pause
	# description rather than crowding the compact action name.
	caption.text = String(state.get("title", "")).get_slice("（", 0)
	tooltip_text = state.get("title", "")
	counter.text = state.get("status", "")
	key_hint.text = state.get("key", "") if keyboard else ""
	var color := UITokens.TEXT_PRIMARY if state.get("available", false) else UITokens.TEXT_SECONDARY
	caption.add_theme_color_override("font_color", color)
	counter.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT if state.get("available", false) else UITokens.TEXT_PRIMARY)
	radial.visible = not legacy_art
	radial.set_value(state.get("meter_value", 0.0), state.get("meter_max", 1.0), state.get("quota", false))
	_layout()
	queue_redraw()

func _layout() -> void:
	var factor := size.x / 96.0
	caption.position = Vector2(0, size.y)
	caption.size = Vector2(size.x, 23 * factor)
	counter.position = Vector2(0, size.y * 0.59)
	counter.size = Vector2(size.x, size.y * 0.30)
	key_hint.position = Vector2(0, size.y * 0.04)
	key_hint.size = Vector2(size.x, 18 * factor)
	caption.add_theme_font_size_override("font_size", maxi(12, roundi(16 * factor)))
	counter.add_theme_font_size_override("font_size", maxi(12, roundi(15 * factor)))
	key_hint.add_theme_font_size_override("font_size", maxi(12, roundi(13 * factor)))
	key_hint.add_theme_color_override("font_color", UITokens.TEXT_SECONDARY)
	radial.size = size

func _draw() -> void:
	if state.is_empty() or legacy_art:
		return
	var available: bool = state.get("available", false)
	var center := size * 0.5
	var radius := size.x * 0.43
	var tint := UITokens.ACCENT if available else UITokens.BORDER_NEUTRAL
	var pressed: bool = state.get("pressed", false) and available
	draw_circle(center, radius, Color(UITokens.SURFACE_RAISED if pressed else UITokens.INK, 0.93))
	draw_arc(center, radius, 0, TAU, 64, UITokens.ACCENT_LIGHT if pressed else tint, 2, true)
	var glyph_center := Vector2(center.x, size.y * 0.39)
	var r := size.x * 0.15
	var ink := UITokens.TEXT_PRIMARY if available else UITokens.TEXT_SECONDARY
	match StringName(state.get("glyph", &"jump")):
		&"weapon":
			var texture: Texture2D = state.get("texture")
			if texture != null:
				var region: Rect2 = state.get("texture_region", Rect2(Vector2.ZERO, texture.get_size()))
				if region.has_area():
					var slot := size * Vector2(0.68, 0.44)
					var fitted := region.size * minf(slot.x / region.size.x, slot.y / region.size.y)
					draw_texture_rect_region(texture, Rect2(glyph_center - fitted * 0.5, fitted), region)
		&"skill":
			draw_arc(glyph_center, r, PI * 0.20, PI * 1.65, 28, ink, 4, true)
			draw_line(glyph_center + Vector2(-r, r * 0.55), glyph_center + Vector2(r, -r * 0.55), ink, 2, true)
		&"glide":
			for offset in [-6, 2, 10]:
				draw_arc(glyph_center + Vector2(-4, offset), r * 0.75, -PI * 0.8, 0, 16, ink, 2, true)
		&"burst":
			draw_polyline(PackedVector2Array([glyph_center + Vector2(5, -r), glyph_center + Vector2(-8, 2), glyph_center + Vector2(4, 2), glyph_center + Vector2(-5, r)]), ink, 3, true)
		&"flip":
			var direction := -1.0 if state.get("rope_mode", "down") == "up" else 1.0
			_chevron(glyph_center, r * 0.65, direction, ink)
			if state.get("rope_mode") == "fall":
				_chevron(glyph_center + Vector2(0, 10), r * 0.65, direction, ink)
		&"pause":
			draw_line(glyph_center + Vector2(-5, -r * 0.6), glyph_center + Vector2(-5, r * 0.6), ink, 3, true)
			draw_line(glyph_center + Vector2(5, -r * 0.6), glyph_center + Vector2(5, r * 0.6), ink, 3, true)
		_:
			_chevron(glyph_center, r * 0.7, -1, ink)
			if state.get("glyph") == &"third_jump":
				_chevron(glyph_center + Vector2(0, 10), r * 0.7, -1, ink)

func _chevron(center: Vector2, radius: float, direction: float, tint: Color) -> void:
	draw_polyline(PackedVector2Array([center + Vector2(-radius, -radius * direction), center + Vector2(0, radius * direction), center + Vector2(radius, -radius * direction)]), tint, 2, true)
