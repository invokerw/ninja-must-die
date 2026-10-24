class_name RopeLevelData
extends Resource

@export var level_id: StringName
@export var title: String
@export var start_x: float = 160.0
@export var rope_y: float = 520.0
@export var recommended_speed: float = 320.0
@export var warning_seconds: float = 1.3
@export var minimum_flip_window: float = 0.75
@export var pickup_clearance: float = 80.0
@export var segments: Array[RopeSegmentData] = []

func get_length() -> float:
	var length := 0.0
	for segment in segments:
		if segment != null:
			length += segment.length_px
	return length

func get_finish_x() -> float:
	return start_x + get_length()

func get_nominal_seconds() -> float:
	return get_length() / maxf(recommended_speed, 1.0)

func get_segment_index(world_x: float) -> int:
	var boundary := start_x
	for index in range(segments.size()):
		boundary += segments[index].length_px
		if world_x < boundary:
			return index
	return segments.size() - 1

func get_validation_errors(player_half_width: float = 18.0) -> PackedStringArray:
	var errors := PackedStringArray()
	if recommended_speed <= 0.0 or warning_seconds <= 0.0:
		errors.append("跑速和预警时间必须大于零")
	if minimum_flip_window < 0.0 or pickup_clearance < 0.0:
		errors.append("翻绳窗口和收集间隔不能为负数")
	if segments.is_empty():
		errors.append("至少需要一个关卡段落")
	var ids: Array[StringName] = []
	var pickups: Array[Dictionary] = []
	var threats: Array[Dictionary] = []
	var segment_start := start_x
	for segment in segments:
		if segment == null:
			errors.append("段落资源不能为空")
			continue
		if segment.segment_id == &"" or ids.has(segment.segment_id):
			errors.append("段落 ID 必须非空且唯一")
		ids.append(segment.segment_id)
		if segment.title.is_empty() or segment.length_px <= 0.0:
			errors.append("段落必须有名称且长度大于零")
		for hazard in segment.hazards:
			if hazard == null:
				errors.append("机关资源不能为空")
				continue
			if not _valid_placement(hazard.offset_x, hazard.cable_side, segment.length_px):
				errors.append("%s：机关位置或侧别无效" % segment.title)
			if hazard.size.x <= 0.0 or hazard.size.y <= 0.0:
				errors.append("%s：机关尺寸必须大于零" % segment.title)
			threats.append({"x": segment_start + hazard.offset_x, "side": hazard.cable_side, "width": hazard.size.x})
		for pickup in segment.pickups:
			if pickup == null:
				errors.append("影晶资源不能为空")
				continue
			if not _valid_placement(pickup.offset_x, pickup.cable_side, segment.length_px):
				errors.append("%s：影晶位置或侧别无效" % segment.title)
			pickups.append({"x": segment_start + pickup.offset_x, "data": pickup})
		for enemy in segment.enemies:
			if enemy == null:
				errors.append("敌人资源不能为空")
				continue
			var enemy_errors := enemy.get_validation_errors(recommended_speed)
			for error in enemy_errors:
				errors.append("%s：%s" % [segment.title, error])
			if not _valid_placement(enemy.offset_x, enemy.cable_side, segment.length_px) or enemy.health <= 0:
				errors.append("%s：敌人位置、侧别或生命值无效" % segment.title)
			if enemy.enemy_type == "sentry":
				threats.append({"x": segment_start + enemy.offset_x, "side": enemy.cable_side, "width": 36.0})
			if enemy.enemy_type == "shooter" and enemy_errors.is_empty() and recommended_speed > 0.0:
				for threat in enemy.get_projectile_threats(recommended_speed, rope_y):
					var contact_x: float = segment_start + enemy.offset_x + threat.offset
					threats.append({"x": contact_x, "side": threat.side, "width": 52.0})
		segment_start += segment.length_px
	threats.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.x < b.x)
	for index in range(1, threats.size()):
		var previous: Dictionary = threats[index - 1]
		var current: Dictionary = threats[index]
		if previous.side == current.side:
			continue
		var free_distance: float = current.x - previous.x - (previous.width + current.width) * 0.5 - player_half_width * 2.0
		if free_distance < recommended_speed * minimum_flip_window:
			errors.append("X=%.0f：上下危险物之间没有足够的翻绳窗口" % current.x)
	for pickup in pickups:
		for threat in threats:
			if pickup.data.cable_side != threat.side:
				continue
			var clearance: float = threat.width * 0.5 + player_half_width + pickup_clearance
			if absf(pickup.x - threat.x) < clearance:
				errors.append("X=%.0f：影晶离同侧危险物太近" % pickup.x)
	return errors

func _valid_placement(offset_x: float, side: String, length: float) -> bool:
	return offset_x >= 0.0 and offset_x < length and side in ["top", "bottom"]
