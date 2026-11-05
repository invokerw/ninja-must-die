class_name Hazard
extends Area2D

const SPIKE := preload("res://art/generated/obstacles/steel_spike_v01.png")

@export var hazard_size := Vector2(48.0, 56.0)
@export_enum("top", "bottom") var cable_side := "top"
@export var warning_distance := 420.0
@export_enum("spike", "falling_bamboo") var hazard_type := "spike"
@export var warning_seconds := 1.0
@export var active_seconds := 1.15
@export var exit_seconds := 0.35
@export_enum("top", "bottom") var safe_side := "bottom"

var _warning_phase := 0.0
var _warning_active := false
var _player: PlayerController
var _collision: CollisionPolygon2D
var _triggered := false
var _active := true
var _exiting := false
var _elapsed := 0.0

func _ready() -> void:
	collision_layer = 16
	collision_mask = 2
	_collision = CollisionPolygon2D.new()
	var direction := -1.0 if cable_side == "top" else 1.0
	_collision.polygon = PackedVector2Array([
		Vector2(-hazard_size.x * 0.5, 0), Vector2(0, hazard_size.y * direction),
		Vector2(hazard_size.x * 0.5, 0)
	])
	_collision.disabled = hazard_type == "falling_bamboo"
	add_child(_collision)
	queue_redraw()

func _process(delta: float) -> void:
	_warning_phase += delta
	if not is_instance_valid(_player):
		_player = get_tree().get_first_node_in_group("player") as PlayerController
	if hazard_type == "falling_bamboo":
		_process_falling_bamboo(delta)
	else:
		var was_active := _warning_active
		_warning_active = false
		if is_instance_valid(_player) and _player.active:
			var distance := global_position.x - _player.global_position.x
			_warning_active = distance > -48.0 and distance <= warning_distance
		if was_active != _warning_active:
			if _warning_active:
				_player.emit_feedback(&"warning_top" if cable_side == "top" else &"warning_bottom", global_position)
			queue_redraw()
		elif _warning_active:
			queue_redraw()
	return

func _process_falling_bamboo(delta: float) -> void:
	if not _triggered and is_instance_valid(_player) and _player.active:
		var distance := global_position.x - _player.global_position.x
		if distance > -48.0 and distance <= warning_distance:
			_triggered = true
			_elapsed = 0.0
			_warning_active = true
			_player.emit_feedback(&"warning_top" if cable_side == "top" else &"warning_bottom", global_position)
	if not _triggered:
		return
	_elapsed += delta
	if _elapsed >= warning_seconds and _elapsed < warning_seconds + active_seconds:
		_active = true
		_exiting = false
		_collision.disabled = false
	elif _elapsed < warning_seconds + active_seconds + exit_seconds:
		_active = false
		_exiting = true
		_collision.disabled = true
	else:
		_active = false
		_exiting = false
		_collision.disabled = true
		_warning_active = false
	queue_redraw()

func _physics_process(_delta: float) -> void:
	if not _active:
		return
	for body in get_overlapping_bodies():
		if body is PlayerController:
			body.take_damage()

func _draw() -> void:
	var direction := -1.0 if cable_side == "top" else 1.0
	draw_set_transform(Vector2.ZERO, 0.0, Vector2(1.0, 1.0 if cable_side == "top" else -1.0))
	if hazard_type == "falling_bamboo":
		var body_color := Color("bd8e4a") if _active else Color(0.55, 0.67, 0.54, 0.28)
		draw_rect(Rect2(-hazard_size.x * 0.5, -hazard_size.y, hazard_size.x, hazard_size.y), body_color, true)
		draw_line(Vector2(-hazard_size.x * 0.35, -hazard_size.y * 0.78), Vector2(hazard_size.x * 0.28, -hazard_size.y * 0.3), Color("e2c17c"), 4.0)
	else:
		draw_texture_rect(SPIKE, Rect2(-hazard_size.x * 0.5, -hazard_size.y, hazard_size.x, hazard_size.y), false)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	draw_line(Vector2(-hazard_size.x * 0.5, 0), Vector2(hazard_size.x * 0.5, 0), Color("d8b56a"), 3.0)
	if _warning_active or (hazard_type == "falling_bamboo" and _triggered and (_exiting or not _active)):
		var pulse := 0.5 + 0.5 * sin(_warning_phase * 9.0)
		var warning_color := Color(0.95, 0.72, 0.36, 0.35 + pulse * 0.55)
		var marker_y := direction * maxf(42.0, hazard_size.y * 0.62)
		var marker_x := -72.0
		draw_line(Vector2(marker_x - 18.0, marker_y), Vector2(marker_x - 4.0, marker_y - direction * 12.0), warning_color, 4.0)
		draw_line(Vector2(marker_x - 4.0, marker_y - direction * 12.0), Vector2(marker_x + 10.0, marker_y), warning_color, 4.0)
		draw_arc(Vector2(0, direction * minf(hazard_size.y * 0.5, 48.0)), 24.0 + pulse * 4.0, 0.0, TAU, 20, Color(0.95, 0.72, 0.36, 0.18 + pulse * 0.24), 3.0)
