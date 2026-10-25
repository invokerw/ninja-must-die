class_name RopeSentry
extends Area2D

@export_enum("top", "bottom") var cable_side := "top"
@export var max_health := 1
@export var warning_distance := 420.0

var health := 1
var alive := true
var _death_remaining := 0.20
var _warning_active := false
var _phase := 0.0
var _player: PlayerController

func bind_player(player: PlayerController) -> void:
	_player = player

func _ready() -> void:
	health = max_health
	collision_layer = 4
	collision_mask = 2
	var collision := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = Vector2(36.0, 36.0)
	collision.shape = shape
	add_child(collision)
	add_to_group("enemies")

func _physics_process(delta: float) -> void:
	_phase += delta
	if not alive:
		_death_remaining -= delta
		modulate.a = clampf(_death_remaining / 0.20, 0.0, 1.0)
		if _death_remaining <= 0.0:
			queue_free()
		queue_redraw()
		return
	if not is_instance_valid(_player):
		_player = get_tree().get_first_node_in_group("player") as PlayerController
	var was_warning := _warning_active
	_warning_active = false
	if is_instance_valid(_player) and _player.active:
		var distance := global_position.x - _player.global_position.x
		_warning_active = distance >= -36.0 and distance <= warning_distance
	if _warning_active and not was_warning:
		_player.emit_feedback(&"warning_top" if cable_side == "top" else &"warning_bottom", global_position)
	for body in get_overlapping_bodies():
		if body is PlayerController:
			body.take_damage()
	queue_redraw()

func take_hit(amount: int) -> bool:
	if not alive:
		return false
	health = maxi(health - amount, 0)
	if health > 0:
		return false
	alive = false
	if is_instance_valid(_player):
		_player.emit_feedback(&"kill", global_position)
	set_deferred("monitoring", false)
	set_deferred("monitorable", false)
	return true

func _draw() -> void:
	# Temporary sentry silhouette, using the shared ink-night/cinnabar/gold palette.
	var rise := sin(_phase * 4.0) * 2.0
	draw_set_transform(Vector2(0.0, rise))
	draw_colored_polygon(PackedVector2Array([Vector2(-30, -14), Vector2(-12, -8), Vector2(0, -22), Vector2(12, -8), Vector2(30, -14), Vector2(18, 14), Vector2(0, 22), Vector2(-18, 14)]), Color("b24b4b"))
	draw_circle(Vector2.ZERO, 13.0, Color("233142"))
	draw_line(Vector2(-8, 0), Vector2(8, 0), Color("d8b56a"), 5.0)
	draw_set_transform(Vector2.ZERO)
	if _warning_active and alive:
		var pulse := 0.6 + 0.4 * sin(_phase * 8.0)
		draw_arc(Vector2.ZERO, 30.0, 0.0, TAU, 24, Color(0.85, 0.71, 0.42, pulse), 2.0)
