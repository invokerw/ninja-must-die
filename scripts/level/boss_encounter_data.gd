class_name BossEncounterData
extends Resource

@export var display_name := "断桥机关鸢"
@export var max_health := 180
@export var nominal_seconds := 40.0
@export var entrance_seconds := 1.5
@export var windup_seconds := 1.2
@export var active_seconds := 0.45
@export var recovery_seconds := 2.6
@export var death_seconds := 0.65
@export var forward_offset := 500.0
@export var beam_height := 48.0
@export var shuriken_balls_enabled := true
@export var volley: RopeEnemyData

func get_validation_errors(run_speed: float) -> PackedStringArray:
	var errors := PackedStringArray()
	if display_name.is_empty() or max_health <= 0:
		errors.append("首领须有名称且生命大于零")
	if not is_finite(nominal_seconds) or nominal_seconds <= 0.0:
		errors.append("首领评级基准时长须大于零")
	if not is_finite(entrance_seconds) or entrance_seconds < 0.5:
		errors.append("首领登场至少保留 0.5 秒")
	if not is_finite(windup_seconds) or windup_seconds < 0.9:
		errors.append("首领攻击至少保留 0.9 秒预警")
	if not is_finite(active_seconds) or active_seconds <= 0.0:
		errors.append("首领攻击持续时间须大于零")
	if not is_finite(recovery_seconds) or recovery_seconds < 0.5:
		errors.append("首领须保留至少 0.5 秒弱点窗口")
	if not is_finite(death_seconds) or death_seconds <= 0.0:
		errors.append("首领退场时间须大于零")
	if not is_finite(forward_offset) or forward_offset < 200.0 or forward_offset > 560.0:
		errors.append("首领须保持在前方 200～560 px 的技能范围内")
	if not is_finite(beam_height) or beam_height < 16.0 or beam_height > 56.0:
		errors.append("横扫高度须在 16～56 px 之间，为另一侧保留空间")
	if volley == null or volley.enemy_type != "shooter":
		errors.append("首领须配置右侧齐射")
	else:
		errors.append_array(volley.get_validation_errors(run_speed))
		if not is_equal_approx(volley.windup_seconds, windup_seconds):
			errors.append("首领齐射与首领动作须使用相同的预警时长")
	return errors
