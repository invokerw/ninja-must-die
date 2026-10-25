class_name BossShurikenPickup
extends Node2D

signal collected

var player: PlayerController
var boss: RopeBoss
var spent := false
var _shape := CircleShape2D.new()
var _phase := 0.0

func _ready() -> void:
	process_physics_priority = 12
	_shape.radius = 16.0
	add_to_group("boss_shuriken_pickups")

func _physics_process(delta: float) -> void:
	if spent:
		return
	if not is_instance_valid(player) or not player.active or not is_instance_valid(boss) or not boss.is_in_combat():
		cancel()
		return
	_phase += delta
	var body := player.get_node("CollisionShape2D") as CollisionShape2D
	var movement := player.global_position - player.previous_physics_position
	if player.on_rope:
		movement.y = 0.0
	var start := body.global_transform
	start.origin -= movement
	if _shape.collide_with_motion(global_transform, -movement, body.shape, start, Vector2.ZERO):
		spent = true
		collected.emit()
		hide()
		queue_free()
		return
	if get_global_transform_with_canvas().origin.x < -64.0:
		cancel()
	queue_redraw()

func cancel() -> void:
	if spent:
		return
	spent = true
	hide()
	queue_free()

func _draw() -> void:
	draw_circle(Vector2.ZERO, 20.0, Color(0.85, 0.71, 0.42, 0.12))
	draw_arc(Vector2.ZERO, 18.0, 0.0, TAU, 24, Color("d8b56a"), 2.0)
	for index in range(3):
		var direction := Vector2.from_angle(_phase * 2.0 + float(index) * TAU / 3.0)
		var side := direction.orthogonal()
		draw_colored_polygon(PackedVector2Array([direction * 13.0, side * 4.0, -direction * 3.0]), Color("dde7e7"))
