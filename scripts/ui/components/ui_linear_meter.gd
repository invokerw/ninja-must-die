class_name UILinearMeter
extends Control

var fill: ColorRect
var ratio := 0.0
var tint := UITokens.ACCENT

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	fill = ColorRect.new()
	fill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(fill)
	resized.connect(_layout)

func set_value(value: float, maximum: float, color: Color = UITokens.ACCENT) -> void:
	ratio = clampf(value / maximum, 0.0, 1.0) if is_finite(value) and is_finite(maximum) and maximum > 0 else 0.0
	tint = color
	_layout()

func _layout() -> void:
	fill.position = Vector2.ZERO
	fill.size = Vector2(size.x * ratio, size.y)
	fill.color = tint
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color(UITokens.INK, 0.85))
	draw_rect(Rect2(Vector2.ZERO, size), UITokens.BORDER_NEUTRAL, false, 1)
