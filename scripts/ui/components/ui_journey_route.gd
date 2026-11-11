class_name UIJourneyRoute
extends Control

signal level_selected(id: StringName)

var entries: Array[Dictionary] = []
var buttons: Dictionary = {}
var lantern_texture: Texture2D

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	resized.connect(_layout)

func set_entries(values: Array[Dictionary]) -> void:
	entries = values.duplicate(true)
	for id: StringName in buttons.keys():
		if not entries.any(func(entry: Dictionary) -> bool: return entry.level_id == id):
			buttons[id].queue_free()
			buttons.erase(id)
	for entry: Dictionary in entries:
		if not buttons.has(entry.level_id):
			var node := UIActionButton.new()
			node.variant = &"quiet"
			var artwork := TextureRect.new()
			artwork.name = "Artwork"
			artwork.position = Vector2(19, 0)
			artwork.size = Vector2(34, 96)
			artwork.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
			artwork.mouse_filter = Control.MOUSE_FILTER_IGNORE
			node.add_child(artwork)
			var caption := Label.new()
			caption.name = "Caption"
			caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			caption.position = Vector2(0, 92)
			caption.size = Vector2(72, 28)
			caption.mouse_filter = Control.MOUSE_FILTER_IGNORE
			node.add_child(caption)
			node.pressed.connect(func() -> void: level_selected.emit(entry.level_id))
			add_child(node)
			buttons[entry.level_id] = node
		var button: Button = buttons[entry.level_id]
		var artwork := button.get_node("Artwork") as TextureRect
		artwork.texture = lantern_texture
		artwork.visible = lantern_texture != null
		artwork.modulate = Color.WHITE if entry.unlocked else UITokens.DISABLED
		button.get_node("Caption").text = "%02d" % entry.order
		button.tooltip_text = "%s · %s" % [entry.title, "已解锁" if entry.unlocked else "未解锁"]
	_layout()

func _point(index: int) -> Vector2:
	var ratio := float(index) / maxf(1, entries.size() - 1)
	return Vector2(size.x * lerpf(0.30, 0.70, ratio), size.y * lerpf(0.72, 0.26, ratio))

func _layout() -> void:
	for index in range(entries.size()):
		var button: Button = buttons[entries[index].level_id]
		button.position = _point(index) - Vector2(36, 48)
		button.size = Vector2(72, 120)
	queue_redraw()

func _draw() -> void:
	for index in range(1, entries.size()):
		var start := _point(index - 1)
		var finish := _point(index)
		var path := PackedVector2Array()
		for step in range(25):
			var ratio := step / 24.0
			path.append(start.lerp(finish, ratio) + Vector2(sin(ratio * TAU) * 18, 0))
		draw_polyline(path, UITokens.INK, 8, true)
		draw_polyline(path, UITokens.ACCENT if entries[index].unlocked else UITokens.BORDER_NEUTRAL, 2, true)
	for index in range(entries.size()):
		var entry := entries[index]
		var point := _point(index)
		var tint := UITokens.ACCENT if entry.unlocked else UITokens.TEXT_SECONDARY
		if entry.selected:
			draw_arc(point, 37, 0, TAU, 48, UITokens.ACCENT_LIGHT, 2, true)
		if entry.completed:
			draw_circle(point + Vector2(27, 28), 4, UITokens.ACCENT_LIGHT)
		if lantern_texture != null:
			continue
		draw_circle(point, 28, UITokens.INK)
		draw_arc(point, 28, 0, TAU, 32, tint, 1.5, true)
		# Lantern roof, handle and foot keep the route distinct from a progress bar.
		draw_line(point + Vector2(0, -44), point + Vector2(0, -34), tint, 2, true)
		draw_polyline(PackedVector2Array([point + Vector2(-22, -30), point + Vector2(0, -36), point + Vector2(22, -30)]), tint, 2, true)
		draw_line(point + Vector2(-18, 32), point + Vector2(18, 32), tint, 2, true)
