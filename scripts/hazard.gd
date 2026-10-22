class_name Hazard
extends Area2D

@export var hazard_size := Vector2(48.0, 44.0)

func _ready() -> void:
	collision_layer = 16
	collision_mask = 2
	var collision := CollisionPolygon2D.new()
	collision.polygon = PackedVector2Array([
		Vector2(-hazard_size.x * 0.5, 0), Vector2(0, -hazard_size.y),
		Vector2(hazard_size.x * 0.5, 0)
	])
	add_child(collision)
	queue_redraw()

func _physics_process(_delta: float) -> void:
	# Recheck overlap so immunity ending inside a hazard is not a permanent bypass.
	for body in get_overlapping_bodies():
		if body is PlayerController:
			body.take_damage()

func _draw() -> void:
	draw_colored_polygon(PackedVector2Array([
		Vector2(-hazard_size.x * 0.5, 0), Vector2(0, -hazard_size.y),
		Vector2(hazard_size.x * 0.5, 0)
	]), Color("b24b4b"))
