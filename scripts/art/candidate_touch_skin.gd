extends RefCounted

const ROOT := "res://art/layered/ui_touch_v02_candidate/"
var actions: Dictionary
var textures: Dictionary = {}

func _init() -> void:
	var manifest: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(ROOT + "manifest.json"))
	actions = manifest["actions"]
	for action: String in actions:
		for role: String in ["plate", "icon"]:
			textures[action + "_" + role] = load(ROOT + actions[action][role]["path"])

func geometry(action: StringName, bounds: Rect2, pressed: bool = false) -> Dictionary:
	var plate: Dictionary = actions[String(action)]["plate"]
	var icon: Dictionary = actions[String(action)]["icon"]
	var native := Vector2(plate["width"], plate["height"])
	var factor := minf(1.0, minf(bounds.size.x / native.x, bounds.size.y / native.y))
	if pressed:
		factor *= 0.96
	var origin := bounds.get_center() - native * factor * 0.5
	if pressed:
		origin.y += bounds.size.y * 0.015
	var offset := Vector2(icon["bbox"][0] - plate["bbox"][0], icon["bbox"][1] - plate["bbox"][1])
	return {"plate": Rect2(origin, native * factor), "icon": Rect2(origin + offset * factor, Vector2(icon["width"], icon["height"]) * factor)}

func draw_button(canvas: CanvasItem, action: StringName, bounds: Rect2, state: Dictionary) -> void:
	var pressed: bool = state["pressed"] and state["available"]
	var shapes := geometry(action, bounds, pressed)
	var tint := Color.WHITE if state["available"] else Color(0.46, 0.50, 0.56, 0.76)
	if pressed:
		tint = Color(1.08, 1.02, 0.86)
	canvas.draw_texture_rect(textures[String(action) + "_plate"], shapes["plate"], false, tint)
	if action == &"weapon" and state["weapon_id"] == &"star_lance":
		# Preserve the existing spear identity until matching raster art is produced.
		WeaponArt.draw_icon(canvas, &"star_lance", bounds.get_center(), bounds.size.x * 0.22)
	else:
		canvas.draw_texture_rect(textures[String(action) + "_icon"], shapes["icon"], false, tint)
	var radius := bounds.size.x * 0.36
	if not state["available"] and state["cooldown"] <= 0.0:
		canvas.draw_circle(bounds.get_center(), radius * 0.84, Color(0.04, 0.07, 0.11, 0.45))
	if state["cooldown"] > 0.0:
		canvas.draw_circle(bounds.get_center(), radius * 0.84, Color(0.04, 0.07, 0.11, 0.72))
		canvas.draw_arc(bounds.get_center(), radius, -PI * 0.5, -PI * 0.5 + TAU * state["cooldown"], 48, Color("d8b56a"), maxf(bounds.size.x * 0.027, 1.0), true)
	if action == &"rope_flip" and state["available"]:
		var downward: bool = state["rope_mode"] != "up"
		var center := bounds.position + Vector2(bounds.size.x * 0.84, bounds.size.y * 0.49)
		var direction := 1.0 if downward else -1.0
		_draw_chevron(canvas, center, bounds.size.x * 0.045, direction)
		if state["rope_mode"] == "fall":
			_draw_chevron(canvas, center + Vector2(0, bounds.size.y * 0.075), bounds.size.x * 0.045, direction)

func _draw_chevron(canvas: CanvasItem, center: Vector2, radius: float, direction: float) -> void:
	canvas.draw_polyline(PackedVector2Array([center + Vector2(-radius, -radius * direction), center + Vector2(0, radius * direction), center + Vector2(radius, -radius * direction)]), Color("f4d791"), 2.0, true)
