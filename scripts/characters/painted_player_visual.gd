class_name PaintedPlayerVisual
extends Node2D

const ATLAS := preload("res://art/generated/characters/shadow_runner_v01.png")
const FRAME_SIZE := 256
const COLUMNS := 5
const DRAW_RECT := Rect2(-48.0, -42.0, 256.0 / 3.0, 256.0 / 3.0)
const CLIPS := {
	&"run": [0, 8, 14.0], &"hang": [8, 4, 5.0],
	&"jump": [12, 1, 1.0], &"fall": [13, 1, 1.0],
	&"land": [13, 1, 1.0],
	&"flip": [14, 2, 10.0], &"dash": [16, 2, 12.0],
	&"hurt": [18, 1, 1.0], &"death": [19, 1, 1.0],
}

const FLIP_DURATION := 0.24
const LAND_DURATION := 0.12

var player: PlayerController
var animation: StringName = &"run"
var animation_time := 0.0
var run_phase := 0.0
var hurt_remaining := 0.0
var landing_remaining := 0.0
var _last_on_rope := true
var _last_damage_count := 0

func _ready() -> void:
	player = get_parent() as PlayerController
	_last_damage_count = player.damage_count
	_last_on_rope = player.on_rope
	z_index = 1

func _process(delta: float) -> void:
	if player.on_rope and not _last_on_rope:
		landing_remaining = LAND_DURATION
	_last_on_rope = player.on_rope
	if player.damage_count != _last_damage_count:
		_last_damage_count = player.damage_count
		hurt_remaining = 0.16
	hurt_remaining = maxf(0.0, hurt_remaining - delta)
	landing_remaining = maxf(0.0, landing_remaining - delta)
	var next := select_animation()
	if next != animation:
		_set_animation(next)
	elif player.active:
		animation_time += delta
	_update_run_phase()
	queue_redraw()

func _set_animation(next: StringName) -> void:
	if next == animation:
		return
	if animation == &"run":
		run_phase = _run_phase_from_time()
	animation = next
	if next == &"run":
		animation_time = _run_time_from_phase(run_phase)
	else:
		animation_time = 0.0

func _run_rate() -> float:
	if not is_instance_valid(player) or player.tuning == null or not player.active:
		return 0.0
	return 14.0 * absf(player.velocity.x) / player.tuning.run_speed

func _run_phase_from_time() -> float:
	var rate := _run_rate()
	if rate <= 0.001:
		return run_phase
	return fmod(animation_time * rate / float(CLIPS[&"run"][1]), 1.0)

func _run_time_from_phase(phase: float) -> float:
	var rate := _run_rate()
	if rate <= 0.001:
		return 0.0
	return phase * float(CLIPS[&"run"][1]) / rate

func _update_run_phase() -> void:
	if animation == &"run":
		run_phase = _run_phase_from_time()

func select_animation() -> StringName:
	if player.health <= 0:
		return &"death"
	if hurt_remaining > 0.0:
		return &"hurt"
	if player.rope_flip_feedback_remaining > 0.0:
		return &"flip"
	if landing_remaining > 0.0:
		return &"land"
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
	if animation == &"run":
		rate = _run_rate()
	var frame := int(animation_time * rate) % int(clip[1])
	if animation == &"flip" and player.rope_flip_feedback_side == PlayerController.ROPE_TOP:
		frame = int(clip[1]) - 1 - frame
	return int(clip[0]) + frame

func _draw() -> void:
	if not is_instance_valid(player):
		return
	var index := get_frame_index()
	var region := Rect2((index % COLUMNS) * FRAME_SIZE, floori(float(index) / COLUMNS) * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE)
	var tint := Color.WHITE
	if player.immunity_remaining > 0.0 and player.skill_immunity_remaining <= 0.0:
		tint.a = 0.45 if fmod(player.immunity_remaining, 0.16) < 0.08 else 1.0
	var offset := Vector2.ZERO
	var scale := Vector2.ONE
	if animation == &"flip":
		# The body snaps for gameplay, while the artwork travels from the old
		# rope to the new one over the flip duration.
		var progress := 1.0 - clampf(player.rope_flip_feedback_remaining / FLIP_DURATION, 0.0, 1.0)
		progress = progress * progress * (3.0 - 2.0 * progress)
		offset.y = 2.0 * player.rope_offset * float(player.rope_flip_feedback_side) * (1.0 - progress)
	elif animation == &"land":
		var progress := 1.0 - clampf(landing_remaining / LAND_DURATION, 0.0, 1.0)
		progress = progress * progress * (3.0 - 2.0 * progress)
		offset.y = 4.0 * (1.0 - progress)
		scale = Vector2(1.0 + 0.04 * (1.0 - progress), 1.0 - 0.12 * (1.0 - progress))
	draw_set_transform(offset, 0.0, scale)
	draw_texture_rect_region(ATLAS, DRAW_RECT, region, tint)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
