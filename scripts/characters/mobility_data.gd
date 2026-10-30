class_name MobilityData
extends Resource

enum InputMode { EDGE, HOLD }

@export var mobility_id: StringName = &"third_jump"
@export var display_name: String = "踏影"
@export_multiline var description: String = "基础二段跳用尽后，点按身法追加一次上升。"
@export var input_mode: InputMode = InputMode.EDGE
@export var cooldown_seconds: float = 0.0
@export var air_use_limit: int = 1
@export var invulnerability_seconds: float = 0.0
@export var parameters: Dictionary = {"vertical_velocity": -500.0}

func get_validation_errors() -> PackedStringArray:
	var errors := PackedStringArray()
	if display_name.is_empty() or mobility_id not in [&"third_jump", &"glide", &"burst"]:
		errors.append("身法必须有名称和已注册的实现 ID")
	if not is_finite(cooldown_seconds) or cooldown_seconds < 0.0 or not is_finite(invulnerability_seconds) or invulnerability_seconds < 0.0:
		errors.append("身法冷却与保护时长必须为非负有限数")
	if air_use_limit != 1:
		errors.append("首批身法每次离绳只能使用一次额度")
	if mobility_id == &"glide":
		if input_mode != InputMode.HOLD or invulnerability_seconds != 0.0 or cooldown_seconds != 0.0:
			errors.append("御风须为无冷却、无保护的按住身法")
		_validate_parameter(errors, "air_duration", 0.1, 3.0)
		_validate_parameter(errors, "fall_speed", 1.0, 500.0)
	elif mobility_id == &"burst":
		if input_mode != InputMode.EDGE or cooldown_seconds <= 0.0:
			errors.append("雷闪须为有冷却的点按身法")
		_validate_parameter(errors, "duration", 0.01, 0.5)
		_validate_parameter(errors, "speed", 321.0, 2000.0)
		if (parameters.get("duration") is float or parameters.get("duration") is int) and (invulnerability_seconds > float(parameters["duration"]) or cooldown_seconds < float(parameters["duration"])):
			errors.append("雷闪保护不能超过短冲时长，冷却不能短于短冲")
	elif mobility_id == &"third_jump":
		if input_mode != InputMode.EDGE or invulnerability_seconds != 0.0 or cooldown_seconds != 0.0:
			errors.append("踏影须为无冷却、无保护的点按身法")
		_validate_parameter(errors, "vertical_velocity", -1000.0, -1.0)
	return errors

func _validate_parameter(errors: PackedStringArray, key: String, minimum: float, maximum: float) -> void:
	var value: Variant = parameters.get(key)
	if not (value is float or value is int) or not is_finite(float(value)) or float(value) < minimum or float(value) > maximum:
		errors.append("身法参数 %s 须在 %.2f 至 %.2f 之间" % [key, minimum, maximum])
