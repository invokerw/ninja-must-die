class_name EnergyPickup
extends Area2D

var _collected := false

func _ready() -> void:
	collision_layer = 32
	collision_mask = 2
	var collision := CollisionShape2D.new()
	var shape := CircleShape2D.new()
	shape.radius = 18.0
	collision.shape = shape
	add_child(collision)
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if _collected or not body is PlayerController or not body.active:
		return
	_collected = true
	body.collect_energy()
	queue_free()

func _draw() -> void:
	draw_colored_polygon(PackedVector2Array([
		Vector2(0, -13), Vector2(10, 0), Vector2(0, 13), Vector2(-10, 0)
	]), Color("d8b56a"))
