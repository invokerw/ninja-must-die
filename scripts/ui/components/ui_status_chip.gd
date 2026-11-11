class_name UIStatusChip
extends Label

const CAPTIONS := {
	&"selected": "已选中", &"owned": "已拥有", &"equipped": "已装备",
	&"carried": "携带中", &"locked": "未解锁", &"pending": "待保存",
	&"saved": "已保存", &"readonly": "当前只读", &"error": "保存失败",
	&"preview": "预览中",
	&"used": "已触发",
	&"empty": "未携带",
}

var status: StringName = &"selected"
var _icon_color := UITokens.ACCENT

func _init() -> void:
	theme = PaintedTheme.ui_theme()
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	custom_minimum_size.y = 32
	add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"caption"])
	set_status(&"selected")

func set_status(value: StringName, caption: String = "") -> void:
	status = value if CAPTIONS.has(value) else &"selected"
	text = caption if not caption.is_empty() else CAPTIONS[status]
	_icon_color = UITokens.DANGER_TEXT if status == &"error" else (UITokens.TEXT_SECONDARY if status in [&"locked", &"readonly", &"empty"] else UITokens.ACCENT)
	var style := PaintedTheme.flat_style(UITokens.INK, _icon_color)
	style.set_content_margin_all(6)
	style.content_margin_left = 32
	style.content_margin_right = 12
	add_theme_stylebox_override("normal", style)
	add_theme_color_override("font_color", _icon_color)
	queue_redraw()

func _draw() -> void:
	var center := Vector2(16, size.y * 0.5)
	if status == &"empty":
		draw_line(center + Vector2(-5, 0), center + Vector2(5, 0), _icon_color, 1.5, true)
	elif status in [&"pending", &"error"]:
		draw_polyline(PackedVector2Array([center + Vector2(0, -7), center + Vector2(7, 6), center + Vector2(-7, 6), center + Vector2(0, -7)]), _icon_color, 1.5, true)
		draw_line(center + Vector2(0, -3), center + Vector2(0, 1), _icon_color, 1.5, true)
		draw_circle(center + Vector2(0, 3.5), 0.8, _icon_color)
	elif status in [&"locked", &"readonly"]:
		draw_arc(center + Vector2(0, -2), 4, PI, TAU, 12, _icon_color, 1.5, true)
		draw_rect(Rect2(center + Vector2(-5, -2), Vector2(10, 8)), _icon_color, false, 1.5)
	elif status == &"preview":
		draw_arc(center, 6, 0, TAU, 16, _icon_color, 1.5, true)
		draw_circle(center, 2, _icon_color)
	elif status == &"selected":
		draw_polyline(PackedVector2Array([center + Vector2(0, -7), center + Vector2(6, 0), center + Vector2(0, 7), center + Vector2(-6, 0), center + Vector2(0, -7)]), _icon_color, 1.5, true)
	else:
		draw_polyline(PackedVector2Array([center + Vector2(-6, 0), center + Vector2(-1, 5), center + Vector2(7, -5)]), _icon_color, 2, true)
