class_name PlayerController
extends CharacterBody2D

signal health_changed(current: int, maximum: int)
signal crystal_collected
signal physics_tick(delta: float)
signal stopped
signal run_failed(reason: String)
signal rope_side_changed(side: int)
signal feedback_requested(cue: StringName, position: Vector2)

@export var tuning: PlayerTuning
@export var character: CharacterData

const ROPE_TOP := 1
const ROPE_BOTTOM := -1

enum State { ROPE_TOP, ROPE_BOTTOM, JUMP, FALL, DASH, STOPPED }

var state: State = State.STOPPED
var health: int
var damage_count := 0
var crystals := 0
var active := false
var on_rope := true
var rope_side := ROPE_TOP
var rope_y := 520.0
var rope_offset := 34.0
var dash_remaining := 0.0
var dash_cooldown := 0.0
var immunity_remaining := 0.0
var skill_immunity_remaining := 0.0
var rope_flip_lock_remaining := 0.0
var rope_flip_feedback_remaining := 0.0
var rope_flip_feedback_side := ROPE_TOP
var jumps_remaining := 0
var max_jump_count := 2
var configuration_errors := PackedStringArray()
var run_loadout: RunLoadout
var run_input := RunInput.new()
var previous_physics_position := Vector2.ZERO
var _coyote_remaining := 0.0
var _buffer_remaining := 0.0

const ROPE_FLIP_FEEDBACK_DURATION := 0.24

func _enter_tree() -> void:
	if run_loadout == null:
		run_loadout = PlayerProfile.current().resolve(character)
	character = run_loadout.character

func _ready() -> void:
	if tuning == null:
		tuning = load("res://data/control_tuning.tres")
	if character == null:
		character = load("res://data/characters/shadow_runner.tres")
	if run_loadout == null:
		run_loadout = PlayerProfile.current().resolve(character)
	character = run_loadout.character
	configuration_errors = character.get_validation_errors(tuning.base_max_jump_count)
	configuration_errors.append_array(run_loadout.weapon.get_validation_errors())
	if not run_loadout.weapon.allows(character.character_id):
		configuration_errors.append("当前角色与武器不兼容")
	if not configuration_errors.is_empty():
		push_error("\n".join(configuration_errors))
		return
	max_jump_count = character.get_max_jump_count(tuning.base_max_jump_count)
	jumps_remaining = max_jump_count - 1
	# Establish input protection before any hazard/sentry contact tick.
	process_physics_priority = -100
	collision_layer = 2
	collision_mask = 0
	add_to_group("player")
	health = tuning.max_health
	_snap_to_rope()
	previous_physics_position = global_position
	queue_redraw()

func _physics_process(delta: float) -> void:
	if not active:
		return

	previous_physics_position = global_position
	_update_timers(delta)
	physics_tick.emit(delta)
	if run_input.is_action_just_pressed("jump"):
		_buffer_remaining = tuning.jump_buffer

	if on_rope:
		_process_rope_input()
		if on_rope:
			_process_rope_motion(delta)
		else:
			_process_air_motion(delta)
	else:
		_process_air_input()
		if on_rope:
			_process_rope_motion(delta)
		else:
			_process_air_motion(delta)

	if global_position.y > 900.0:
		fail("从钢索坠落")
	queue_redraw()

func _update_timers(delta: float) -> void:
	dash_remaining = maxf(dash_remaining - delta, 0.0)
	dash_cooldown = maxf(dash_cooldown - delta, 0.0)
	immunity_remaining = maxf(immunity_remaining - delta, 0.0)
	skill_immunity_remaining = maxf(skill_immunity_remaining - delta, 0.0)
	rope_flip_lock_remaining = maxf(rope_flip_lock_remaining - delta, 0.0)
	rope_flip_feedback_remaining = maxf(rope_flip_feedback_remaining - delta, 0.0)
	_coyote_remaining = maxf(_coyote_remaining - delta, 0.0)
	_buffer_remaining = maxf(_buffer_remaining - delta, 0.0)

