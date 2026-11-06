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

enum State { ROPE_TOP, ROPE_BOTTOM, JUMP, FALL, MOBILITY, STOPPED }

var state: State = State.STOPPED
var health: int
var damage_count := 0
var crystals := 0
var active := false
var on_rope := true
var rope_side := ROPE_TOP
var rope_y := 520.0
var rope_offset := 34.0
# Transitional read aliases for tools and scripts using the previous vocabulary.
var dash_remaining: float:
	get: return mobility.active_remaining if mobility != null and mobility.is_bursting() else 0.0
var dash_cooldown: float:
	get: return mobility.cooldown_remaining if mobility != null else 0.0
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
var mobility: MobilityRuntime
var previous_physics_position := Vector2.ZERO
var _coyote_remaining := 0.0
var _buffer_remaining := 0.0
var _buffer_is_jump_only := false
var _jump_consumed := false
var _fast_falling := false
var _queued_rope_side := 0
var _queued_fast_fall := false
var _motion_sweep: ShapeCast2D
var _guard_charm_used := false
var _spring_potion_used := false

const ROPE_FLIP_FEEDBACK_DURATION := 0.24

func _enter_tree() -> void:
	if run_loadout == null:
		run_loadout = PlayerProfile.current().resolve(character)
	character = run_loadout.character

func _ready() -> void:
	if tuning == null:
		tuning = load("res://data/control_tuning.tres")
	tuning = tuning.duplicate(true)
	if character == null:
		character = load("res://data/characters/shadow_runner.tres")
	if run_loadout == null:
		run_loadout = PlayerProfile.current().resolve(character)
	character = run_loadout.character
	var mobility_data := character.get_mobility_data()
	if mobility_data != null:
		mobility = MobilityRuntime.new(mobility_data)
	configuration_errors = character.get_validation_errors(tuning.base_max_jump_count)
	configuration_errors.append_array(run_loadout.weapon.get_validation_errors())
	if not run_loadout.weapon.allows(character.character_id):
		configuration_errors.append("当前角色与武器不兼容")
	if not configuration_errors.is_empty():
		push_error("\n".join(configuration_errors))
		return
	max_jump_count = tuning.base_max_jump_count
	jumps_remaining = max_jump_count - 1
	# Establish input protection before any hazard/sentry contact tick.
	process_physics_priority = -100
	collision_layer = 2
	collision_mask = 0
	add_to_group("player")
	_motion_sweep = ShapeCast2D.new()
	_motion_sweep.shape = ($CollisionShape2D as CollisionShape2D).shape
	_motion_sweep.enabled = false
	_motion_sweep.collide_with_areas = true
	_motion_sweep.collide_with_bodies = false
	_motion_sweep.collision_mask = 4 | 16 | 32
	_motion_sweep.max_results = 64
	add_child(_motion_sweep)
	var body_level := int(run_loadout.growth_snapshot.get("body_training", 0))
	tuning.max_health += body_level
	if String(run_loadout.item_snapshot.get("selected_scroll_id", "")) == "guard_scroll":
		tuning.hurt_immunity = 1.0
	health = tuning.max_health
	_snap_to_rope()
	previous_physics_position = global_position
	var visual := PaintedPlayerVisual.new()
	visual.name = "PaintedVisual"
	add_child(visual)
	queue_redraw()

func _physics_process(delta: float) -> void:
	if not active:
		return

	previous_physics_position = global_position
	_jump_consumed = false
	_update_timers(delta)
	physics_tick.emit(delta)
	var jump_only := run_input.is_action_just_pressed("jump_only")
	if jump_only or run_input.is_action_just_pressed("jump"):
		_buffer_remaining = tuning.jump_buffer
		_buffer_is_jump_only = jump_only

	if on_rope:
		_process_rope_input()
	else:
		_process_air_input()

	# Resolve basic input first. A second jump and a third-jump press in the
	# same frame consume only the basic jump; burst can follow a takeoff.
	if run_input.is_action_just_pressed("mobility"):
		if mobility.try_start(_mobility_context()):
			velocity.y = mobility.consume_vertical_impulse(velocity.y)
			emit_feedback(mobility.feedback_cue())
	mobility.update_hold(run_input.is_action_pressed("mobility"), _mobility_context(), delta)
	# Movement below uses the effects accepted during this tick.
	var sweep_from := global_position
	var burst_motion := mobility.is_bursting()
	if on_rope:
		_process_rope_motion(delta)
	else:
		_process_air_motion(delta)
	if burst_motion:
		_sweep_burst_contacts(sweep_from)

	if global_position.y > 900.0:
		fail("从钢索坠落")
	queue_redraw()

