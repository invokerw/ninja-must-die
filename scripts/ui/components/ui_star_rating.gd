class_name UIStarRating
extends Control

var stars := 0:
	set(value):
		stars = clampi(value, 0, 3)
		queue_redraw()

func _init() -> void:
	custom_minimum_size = Vector2(156, 44)
	mouse_filter = Control.MOUSE_FILTER_IGNORE

func _draw() -> void:
	for index in range(3):
		var center := Vector2(22 + index * 54, size.y * 0.5)
		var points := PackedVector2Array()
		for vertex in range(10):
			var angle := -PI * 0.5 + vertex * PI / 5
			points.append(center + Vector2.from_angle(angle) * (18 if vertex % 2 == 0 else 8))
		if index < stars:
			draw_colored_polygon(points, UITokens.ACCENT)
		points.append(points[0])
		draw_polyline(points, UITokens.ACCENT if index < stars else UITokens.BORDER_NEUTRAL, 2, true)