func _process_rope_input() -> void:
	if run_input.is_action_just_pressed("dash") and dash_cooldown <= 0.0:
		dash_remaining = tuning.dash_duration
		dash_cooldown = tuning.dash_duration + tuning.dash_recovery
		state = State.DASH
		emit_feedback(&"dash")
		return
	if rope_flip_lock_remaining > 0.0:
		return
	if run_input.is_action_just_pressed("drop"):
		if rope_side == ROPE_TOP:
			_switch_rope(ROPE_BOTTOM)
		return
	var jump_pressed := run_input.is_action_just_pressed("jump") or _buffer_remaining > 0.0
	if jump_pressed:
		_buffer_remaining = 0.0
		if rope_side == ROPE_BOTTOM:
			_switch_rope(ROPE_TOP)
		else:
			_detach_from_rope(tuning.jump_velocity)

func _process_rope_motion(delta: float) -> void:
	var speed := tuning.dash_speed if dash_remaining > 0.0 else tuning.run_speed
	velocity = Vector2(speed, 0.0)
	global_position.y = rope_y - float(rope_side) * rope_offset
	move_and_slide()
	if dash_remaining > 0.0:
		state = State.DASH
	else:
		state = State.ROPE_TOP if rope_side == ROPE_TOP else State.ROPE_BOTTOM

func _process_air_input() -> void:
	if run_input.is_action_just_pressed("dash") and dash_cooldown <= 0.0:
		dash_remaining = tuning.dash_duration
		dash_cooldown = tuning.dash_duration + tuning.dash_recovery
		emit_feedback(&"dash")
	if run_input.is_action_just_pressed("jump"):
		if _can_regrab_rope():
			_attach_to_rope(ROPE_TOP)
		elif jumps_remaining > 0:
			var jump_number := max_jump_count - jumps_remaining + 1
			velocity.y = tuning.double_jump_velocity if jump_number == 2 else tuning.third_jump_velocity
			jumps_remaining -= 1
			_buffer_remaining = 0.0
			emit_feedback(&"air_jump")
	if run_input.is_action_pressed("drop"):
		velocity.y = maxf(velocity.y, 1000.0)

func _process_air_motion(delta: float) -> void:
	var speed := tuning.dash_speed if dash_remaining > 0.0 else tuning.run_speed
	velocity.x = speed
	velocity.y += tuning.gravity * delta
	var previous_y := global_position.y
	move_and_slide()
	state = State.DASH if dash_remaining > 0.0 else (State.JUMP if velocity.y < 0.0 else State.FALL)
	var landing_y := rope_y - rope_offset
	# Sweep the feet across the rope so a fast fall cannot skip the landing surface.
	if velocity.y > 0.0 and previous_y <= landing_y and global_position.y >= landing_y:
		_attach_to_rope(ROPE_TOP)
	elif _can_regrab_rope() and _buffer_remaining > 0.0:
		_attach_to_rope(ROPE_TOP)

func _switch_rope(target_side: int) -> void:
	rope_side = target_side
	on_rope = true
	rope_flip_lock_remaining = 0.10
	rope_flip_feedback_remaining = ROPE_FLIP_FEEDBACK_DURATION
	rope_flip_feedback_side = target_side
	velocity = Vector2.ZERO
	_snap_to_rope()
	rope_side_changed.emit(rope_side)
	emit_feedback(&"flip")

func _detach_from_rope(initial_vertical_velocity: float) -> void:
	on_rope = false
	_coyote_remaining = tuning.coyote_time
	_buffer_remaining = 0.0
	jumps_remaining = max_jump_count - 1
	velocity = Vector2(tuning.run_speed, initial_vertical_velocity)
	state = State.JUMP if initial_vertical_velocity < 0.0 else State.FALL
	emit_feedback(&"jump")

func _attach_to_rope(target_side: int) -> void:
	rope_side = target_side
	on_rope = true
	_buffer_remaining = 0.0
	jumps_remaining = max_jump_count - 1
	velocity = Vector2.ZERO
	_snap_to_rope()
	rope_side_changed.emit(rope_side)
	emit_feedback(&"land")

func _snap_to_rope() -> void:
	global_position.y = rope_y - float(rope_side) * rope_offset
	state = State.ROPE_TOP if rope_side == ROPE_TOP else State.ROPE_BOTTOM