func _update_timers(delta: float) -> void:
	if mobility != null:
		mobility.tick(delta)
	immunity_remaining = maxf(immunity_remaining - delta, 0.0)
	skill_immunity_remaining = maxf(skill_immunity_remaining - delta, 0.0)
	rope_flip_lock_remaining = maxf(rope_flip_lock_remaining - delta, 0.0)
	rope_flip_feedback_remaining = maxf(rope_flip_feedback_remaining - delta, 0.0)
	_coyote_remaining = maxf(_coyote_remaining - delta, 0.0)
	_buffer_remaining = maxf(_buffer_remaining - delta, 0.0)

func _process_rope_input() -> void:
	if mobility.is_bursting():
		if run_input.is_action_just_pressed("rope_flip"):
			_queued_rope_side = -rope_side
			return
		elif run_input.is_action_just_pressed("drop"):
			_queued_rope_side = ROPE_BOTTOM
			return
		if _queued_rope_side != 0:
			return
	if _queued_rope_side != 0:
		var target := _queued_rope_side
		_queued_rope_side = 0
		_buffer_remaining = 0.0
		if target != rope_side:
			_switch_rope(target)
		return
	if rope_flip_lock_remaining > 0.0:
		return
	if run_input.is_action_just_pressed("rope_flip"):
		_buffer_remaining = 0.0
		_switch_rope(-rope_side)
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
	var speed := get_forward_speed()
	velocity = Vector2(speed, 0.0)
	global_position.y = rope_y - float(rope_side) * rope_offset
	move_and_slide()
	if mobility.is_active():
		state = State.MOBILITY
	else:
		state = State.ROPE_TOP if rope_side == ROPE_TOP else State.ROPE_BOTTOM

func _process_air_input() -> void:
	var fast_fall_requested := run_input.is_action_just_pressed("rope_flip") or run_input.is_action_pressed("drop")
	if fast_fall_requested:
		_buffer_remaining = 0.0
		mobility.release()
		if mobility.is_bursting():
			_queued_fast_fall = true
		else:
			_fast_falling = true
	if _queued_fast_fall and not mobility.is_bursting():
		_fast_falling = true
		_queued_fast_fall = false
	if _fast_falling:
		velocity.y = maxf(velocity.y, 1000.0)
		return
	var jump_only := run_input.is_action_just_pressed("jump_only")
	if jump_only or run_input.is_action_just_pressed("jump"):
		if not jump_only and _can_regrab_rope():
			_attach_to_rope(ROPE_TOP)
		elif jumps_remaining > 0:
			velocity.y = tuning.double_jump_velocity
			jumps_remaining -= 1
			_jump_consumed = true
			_buffer_remaining = 0.0
			emit_feedback(&"air_jump")

func _process_air_motion(delta: float) -> void:
	var speed := get_forward_speed()
	velocity.x = speed
	velocity.y += tuning.gravity * delta
	velocity.y = mobility.vertical_speed(velocity.y)
	var previous_y := global_position.y
	move_and_slide()
	state = State.MOBILITY if mobility.is_active() else (State.JUMP if velocity.y < 0.0 else State.FALL)
	var landing_y := rope_y - rope_offset
	# Sweep the feet across the rope so a fast fall cannot skip the landing surface.
	if velocity.y > 0.0 and previous_y <= landing_y and global_position.y >= landing_y:
		_attach_to_rope(ROPE_TOP)
	elif _can_regrab_rope() and _buffer_remaining > 0.0 and not _buffer_is_jump_only:
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
	_jump_consumed = true
	mobility.on_rope_detach()
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
	_fast_falling = false
	_queued_fast_fall = false
	if mobility != null:
		mobility.reset_on_rope_attach()
	run_input.cancel_action(&"mobility")
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
	return skill_immunity_remaining > 0.00001 or immunity_remaining > 0.00001 or (mobility != null and mobility.invulnerability_remaining > 0.00001)

