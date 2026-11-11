class_name ProgressRail
extends Control

var markers: Array[float] = [0.25, 0.50, 0.75, 1.0]:
	set(value):
		if markers != value:
			markers = value.duplicate()
			queue_redraw()
var progress := 0.0:
	set(value):
		var next := clampf(value, 0, 1)
		if not is_equal_approx(next, progress):
			progress = next
			queue_redraw()

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE

func _draw() -> void:
	var start := Vector2(7, size.y * 0.5)
	var end := Vector2(size.x - 7, start.y)
	draw_line(start + Vector2(0, 1), end + Vector2(0, 1), Color(UITokens.INK, 0.7), 3.0, true)
	draw_line(start, end, UITokens.BORDER_NEUTRAL, 2.0, true)
	if progress > 0:
		draw_line(start, start.lerp(end, progress), UITokens.ACCENT, 2.0, true)
	# Each checkpoint is drawn once; no extracted rail bitmap carries hidden nodes.
	for checkpoint: float in markers:
		var center := start.lerp(end, checkpoint)
		draw_circle(center, 4.5, UITokens.INK)
		draw_circle(center, 3.5, UITokens.ACCENT if progress >= checkpoint else UITokens.BORDER_NEUTRAL)
		draw_circle(center, 1.8, UITokens.ACCENT_LIGHT if progress >= checkpoint else UITokens.SURFACE)
