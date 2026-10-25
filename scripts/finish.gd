class_name FinishGate
extends Area2D

signal reached
var is_boss_entrance := false
var _triggered := false

func _ready() -> void:
	collision_layer = 64
	collision_mask = 2
	var collision := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = Vector2(64, 520)
	collision.shape = shape
	add_child(collision)
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if _triggered or not body is PlayerController or not body.active:
		return
	_triggered = true
	reached.emit()

func _draw() -> void:
	var tint := Color("b24b4b") if is_boss_entrance else Color("d8b56a")
	draw_rect(Rect2(-28, -220, 56, 440), Color(tint, 0.12))
	draw_rect(Rect2(-28, -220, 56, 440), tint, false, 3)
