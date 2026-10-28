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
	draw_rect(Rect2(-26, -202, 52, 404), Color(tint, 0.06))
	for side in [-1, 1]:
		var x := float(side) * 30.0
		draw_rect(Rect2(x - 5, -202, 10, 404), Color("111827"))
		draw_line(Vector2(x, -202), Vector2(x, 202), tint, 4.0)
		draw_line(Vector2(x - 2, -202), Vector2(x - 2, 202), Color("d8b56a"), 1.0)
		for y in [-180, -120, 120, 180]:
			draw_line(Vector2(x - 6, y), Vector2(x + 6, y), Color("d8b56a"), 3.0)
	draw_colored_polygon(PackedVector2Array([Vector2(-48, -202), Vector2(0, -232), Vector2(48, -202), Vector2(32, -194), Vector2(0, -216), Vector2(-32, -194)]), tint)
	draw_arc(Vector2(0, -175), 18, 0.5, 5.0, 24, Color("d8b56a"), 3.0)
