class_name MobilityRuntime
extends RefCounted

var data: MobilityData
var active_remaining := 0.0
var cooldown_remaining := 0.0
var invulnerability_remaining := 0.0
var air_time_remaining := 0.0
var air_uses := 0
var gliding := false
var _vertical_impulse := 0.0
var _valid := false

func _init(source: MobilityData) -> void:
	data = source.duplicate(true)
	_valid = data.get_validation_errors().is_empty()
	reset()

func reset() -> void:
	active_remaining = 0.0
	cooldown_remaining = 0.0
	invulnerability_remaining = 0.0
	_vertical_impulse = 0.0
	reset_on_rope_attach()

func tick(delta: float) -> void:
	active_remaining = maxf(active_remaining - delta, 0.0)
	cooldown_remaining = maxf(cooldown_remaining - delta, 0.0)
	invulnerability_remaining = maxf(invulnerability_remaining - delta, 0.0)

func can_use(context: Dictionary = {}) -> bool:
	if not _valid or cooldown_remaining > 0.00001:
		return false
	var attached := bool(context.get("on_rope", true))
	if not attached and air_uses >= data.air_use_limit:
		return false
	match data.mobility_id:
		&"third_jump":
			return not attached and int(context.get("jumps_remaining", 1)) == 0 and not bool(context.get("jump_consumed", false))
		&"glide":
			return not attached and not bool(context.get("fast_fall", false)) and air_time_remaining > 0.00001
		&"burst":
			return true
	return false

func try_start(context: Dictionary = {}) -> bool:
	if not can_use(context):
		return false
	match data.mobility_id:
		&"third_jump":
			air_uses += 1
			_vertical_impulse = float(data.parameters["vertical_velocity"])
		&"glide":
			gliding = float(context.get("velocity_y", 0.0)) > 0.0
		&"burst":
			# A burst on the rope also consumes the next airborne allowance if the
			# runner jumps during it. Landing restores eligibility, never cooldown.
			if not bool(context.get("on_rope", true)):
				air_uses += 1
			active_remaining = float(data.parameters["duration"])
			cooldown_remaining = data.cooldown_seconds
			invulnerability_remaining = data.invulnerability_seconds
	return true

func update_hold(held: bool, context: Dictionary, delta: float) -> void:
	if data.input_mode != MobilityData.InputMode.HOLD:
		return
	gliding = held and can_use(context) and float(context.get("velocity_y", 0.0)) > 0.0
	if gliding:
		# Keep the effect through its final fraction of a physics tick.
		air_time_remaining = maxf(air_time_remaining - delta, 0.0)

func consume_vertical_impulse(current: float) -> float:
	var result := _vertical_impulse if _vertical_impulse != 0.0 else current
	_vertical_impulse = 0.0
	return result

func horizontal_speed(base_speed: float) -> float:
	return float(data.parameters["speed"]) if is_bursting() else base_speed

func vertical_speed(current: float) -> float:
	return minf(current, float(data.parameters["fall_speed"])) if gliding else current

func is_bursting() -> bool:
	return _valid and data.mobility_id == &"burst" and active_remaining > 0.00001

func is_active() -> bool:
	return is_bursting() or gliding

func feedback_cue() -> StringName:
	return &"dash" if data.mobility_id == &"burst" else &"air_jump"

func release() -> void:
	gliding = false

func on_rope_detach() -> void:
	if is_bursting():
		air_uses = data.air_use_limit

func reset_on_rope_attach() -> void:
	air_uses = 0
	air_time_remaining = float(data.parameters.get("air_duration", 0.0)) if _valid else 0.0
	release()

func remaining_text(context: Dictionary = {}) -> String:
	if cooldown_remaining > 0.00001:
		return "%.1fs" % cooldown_remaining
	match data.mobility_id:
		&"third_jump":
			if bool(context.get("on_rope", true)) or int(context.get("jumps_remaining", 1)) > 0:
				return "先二段跳"
			return "已使用" if air_uses > 0 else "空中可用"
		&"glide":
			return "下落可用" if bool(context.get("on_rope", true)) else "%.1fs" % air_time_remaining
		&"burst":
			return "就绪" if can_use(context) else "落绳恢复"
	return "不可用"
