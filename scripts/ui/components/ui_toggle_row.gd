class_name UIToggleRow
extends Button

func _init() -> void:
	theme = PaintedTheme.ui_theme()
	toggle_mode = true
	alignment = HORIZONTAL_ALIGNMENT_LEFT
	custom_minimum_size = Vector2(200, 48)
	add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"secondary"])
	PaintedTheme.style_button(self, &"quiet")
	for state in [&"normal", &"hover", &"pressed", &"disabled"]:
		var style := PaintedTheme.button_style(&"quiet", state)
		style.content_margin_right = 80
		add_theme_stylebox_override(state, style)

func _draw() -> void:
	var bounds := Rect2(size.x - 64, (size.y - 24) * 0.5, 48, 24)
	var fill := UITokens.ACCENT if button_pressed else UITokens.BORDER_NEUTRAL
	if disabled:
		fill = UITokens.DISABLED.darkened(0.4)
	var style := PaintedTheme.flat_style(fill, fill)
	style.set_corner_radius_all(12)
	draw_style_box(style, bounds)
	var center := bounds.position + Vector2(36 if button_pressed else 12, 12)
	draw_circle(center, 8, UITokens.INK if button_pressed else UITokens.TEXT_PRIMARY)
