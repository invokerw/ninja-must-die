class_name FinishGate
extends Area2D

signal reached
var _triggered := false

func _ready() -> void:
	collision_layer = 64
	collision_mask = 2
	var collision := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = Vector2(64, 360)
	collision.position.y = -160
	collision.shape = shape
	add_child(collision)
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if _triggered or not body is PlayerController or not body.active:
		return
	_triggered = true
	reached.emit()

func _draw() -> void:
	draw_rect(Rect2(-28, -220, 56, 220), Color(0.85, 0.71, 0.42, 0.12))
	draw_rect(Rect2(-28, -220, 56, 220), Color("d8b56a"), false, 3)
