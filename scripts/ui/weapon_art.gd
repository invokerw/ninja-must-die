class_name WeaponArt
extends RefCounted

static func draw_icon(canvas: CanvasItem, id: StringName, center: Vector2, radius: float) -> void:
	if id == &"star_lance":
		canvas.draw_line(center + Vector2(-radius, radius), center + Vector2(radius * 0.6, -radius * 0.6), Color("d8b56a"), maxf(radius * 0.18, 1.0))
		canvas.draw_colored_polygon(PackedVector2Array([center + Vector2(radius, -radius), center + Vector2(radius * 0.8, 0), center, center + Vector2(0, -radius * 0.8)]), Color("dde7e7"))
	else:
		canvas.draw_arc(center, radius, -1.8, 1.8, 24, Color("d8b56a"), maxf(radius * 0.22, 1.0))
		canvas.draw_arc(center + Vector2(-radius * 0.2, 0), radius * 0.64, -1.6, 1.6, 20, Color("dde7e7"), maxf(radius * 0.13, 1.0))
