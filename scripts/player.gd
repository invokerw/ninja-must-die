class_name PlayerController
extends CharacterBody2D

signal health_changed(current: int, maximum: int)
signal crystal_collected
signal run_failed(reason: String)

@export var tuning: PlayerTuning

enum State { RUN, JUMP, FALL, DASH, STOPPED }
var state: State = State.STOPPED
var health: int
var damage_count := 0
var crystals := 0
var active := false
var jumps_remaining := 1
var dash_remaining := 0.0
var dash_cooldown := 0.0
var immunity_remaining := 0.0
var _coyote_remaining := 0.0
var _buffer_remaining := 0.0
var _drop_remaining := 0.0
var _dash_vertical_velocity := 0.0

func _ready() -> void:
	if tuning == null:
		tuning = load("res://data/control_tuning.tres")
	set_collision_mask_value(1, true)
	set_collision_mask_value(9, true)
	health = tuning.max_health
	queue_redraw()

func _physics_process(delta: float) -> void:
	if not active:
		return
	_coyote_remaining = maxf(_coyote_remaining - delta, 0.0)
	_buffer_remaining = maxf(_buffer_remaining - delta, 0.0)
	dash_cooldown = maxf(dash_cooldown - delta, 0.0)
	immunity_remaining = maxf(immunity_remaining - delta, 0.0)
	_drop_remaining = maxf(_drop_remaining - delta, 0.0)
	set_collision_mask_value(9, _drop_remaining <= 0.0)
	if is_on_floor():
		_coyote_remaining = tuning.coyote_time
		jumps_remaining = 1
	if Input.is_action_just_pressed("jump"):
		_buffer_remaining = tuning.jump_buffer
	if Input.is_action_just_pressed("dash") and dash_cooldown <= 0.0:
		_dash_vertical_velocity = velocity.y
		dash_remaining = tuning.dash_duration
		dash_cooldown = tuning.dash_duration + tuning.dash_recovery
	if Input.is_action_just_pressed("drop") and is_on_floor():
		for index in get_slide_collision_count():
			var collider := get_slide_collision(index).get_collider()
			if collider is PhysicsBody2D and collider.get_collision_layer_value(9):
				_drop_remaining = 0.18
				set_collision_mask_value(9, false)
				_coyote_remaining = 0.0
				velocity.y = 160.0
	if dash_remaining > 0.0:
		# Blend the final partial tick so dash distance is independent of rounding.
		var dash_step := minf(dash_remaining, delta)
		velocity = Vector2(lerpf(tuning.run_speed, tuning.dash_speed, dash_step / delta), 0.0)
		dash_remaining = maxf(dash_remaining - delta, 0.0)
		state = State.DASH
		move_and_slide()
		if dash_remaining <= 0.0:
			velocity.y = _dash_vertical_velocity
	else:
		_consume_jump()
		velocity.x = tuning.run_speed
		velocity.y += tuning.gravity * delta
		if Input.is_action_pressed("drop") and not is_on_floor():
			velocity.y = maxf(velocity.y, 1000.0)
		move_and_slide()
		state = State.RUN if is_on_floor() else (State.JUMP if velocity.y < 0.0 else State.FALL)
	if global_position.y > 900.0:
		fail("坠落到谷底")
	queue_redraw()

func _consume_jump() -> void:
	if _buffer_remaining <= 0.0 or _drop_remaining > 0.0:
		return
	if is_on_floor() or _coyote_remaining > 0.0:
		velocity.y = tuning.jump_velocity
		_coyote_remaining = 0.0
	elif jumps_remaining > 0:
		velocity.y = tuning.double_jump_velocity
		jumps_remaining -= 1
	else:
		return
	_buffer_remaining = 0.0

func collect_energy(_amount: int = 10) -> void:
	if not active:
		return
	crystals += 1
	crystal_collected.emit()

func take_damage(amount: int = 1) -> void:
	if not active or state == State.DASH or immunity_remaining > 0.0:
		return
	damage_count += 1
	health = maxi(health - amount, 0)
	immunity_remaining = tuning.hurt_immunity
	health_changed.emit(health, tuning.max_health)
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
	queue_redraw()

func _draw() -> void:
	# Geometry is a physics/debug marker, not production artwork.
	var tint := Color("dde7e7")
	if state == State.DASH:
		tint = Color("d8b56a")
	elif immunity_remaining > 0.0:
		tint.a = 0.45 if fmod(immunity_remaining, 0.16) < 0.08 else 1.0
	draw_style_box(_body_style(tint), Rect2(-18, -30, 36, 60))
	draw_line(Vector2(-9, -16), Vector2(12, -16), Color("111827"), 3)
	if state == State.DASH:
		draw_line(Vector2(-24, 0), Vector2(-90, 0), Color(0.85, 0.71, 0.42, 0.45), 7)

func _body_style(tint: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = tint
	style.set_corner_radius_all(12)
	return style
