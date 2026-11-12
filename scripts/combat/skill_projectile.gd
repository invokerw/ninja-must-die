class_name SkillProjectile
extends Node2D

signal hit(target: Area2D, attack: CombatAttack)

var player: PlayerController
var target: Area2D
var attack: CombatAttack
var speed := 1400.0
var turn_speed := 6.0
var lifetime_remaining := 1.2
var velocity := Vector2.ZERO
var spent := false
var _shape := CircleShape2D.new()
var _target_shape: CollisionShape2D
var _previous_target_position := Vector2.ZERO
var _aimed := false

func _ready() -> void:
	process_physics_priority = 15
	_shape.radius = 7.0
	_aimed = is_instance_valid(target)
	if _aimed:
		_previous_target_position = target.global_position
		if target is RopeBoss:
			_target_shape = target.hit_shape
		else:
			for child in target.get_children():
				if child is CollisionShape2D:
					_target_shape = child
					break
	velocity = (target.global_position - global_position).normalized() * speed if _aimed else Vector2(speed, 0)
	add_to_group("skill_projectiles")

func _physics_process(delta: float) -> void:
	if spent:
		return
	if not is_instance_valid(player) or not player.active:
		cancel()
		return
	lifetime_remaining -= delta
	if lifetime_remaining <= 0.0:
		cancel()
		return
	if _aimed:
		if not is_instance_valid(target) or not target.alive or (target is RopeBoss and not target.is_in_combat()) or not is_instance_valid(_target_shape):
			cancel()
			return
		var desired := (target.global_position - global_position).angle()
		velocity = Vector2.from_angle(rotate_toward(velocity.angle(), desired, turn_speed * delta)) * speed
	var motion := velocity * delta
	if _aimed:
		var target_motion := target.global_position - _previous_target_position
		var target_start := _target_shape.global_transform
		target_start.origin -= target_motion
		_previous_target_position = target.global_position
		if _shape.collide_with_motion(global_transform, motion - target_motion, _target_shape.shape, target_start, Vector2.ZERO):
			spent = true
			hit.emit(target, attack)
			hide()
			queue_free()
			return
	global_position += motion
	queue_redraw()

func cancel() -> void:
	if spent:
		return
	spent = true
	hide()
	queue_free()

func _draw() -> void:
	draw_set_transform(Vector2.ZERO, velocity.angle())
	draw_colored_polygon(PackedVector2Array([Vector2(22, 0), Vector2(-13, -7), Vector2(-5, 0), Vector2(-13, 7)]), Color(0.70, 0.90, 0.88))
	draw_line(Vector2(-8, 0), Vector2(-38, 0), Color(0.70, 0.90, 0.88, 0.3), 2.0, true)
