class_name Hazard
extends Area2D

@export var hazard_size := Vector2(48.0, 56.0)
@export_enum("top", "bottom") var cable_side := "top"

func _ready() -> void:
	collision_layer = 16
	collision_mask = 2
	var collision := CollisionPolygon2D.new()
	var direction := -1.0 if cable_side == "top" else 1.0
	collision.polygon = PackedVector2Array([
		Vector2(-hazard_size.x * 0.5, 0), Vector2(0, hazard_size.y * direction),
		Vector2(hazard_size.x * 0.5, 0)
	])
	add_child(collision)
	queue_redraw()

func _physics_process(_delta: float) -> void:
	for body in get_overlapping_bodies():
		if body is PlayerController:
			body.take_damage()

func _draw() -> void:
	var direction := -1.0 if cable_side == "top" else 1.0
	draw_colored_polygon(PackedVector2Array([
		Vector2(-hazard_size.x * 0.5, 0), Vector2(0, hazard_size.y * direction),
		Vector2(hazard_size.x * 0.5, 0)
	]), Color("b24b4b"))
	draw_line(Vector2(-hazard_size.x * 0.5, 0), Vector2(hazard_size.x * 0.5, 0), Color("d8b56a"), 3.0)
