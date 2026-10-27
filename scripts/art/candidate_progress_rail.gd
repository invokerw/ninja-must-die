extends Control

const MARKERS := [0.25, 0.50, 0.75, 1.0]
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
	draw_line(start, end, Color("111827"), 6.0, true)
	draw_line(start, end, Color("6e7f8d"), 2.0, true)
	if progress > 0:
		draw_line(start, start.lerp(end, progress), Color("d8b56a"), 2.0, true)
	# Each checkpoint is drawn once; no extracted rail bitmap carries hidden nodes.
	for checkpoint: float in MARKERS:
		var center := start.lerp(end, checkpoint)
		draw_circle(center, 6.0, Color("111827"))
		draw_circle(center, 4.5, Color("d8b56a") if progress >= checkpoint else Color("6e7f8d"))
		draw_circle(center, 2.5, Color("f4d791") if progress >= checkpoint else Color("34495e"))
