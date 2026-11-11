class_name UIRadialMeter
extends Control

var ratio := 0.0
var quota := false

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE

func set_value(value: float, maximum: float, is_quota: bool = false) -> void:
	ratio = clampf(value / maximum, 0.0, 1.0) if is_finite(value) and is_finite(maximum) and maximum > 0 else 0.0
	quota = is_quota
	queue_redraw()

func _draw() -> void:
	if ratio <= 0:
		return
	var radius := minf(size.x, size.y) * 0.44
	var color := UITokens.ACCENT_LIGHT if quota else UITokens.ACCENT
	draw_arc(size * 0.5, radius, -PI * 0.5, -PI * 0.5 + TAU * ratio, 64, color, maxf(2, radius * 0.07), true)
	if quota:
		draw_circle(size * 0.5 + Vector2(0, -radius), 3, color)
