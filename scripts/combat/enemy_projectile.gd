class_name EnemyProjectile
extends Node2D

const DART := preload("res://art/generated/combat/enemy_dart_v01.png")

const RADIUS := 8.0

var target: PlayerController
var velocity := Vector2(-360.0, 0.0)
var lifetime_remaining := 10.0
var spent := false
var contact_resolved := false
var cable_side := ""
var _shape := CircleShape2D.new()
var _target_shape: CollisionShape2D

func _ready() -> void:
	# Run after player input/movement, including same-frame skill and dash protection.
	process_physics_priority = 10
	_shape.radius = RADIUS
	add_to_group("enemy_projectiles")
	if is_instance_valid(target):
		_target_shape = target.get_node("CollisionShape2D") as CollisionShape2D
		target.stopped.connect(_expire)

func _physics_process(delta: float) -> void:
	if spent:
		return
	if not is_instance_valid(target) or not target.active:
		_expire()
		return
	lifetime_remaining -= delta
	if lifetime_remaining <= 0.0:
		_expire()
		return
	var motion := velocity * delta
	var player_motion := target.global_position - target.previous_physics_position
	# Rope flips are instantaneous side changes; airborne movement is continuous.
	if target.on_rope:
		player_motion.y = 0.0
	var player_start := _target_shape.global_transform
	player_start.origin -= player_motion
	# Test both moving shapes directly; the physics space may still hold an earlier pose.
	if not contact_resolved and _shape.collide_with_motion(global_transform, motion - player_motion, _target_shape.shape, player_start, Vector2.ZERO):
		# Resolve once, including protected contact, and let the bullet keep its full path.
		contact_resolved = true
		target.take_damage()
	global_position += motion
	var screen := get_global_transform_with_canvas().origin
	var bounds := get_viewport().get_visible_rect().grow(96.0)
	if screen.x < bounds.position.x or (screen.y < bounds.position.y and velocity.y < 0.0) or (screen.y > bounds.end.y and velocity.y > 0.0):
		_expire()
	queue_redraw()

func _expire() -> void:
	if spent:
		return
	spent = true
	hide()
	queue_free()

func cancel() -> void:
	_expire()

func _draw() -> void:
	draw_set_transform(Vector2.ZERO, velocity.angle() - PI)
	draw_line(Vector2(5, 0), Vector2(32, 0), Color(0.70, 0.29, 0.29, 0.55), 6.0)
	draw_texture_rect(DART, Rect2(-16, -16, 32, 32), false)
