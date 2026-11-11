class_name WeaponArt
extends RefCounted

const CRESCENT := preload("res://art/generated/combat/crescent_wheel_v01.png")
const LANCE := preload("res://art/generated/combat/star_lance_v01.png")
const SHURIKEN := preload("res://art/generated/combat/shuriken_v01.png")

static var _icon_regions: Dictionary = {}

static func draw_icon(canvas: CanvasItem, id: StringName, center: Vector2, radius: float) -> void:
	var texture := texture_for(id)
	canvas.draw_texture_rect(texture, Rect2(center - Vector2.ONE * radius, Vector2.ONE * radius * 2.0), false)

static func texture_for(id: StringName) -> Texture2D:
	return LANCE if id == &"star_lance" else CRESCENT

static func icon_region_for(id: StringName) -> Rect2:
	if not _icon_regions.has(id):
		_icon_regions[id] = Rect2(texture_for(id).get_image().get_used_rect())
	return _icon_regions[id]
