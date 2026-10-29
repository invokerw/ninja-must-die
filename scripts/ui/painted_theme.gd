class_name PaintedTheme
extends RefCounted

const PANEL := preload("res://art/generated/ui/panel.png")
const PORTRAIT := preload("res://art/generated/ui/portrait.png")
const FONT := preload("res://fonts/NotoSansCJKsc-Regular.otf")

static func ui_theme() -> Theme:
	var theme := Theme.new()
	theme.default_font = FONT
	return theme

static func apply_font(control: Control) -> void:
	control.theme = ui_theme()

static func panel_style(tint: Color = Color.WHITE) -> StyleBoxTexture:
	var style := StyleBoxTexture.new()
	style.texture = PANEL
	style.region_rect = Rect2(6, 6, 334, 63)
	style.texture_margin_left = 12
	style.texture_margin_right = 36
	style.texture_margin_top = 8
	style.texture_margin_bottom = 10
	style.content_margin_left = 12
	style.content_margin_right = 18
	style.content_margin_top = 5
	style.content_margin_bottom = 5
	style.modulate_color = tint
	return style

static func style_button(button: Button) -> void:
	button.add_theme_stylebox_override("normal", panel_style())
	button.add_theme_stylebox_override("hover", panel_style(Color(1.2, 1.15, 1.0)))
	button.add_theme_stylebox_override("pressed", panel_style(Color(0.7, 0.78, 0.9)))
	button.add_theme_stylebox_override("disabled", panel_style(Color(0.55, 0.58, 0.65)))
	button.add_theme_color_override("font_color", Color("e8e1d0"))
	button.add_theme_color_override("font_hover_color", Color("fff1c5"))
	button.add_theme_color_override("font_pressed_color", Color("d8b56a"))

static func decorate_panel(panel: Control) -> void:
	if panel is ColorRect:
		panel.color.a = 0.0
	var art := NinePatchRect.new()
	art.name = "PaintedPanel"
	art.texture = PANEL
	art.region_rect = Rect2(6, 6, 334, 63)
	art.patch_margin_left = 12
	art.patch_margin_right = 36
	art.patch_margin_top = 8
	art.patch_margin_bottom = 10
	art.mouse_filter = Control.MOUSE_FILTER_IGNORE
	art.show_behind_parent = true
	panel.add_child(art)
	art.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

static func portrait(parent: Control, rect: Rect2) -> TextureRect:
	var art := TextureRect.new()
	art.texture = PORTRAIT
	art.position = rect.position
	art.size = rect.size
	art.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	art.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	art.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(art)
	return art
