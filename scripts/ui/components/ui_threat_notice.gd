class_name UIThreatNotice
extends Control

var label: Label
var side := ""
var urgent := false
var active := false

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	label = Label.new()
	label.theme = PaintedTheme.ui_theme()
	label.position = Vector2(32, 0)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", 16)
	label.add_theme_color_override("font_shadow_color", UITokens.INK)
	label.add_theme_constant_override("shadow_offset_y", 1)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(label)
	resized.connect(_layout)

func _ready() -> void:
	_layout()

func _layout() -> void:
	label.size = Vector2(maxf(size.x - 32, 1), size.y)

func set_notice(text: String, cable_side: String, is_urgent: bool, is_active: bool = true) -> void:
	_layout()
	label.text = text
	side = cable_side
	urgent = is_urgent
	active = is_active
	label.add_theme_color_override("font_color", UITokens.TEXT_SECONDARY if not active else (UITokens.DANGER_TEXT if urgent else UITokens.ACCENT_LIGHT))
	queue_redraw()

func _draw() -> void:
	var tint := UITokens.DANGER_TEXT if urgent else UITokens.ACCENT
	var c := Vector2(12, 14)
	if not active:
		draw_line(c + Vector2(-5, 0), c + Vector2(5, 0), UITokens.TEXT_SECONDARY, 1.5, true)
	elif side in ["top", "bottom"]:
		var sign_y := -1 if side == "top" else 1
		draw_polyline(PackedVector2Array([c + Vector2(-7, -5 * sign_y), c + Vector2(0, 5 * sign_y), c + Vector2(7, -5 * sign_y)]), tint, 2, true)
	else:
		draw_polyline(PackedVector2Array([c + Vector2(4, -7), c + Vector2(-4, 0), c + Vector2(4, 7)]), tint, 2, true)
