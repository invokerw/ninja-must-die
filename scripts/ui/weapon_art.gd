class_name WeaponArt
extends RefCounted

const CRESCENT := preload("res://art/generated/combat/crescent_wheel_v01.png")
const LANCE := preload("res://art/generated/combat/star_lance_v01.png")
const SHURIKEN := preload("res://art/generated/combat/shuriken_v01.png")

static func draw_icon(canvas: CanvasItem, id: StringName, center: Vector2, radius: float) -> void:
	var texture := LANCE if id == &"star_lance" else CRESCENT
	canvas.draw_texture_rect(texture, Rect2(center - Vector2.ONE * radius, Vector2.ONE * radius * 2.0), false)
