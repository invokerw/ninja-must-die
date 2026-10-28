class_name PaintedPlayerVisual
extends Node2D

const ATLAS := preload("res://art/generated/characters/shadow_runner_v01.png")
const FRAME_SIZE := 256
const COLUMNS := 5
const DRAW_RECT := Rect2(-48.0, -42.0, 256.0 / 3.0, 256.0 / 3.0)
const CLIPS := {
	&"run": [0, 8, 14.0], &"hang": [8, 4, 5.0],
	&"jump": [12, 1, 1.0], &"fall": [13, 1, 1.0],
	&"flip": [14, 2, 10.0], &"dash": [16, 2, 12.0],
	&"hurt": [18, 1, 1.0], &"death": [19, 1, 1.0],
}

var player: PlayerController
var animation: StringName = &"run"
var animation_time := 0.0
var hurt_remaining := 0.0
var _last_damage_count := 0

func _ready() -> void:
	player = get_parent() as PlayerController
	_last_damage_count = player.damage_count
	z_index = 1

func _process(delta: float) -> void:
	if player.damage_count != _last_damage_count:
		_last_damage_count = player.damage_count
		hurt_remaining = 0.16
	hurt_remaining = maxf(0.0, hurt_remaining - delta)
	var next := select_animation()
	if next != animation:
		animation = next
		animation_time = 0.0
	elif player.active:
		animation_time += delta
	queue_redraw()

func select_animation() -> StringName:
	if player.health <= 0:
		return &"death"
	if hurt_remaining > 0.0:
		return &"hurt"
	if player.rope_flip_feedback_remaining > 0.12:
		return &"flip"
	if player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM:
		return &"hang"
	if player.dash_remaining > 0.0:
		return &"dash"
	if not player.on_rope:
		return &"jump" if player.velocity.y < 0.0 else &"fall"
	return &"run"

func get_frame_index() -> int:
	var clip: Array = CLIPS[animation]
	var rate := float(clip[2])
	if animation == &"run" and is_instance_valid(player) and player.tuning != null:
		rate *= absf(player.velocity.x) / player.tuning.run_speed if player.active else 0.0
	return int(clip[0]) + int(animation_time * rate) % int(clip[1])

func _draw() -> void:
	if not is_instance_valid(player):
		return
	var index := get_frame_index()
	var region := Rect2((index % COLUMNS) * FRAME_SIZE, floori(float(index) / COLUMNS) * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE)
	var tint := Color.WHITE
	if player.immunity_remaining > 0.0 and player.skill_immunity_remaining <= 0.0:
		tint.a = 0.45 if fmod(player.immunity_remaining, 0.16) < 0.08 else 1.0
	draw_texture_rect_region(ATLAS, DRAW_RECT, region, tint)
