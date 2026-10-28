class_name PlayerProjectile
extends Node2D

signal hit(target: RopeBoss, attack: CombatAttack)

var player: PlayerController
var target: RopeBoss
var attack: CombatAttack
var speed := 1300.0
var turn_speed := 6.0
var lifetime_remaining := 2.0
var velocity := Vector2.ZERO
var visual_kind := "volley"
var spent := false
var _shape := CircleShape2D.new()

func _ready() -> void:
	process_physics_priority = 15
	_shape.radius = 7.0
	velocity = (target.global_position - global_position).normalized() * speed
	add_to_group("player_projectiles")

func _physics_process(delta: float) -> void:
	if spent:
		return
	if not is_instance_valid(player) or not player.active or not is_instance_valid(target) or not target.is_in_combat():
		cancel()
		return
	lifetime_remaining -= delta
	if lifetime_remaining <= 0.0:
		cancel()
		return
	var desired := (target.global_position - global_position).angle()
	velocity = Vector2.from_angle(rotate_toward(velocity.angle(), desired, turn_speed * delta)) * speed
	var motion := velocity * delta
	var target_motion := target.global_position - target.previous_physics_position
	var target_start := target.hit_shape.global_transform
	target_start.origin -= target_motion
	if _shape.collide_with_motion(global_transform, motion - target_motion, target.hit_shape.shape, target_start, Vector2.ZERO):
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
	if visual_kind == "lance":
		draw_texture_rect(WeaponArt.LANCE, Rect2(-40, -40, 80, 80), false)
	elif visual_kind == "dart":
		draw_texture_rect(WeaponArt.SHURIKEN, Rect2(-13, -13, 26, 26), false)
	else:
		draw_texture_rect(WeaponArt.CRESCENT, Rect2(-21, -21, 42, 42), false)
	draw_line(Vector2(-16, 0), Vector2(-55, 0), Color(0.85, 0.71, 0.42, 0.3), 3.0)
