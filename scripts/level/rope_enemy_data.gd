class_name RopeEnemyData
extends Resource

@export var offset_x: float
@export_enum("top", "bottom") var cable_side: String = "top"
@export_range(1, 3) var health: int = 1
@export_enum("sentry", "shooter") var enemy_type: String = "sentry"
@export var windup_seconds: float = 0.8
@export var projectile_speed: float = 720.0
@export var screen_edge_offset: float = 48.0
@export var screen_height_ratio: float = 0.55
@export var fire_direction: Vector2 = Vector2(-1.0, 0.12)
@export_range(1, 7) var volley_count: int = 3
@export var volley_spacing: float = 144.0

func get_validation_errors(run_speed: float) -> PackedStringArray:
	var errors := PackedStringArray()
	if enemy_type not in ["sentry", "shooter"]:
		errors.append("未知的敌人类型")
	if enemy_type == "shooter":
		if not is_finite(windup_seconds) or windup_seconds < 0.6:
			errors.append("右侧远程攻击至少需要 0.6 秒屏内预警")
		if not is_finite(projectile_speed) or projectile_speed <= run_speed:
			errors.append("远程飞弹速度必须大于基础跑速")
		if not is_finite(screen_edge_offset) or screen_edge_offset < -96.0 or screen_edge_offset > 128.0:
			errors.append("发射器须保持在屏幕右边缘附近")
		if not is_finite(screen_height_ratio) or screen_height_ratio < 0.1 or screen_height_ratio > 0.9:
			errors.append("发射器屏幕高度比例须在 0.1～0.9 之间")
		if not fire_direction.is_finite() or fire_direction.length_squared() < 0.0001 or fire_direction.normalized().x > -0.85:
			errors.append("固定方向须朝左，且不能过于竖直")
		if volley_count < 1 or volley_count > 7:
			errors.append("单波齐射数量须在 1～7 枚之间")
		if not is_finite(volley_spacing) or volley_spacing <= 0.0 or (volley_count > 1 and volley_spacing * absf(fire_direction.normalized().x) < 112.0):
			errors.append("平行弹道之间须留出可容纳角色的躲避间隙")
	return errors

func get_projectile_threats(run_speed: float, rope_y: float) -> Array[Dictionary]:
	# Estimate each parallel row at 1280x720; no prediction influences the firing vector.
	var threats: Array[Dictionary] = []
	var direction := fire_direction.normalized()
	var normal := direction.orthogonal()
	var half_span := float(volley_count - 1) * volley_spacing * 0.5
	for index in range(volley_count):
		var offset := normal * (float(index) * volley_spacing - half_span) + Vector2(absf(normal.x) * half_span, 0.0)
		var origin := Vector2(1280.0 + screen_edge_offset - 320.0, 720.0 * screen_height_ratio) + offset
		var flight_time := (origin.x - 26.0) / (run_speed - direction.x * projectile_speed)
		var contact_y := origin.y + direction.y * projectile_speed * flight_time
		for side in ["top", "bottom"]:
			var lane_y := rope_y + (-34.0 if side == "top" else 34.0)
			if absf(contact_y - lane_y) <= 38.0:
				threats.append({"offset": run_speed * (windup_seconds + flight_time), "side": side})
	return threats
