class_name PaintedTheme
extends RefCounted

const PORTRAIT := preload("res://art/generated/ui/portrait.png")
const FONT := preload("res://fonts/NotoSansCJKsc-Regular.otf")

static func ui_theme() -> Theme:
	var theme := Theme.new()
	theme.default_font = FONT
	theme.default_font_size = UITokens.FONT_SIZES[&"body"]
	theme.set_color("font_color", "Label", UITokens.TEXT_PRIMARY)
	for state in [&"normal", &"hover", &"pressed", &"disabled", &"focus"]:
		theme.set_stylebox(state, "Button", button_style(&"secondary", state))
	for state in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		theme.set_color(state, "Button", UITokens.TEXT_PRIMARY)
	theme.set_color("font_disabled_color", "Button", UITokens.DISABLED)
	theme.set_stylebox("panel", "Panel", surface_style())
	theme.set_stylebox("panel", "PanelContainer", surface_style())
	theme.set_constant("separation", "VBoxContainer", 12)
	theme.set_constant("separation", "HBoxContainer", 12)
	return theme

static func apply_font(control: Control) -> void:
	control.theme = ui_theme()

static func surface_style(accent: bool = false, inset: bool = false) -> StyleBoxFlat:
	var style := flat_style(UITokens.INK if inset else UITokens.SURFACE, UITokens.ACCENT if accent else UITokens.BORDER_NEUTRAL)
	style.set_content_margin_all(UITokens.PANEL_PADDING)
	return style

static func flat_style(fill: Color, border: Color, width: int = 1) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(width)
	style.set_corner_radius_all(UITokens.CORNER_RADIUS)
	style.set_content_margin_all(12)
	return style

static func button_style(variant: StringName, state: StringName) -> StyleBoxFlat:
	if state == &"focus":
		var focus := flat_style(Color.TRANSPARENT, UITokens.ACCENT_LIGHT, 2)
		focus.draw_center = false
		focus.set_expand_margin_all(3)
		return focus
	var fill := UITokens.SURFACE
	var border := UITokens.ACCENT
	if variant == &"primary":
		fill = UITokens.ACCENT
	elif variant == &"danger":
		fill = UITokens.DANGER
		border = UITokens.DANGER
	elif variant == &"quiet":
		fill = Color.TRANSPARENT
		border = Color.TRANSPARENT
	if state == &"hover":
		fill = UITokens.ACCENT_LIGHT if variant == &"primary" else (UITokens.DANGER.lightened(0.12) if variant == &"danger" else UITokens.SURFACE_RAISED)
	elif state == &"pressed":
		fill = UITokens.ACCENT.darkened(0.15) if variant == &"primary" else (UITokens.DANGER.darkened(0.15) if variant == &"danger" else UITokens.SURFACE_RAISED)
	elif state == &"disabled":
		fill = UITokens.INK
		border = UITokens.BORDER_NEUTRAL
	var style := flat_style(fill, border, 0 if variant == &"quiet" and state != &"disabled" else 1)
	style.content_margin_left = 16
	style.content_margin_right = 16
	style.content_margin_top = 8
	style.content_margin_bottom = 8
	return style

static func style_button(button: Button, variant: StringName = &"secondary") -> void:
	for state in [&"normal", &"hover", &"pressed", &"disabled", &"focus"]:
		button.add_theme_stylebox_override(state, button_style(variant, state))
	var text_color := UITokens.INK if variant == &"primary" else UITokens.TEXT_PRIMARY
	for state in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		button.add_theme_color_override(state, text_color)
	button.add_theme_color_override("font_disabled_color", UITokens.DISABLED)
	button.set_meta("ui_variant", variant)

static func decorate_panel(panel: Control) -> void:
	if panel is ColorRect:
		panel.color.a = 0.0
	var existing := panel.get_node_or_null("PaintedPanel")
	if existing != null:
		return
	var art := Panel.new()
	art.name = "PaintedPanel"
	art.add_theme_stylebox_override("panel", surface_style())
	art.mouse_filter = Control.MOUSE_FILTER_IGNORE
	art.show_behind_parent = true
	panel.add_child(art)
	art.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

static func portrait(parent: Control, rect: Rect2) -> TextureRect:
	var art := TextureRect.new()
	art.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	art.texture = PORTRAIT
	art.position = rect.position
	art.size = rect.size
	art.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	art.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(art)
	return art