func take_damage(amount: int = 1) -> void:
	if not active:
		return
	if is_invulnerable():
		emit_feedback(&"guard")
		return
	mobility.release()
	run_input.cancel_action(&"mobility")
	damage_count += 1
	var item_id := String(run_loadout.item_snapshot.get("consumed_item_id", ""))
	if item_id == "guard_charm" and not _guard_charm_used:
		_guard_charm_used = true
		immunity_remaining = tuning.hurt_immunity
		health_changed.emit(health, tuning.max_health)
		emit_feedback(&"hit")
		return
	health = maxi(health - amount, 0)
	if item_id == "spring_potion" and not _spring_potion_used and health == 1:
		_spring_potion_used = true
		health = mini(health + 1, tuning.max_health)
	immunity_remaining = tuning.hurt_immunity
	health_changed.emit(health, tuning.max_health)
	emit_feedback(&"hit")
	if health == 0:
		fail("生命耗尽")

func get_max_health() -> int:
	return tuning.max_health if tuning != null else 0

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
	clear_run_input()
	if mobility != null:
		mobility.reset()
	_queued_rope_side = 0
	_queued_fast_fall = false
	_fast_falling = false
	stopped.emit()
	queue_redraw()

func _sweep_burst_contacts(from: Vector2) -> void:
	# Static Area2D overlap events may observe only the two endpoints. Sweep
	# the real body capsule through the complete short burst, including pickups.
	var shape_transform := ($CollisionShape2D as CollisionShape2D).transform
	_motion_sweep.global_transform = Transform2D(0.0, from) * shape_transform
	_motion_sweep.target_position = _motion_sweep.to_local(global_position + shape_transform.origin)
	# A shape cast stops at its nearest time of impact. Exclude each visited
	# object and repeat from the same origin so every object on the path counts.
	var visited := {}
	for pass_index in range(64):
		_motion_sweep.force_shapecast_update()
		if _motion_sweep.get_collision_count() == 0 or not active:
			break
		var target := _motion_sweep.get_collider(0) as CollisionObject2D
		if target == null or visited.has(target.get_instance_id()):
			break
		visited[target.get_instance_id()] = true
		_motion_sweep.add_exception(target)
		if target is CrystalPickup:
			target._on_body_entered(self)
		elif target is Hazard or (target is RopeSentry and target.alive):
			take_damage()
	_motion_sweep.clear_exceptions()
	# Restore the helper's local pose for the next body movement.
	_motion_sweep.transform = Transform2D.IDENTITY

func get_state_name() -> String:
	return State.keys()[state]

func emit_feedback(cue: StringName, at: Vector2 = Vector2.INF) -> void:
	feedback_requested.emit(cue, global_position if at == Vector2.INF else at)

func get_rope_side_name() -> String:
	if not on_rope:
		return "空中"
	return "钢索上" if rope_side == ROPE_TOP else "钢索下"

func _mobility_context() -> Dictionary:
	return {"on_rope": on_rope, "velocity_y": velocity.y, "jumps_remaining": jumps_remaining,
		"jump_consumed": _jump_consumed, "fast_fall": _fast_falling or _queued_fast_fall}

func get_forward_speed() -> float:
	return mobility.horizontal_speed(tuning.run_speed) if mobility != null else tuning.run_speed

func is_mobility_bursting() -> bool:
	return mobility != null and mobility.is_bursting()

func is_mobility_ready() -> bool:
	return mobility != null and active and mobility.can_use(_mobility_context())

func get_mobility_text() -> String:
	return "身法" if mobility == null else "%s\n%s" % [mobility.data.display_name, mobility.remaining_text(_mobility_context())]

func clear_run_input() -> void:
	run_input.clear_all()
	_buffer_remaining = 0.0
	_queued_rope_side = 0
	_queued_fast_fall = false
	if mobility != null:
		mobility.release()

func _notification(what: int) -> void:
	if what in [NOTIFICATION_PAUSED, NOTIFICATION_APPLICATION_FOCUS_OUT, NOTIFICATION_WM_WINDOW_FOCUS_OUT, NOTIFICATION_APPLICATION_PAUSED]:
		clear_run_input()

func _draw() -> void:
	var feedback_ratio := clampf(rope_flip_feedback_remaining / ROPE_FLIP_FEEDBACK_DURATION, 0.0, 1.0)
	if is_mobility_bursting():
		draw_line(Vector2(-24, 0), Vector2(-90, 0), Color(0.85, 0.71, 0.42, 0.45), 7)
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