func _can_regrab_rope() -> bool:
	return not on_rope and velocity.y > 0.0 and absf(global_position.y - rope_y) <= 42.0

func collect_crystal() -> void:
	if not active:
		return
	crystals += 1
	crystal_collected.emit()
	emit_feedback(&"pickup")

func is_invulnerable() -> bool:
	return skill_immunity_remaining > 0.00001 or immunity_remaining > 0.00001 or dash_remaining > 0.00001

func take_damage(amount: int = 1) -> void:
	if not active:
		return
	if is_invulnerable():
		emit_feedback(&"guard")
		return
	damage_count += 1
	health = maxi(health - amount, 0)
	immunity_remaining = tuning.hurt_immunity
	health_changed.emit(health, tuning.max_health)
	emit_feedback(&"hit")
	if health == 0:
		fail("生命耗尽")

func fail(reason: String) -> void:
	if not active:
		return
	stop()
	run_failed.emit(reason)

func stop() -> void:
	active = false
	state = State.STOPPED
	velocity = Vector2.ZERO
	skill_immunity_remaining = 0.0
	stopped.emit()
	queue_redraw()

func get_state_name() -> String:
	return State.keys()[state]

func emit_feedback(cue: StringName, at: Vector2 = Vector2.INF) -> void:
	feedback_requested.emit(cue, global_position if at == Vector2.INF else at)

func get_rope_side_name() -> String:
	if not on_rope:
		return "空中"
	return "钢索上" if rope_side == ROPE_TOP else "钢索下"

func _draw() -> void:
	# Temporary geometry is only a control marker; final art follows the imagegen style guide.
	var tint := Color("dde7e7")
	if state == State.DASH:
		tint = Color("d8b56a")
	elif immunity_remaining > 0.0 and skill_immunity_remaining <= 0.0:
		tint.a = 0.45 if fmod(immunity_remaining, 0.16) < 0.08 else 1.0
	var feedback_ratio := clampf(rope_flip_feedback_remaining / ROPE_FLIP_FEEDBACK_DURATION, 0.0, 1.0)
	var squash := lerpf(1.0, 0.68, sin((1.0 - feedback_ratio) * PI))
	draw_set_transform(Vector2.ZERO, 0.0, Vector2(1.0, squash))
	draw_style_box(_body_style(tint), Rect2(-18, -30, 36, 60))
	var direction := -1.0 if rope_side == ROPE_BOTTOM else 1.0
	draw_line(Vector2(-9, 17.0 * direction), Vector2(13, 17.0 * direction), Color("111827"), 3)
	if run_loadout != null:
		WeaponArt.draw_icon(self, run_loadout.weapon.weapon_id, Vector2(-24, -9), 13.0)
	if state == State.DASH:
		draw_line(Vector2(-24, 0), Vector2(-90, 0), Color(0.85, 0.71, 0.42, 0.45), 7)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	if skill_immunity_remaining > 0.0:
		var closing := clampf(skill_immunity_remaining / 0.35, 0.0, 1.0)
		var glow := Color(0.85, 0.71, 0.42, 0.85 * closing)
		draw_arc(Vector2.ZERO, 33.0 + 11.0 * closing, -PI * 0.5, TAU - PI * 0.5, 48, glow, 3.0)
		draw_arc(Vector2.ZERO, 29.0 + 11.0 * closing, -0.9, 0.9, 20, Color(0.87, 0.91, 0.91, closing), 3.0)
	if feedback_ratio > 0.0:
		var feedback_direction := -1.0 if rope_flip_feedback_side == ROPE_BOTTOM else 1.0
		var feedback_alpha := 0.25 + feedback_ratio * 0.75
		var feedback_color := Color(0.85, 0.71, 0.42, feedback_alpha)
		draw_arc(Vector2(0, feedback_direction * 4.0), 38.0 + (1.0 - feedback_ratio) * 10.0, 0.1, PI - 0.1, 18, feedback_color, 4.0)
		draw_line(Vector2(-26, feedback_direction * 25.0), Vector2(26, feedback_direction * 25.0), feedback_color, 3.0)

func _body_style(tint: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = tint
	style.set_corner_radius_all(12)
	return style
