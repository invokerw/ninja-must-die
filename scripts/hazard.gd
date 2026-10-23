class_name Hazard
extends Area2D

@export var hazard_size := Vector2(48.0, 56.0)
@export_enum("top", "bottom") var cable_side := "top"
@export var warning_distance := 420.0

var _warning_phase := 0.0
var _warning_active := false
var _player: PlayerController

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

func _process(delta: float) -> void:
	_warning_phase += delta
	if not is_instance_valid(_player):
		_player = get_tree().get_first_node_in_group("player") as PlayerController
	var was_active := _warning_active
	_warning_active = false
	if is_instance_valid(_player) and _player.active:
		var distance := global_position.x - _player.global_position.x
		_warning_active = distance > -48.0 and distance <= warning_distance
	if was_active != _warning_active:
		queue_redraw()
	elif _warning_active:
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
	if _warning_active:
		var pulse := 0.5 + 0.5 * sin(_warning_phase * 9.0)
		var warning_color := Color(0.95, 0.72, 0.36, 0.35 + pulse * 0.55)
		var marker_y := direction * maxf(42.0, hazard_size.y * 0.62)
		var marker_x := -72.0
		draw_line(Vector2(marker_x - 18.0, marker_y), Vector2(marker_x - 4.0, marker_y - direction * 12.0), warning_color, 4.0)
		draw_line(Vector2(marker_x - 4.0, marker_y - direction * 12.0), Vector2(marker_x + 10.0, marker_y), warning_color, 4.0)
		draw_arc(Vector2(0, direction * minf(hazard_size.y * 0.5, 48.0)), 24.0 + pulse * 4.0, 0.0, TAU, 20, Color(0.95, 0.72, 0.36, 0.18 + pulse * 0.24), 3.0)
