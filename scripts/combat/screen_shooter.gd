class_name ScreenShooter
extends Node2D

signal projectile_fired(projectile: EnemyProjectile)

enum AttackState { IDLE, WINDUP, RECOVERY, SPENT }

@export var trigger_x := 0.0
@export_enum("top", "bottom") var cable_side := "top"
@export var windup_seconds := 0.8
@export var projectile_speed := 720.0
@export var screen_edge_offset := 48.0
@export var screen_height_ratio := 0.55
@export var fire_direction := Vector2(-1.0, 0.12)
@export_range(1, 7) var volley_count := 3
@export var volley_spacing := 144.0

var projectile_parent: Node2D
var attack_state := AttackState.IDLE
var windup_remaining := 0.0
var shots_fired := 0
var volleys_fired := 0
var _recovery_remaining := 0.0
var _player: PlayerController

func bind_player(player: PlayerController) -> void:
	_player = player
	player.stopped.connect(_cancel_attack)

func _ready() -> void:
	# This node lives in a CanvasLayer, so scrolling and camera smoothing cannot move it.
	_sync_screen_position()
	hide()

func _process(_delta: float) -> void:
	_sync_screen_position()
	queue_redraw()

func _physics_process(delta: float) -> void:
	_sync_screen_position()
	if not is_instance_valid(_player) or not _player.active:
		_cancel_attack()
		return
	match attack_state:
		AttackState.IDLE:
			if _player.global_position.x >= trigger_x:
				attack_state = AttackState.WINDUP
				windup_remaining = windup_seconds
				show()
		AttackState.WINDUP:
			windup_remaining = maxf(windup_remaining - delta, 0.0)
			if windup_remaining <= 0.00001:
				_fire()
		AttackState.RECOVERY:
			_recovery_remaining = maxf(_recovery_remaining - delta, 0.0)
			if _recovery_remaining <= 0.0:
				_cancel_attack()

func _sync_screen_position() -> void:
	var viewport := get_viewport()
	var rect := viewport.get_visible_rect()
	var screen_position := Vector2(rect.end.x + screen_edge_offset, rect.position.y + rect.size.y * screen_height_ratio)
	global_position = screen_position

func get_world_origin() -> Vector2:
	return get_viewport().get_canvas_transform().affine_inverse() * global_position

func get_flight_seconds() -> float:
	# Only the HUD estimates arrival; the shot direction never uses player information.
	var closing_speed := _player.tuning.run_speed - fire_direction.normalized().x * projectile_speed
	return maxf((get_world_origin().x - _player.global_position.x) / closing_speed, 0.0)

func get_volley_offset(index: int) -> Vector2:
	var normal := fire_direction.normalized().orthogonal()
	var half_span := float(volley_count - 1) * volley_spacing * 0.5
	# Shift the entire column outwards so even diagonal volleys start beyond the edge.
	return normal * (float(index) * volley_spacing - half_span) + Vector2(absf(normal.x) * half_span, 0.0)

func _fire() -> void:
	var origin := get_world_origin()
	var shot_velocity := fire_direction.normalized() * projectile_speed
	var viewport := get_viewport()
	var left_world := viewport.get_canvas_transform().affine_inverse() * Vector2(viewport.get_visible_rect().position.x - 96.0, 0.0)
	for index in range(volley_count):
		var projectile := EnemyProjectile.new()
		projectile.target = _player
		projectile.velocity = shot_velocity
		projectile.cable_side = cable_side
		var spawn := origin + get_volley_offset(index)
		# Allow the entire route across this viewport, with a bounded cleanup fallback.
		projectile.lifetime_remaining = maxf((spawn.x - left_world.x) / -shot_velocity.x + 1.0, 3.0)
		projectile_parent.add_child(projectile)
		projectile.global_position = spawn
		shots_fired += 1
		projectile_fired.emit(projectile)
	volleys_fired += 1
	attack_state = AttackState.RECOVERY
	_recovery_remaining = 0.3

func _cancel_attack() -> void:
	attack_state = AttackState.SPENT
	windup_remaining = 0.0
	_recovery_remaining = 0.0
	hide()

func cancel() -> void:
	_cancel_attack()

func _draw() -> void:
	# A floating source, independent of the rope; positive edge offset puts it offscreen.
	draw_colored_polygon(PackedVector2Array([Vector2(-24, 0), Vector2(0, -18), Vector2(26, 0), Vector2(0, 18)]), Color("b24b4b"))
	draw_circle(Vector2.ZERO, 8.0, Color("d8b56a"))
	if attack_state != AttackState.WINDUP or not is_instance_valid(_player):
		return
	var charge := 1.0 - windup_remaining / windup_seconds
	var tint := Color(0.95, 0.76, 0.43, 0.35 + 0.5 * charge)
	var viewport := get_viewport()
	var rect := viewport.get_visible_rect()
	var canvas := viewport.get_canvas_transform()
	# Show the parallel paths as they appear while the camera scrolls at base speed.
	var screen_velocity := canvas.basis_xform(fire_direction.normalized() * projectile_speed - Vector2(_player.tuning.run_speed, 0.0))
	var direction := screen_velocity.normalized()
	var normal := direction.orthogonal()
	for index in range(volley_count):
		var start := canvas * (get_world_origin() + get_volley_offset(index))
		var end := start + direction * ((start.x - rect.position.x + 96.0) / -direction.x)
		draw_line(to_local(start), to_local(end), Color(tint, 0.2 + charge * 0.25), 2.0)
		var marker := to_local(start + direction * ((start.x - rect.end.x + 24.0) / -direction.x))
		draw_colored_polygon(PackedVector2Array([marker + direction * 12.0, marker - direction * 8.0 + normal * 9.0, marker - direction * 8.0 - normal * 9.0]), tint)
		draw_arc(marker, 16.0 + 8.0 * (1.0 - charge), -PI, PI, 24, tint, 2.0)
