extends Node2D

@export var start_at_boss := false

@onready var player: PlayerController = $Player
@onready var combat: RunnerCombat = $Player/Combat
@onready var level: RopeLevelController = $Level
@onready var status_text: Label = $UI/HUD/StatusText
@onready var hint_text: Label = $UI/HUD/HintText
@onready var result_overlay: ColorRect = $UI/HUD/ResultOverlay
@onready var result_dimmer: ColorRect = $UI/HUD/ResultDimmer
@onready var result_title: Label = $UI/HUD/ResultOverlay/ResultTitle
@onready var result_body: Label = $UI/HUD/ResultOverlay/ResultBody
@onready var threat_text: Label = $UI/HUD/ThreatText
@onready var progress_fill: ColorRect = $UI/HUD/ProgressBack/ProgressFill
@onready var progress_label: Label = $UI/HUD/ProgressLabel
@onready var segment_title: Label = $UI/HUD/SegmentTitle
@onready var segment_hint: Label = $UI/HUD/SegmentHint
@onready var character_text: Label = $UI/HUD/CharacterPanel/CharacterText
@onready var passive_text: Label = $UI/HUD/CharacterPanel/PassiveText
@onready var combat_text: Label = $UI/HUD/CharacterPanel/CombatText
@onready var combat_feedback: Label = $UI/HUD/CombatFeedback
@onready var skill_text: Label = $UI/HUD/SkillPanel/SkillText
@onready var protection_text: Label = $UI/HUD/SkillPanel/ProtectionText
@onready var skill_fill: ColorRect = $UI/HUD/SkillPanel/CooldownBack/CooldownFill
@onready var boss_panel: ColorRect = $UI/HUD/BossPanel
@onready var boss_name: Label = $UI/HUD/BossPanel/BossName
@onready var boss_hint: Label = $UI/HUD/BossPanel/BossHint
@onready var boss_health_fill: ColorRect = $UI/HUD/BossPanel/HealthBack/HealthFill

var _elapsed_time := 0.0
var _finished := false
var run_result: RunResult

func _ready() -> void:
	_ensure_input_map()
	if not player.configuration_errors.is_empty():
		_show_result("角色配置无效", "请检查角色主动和被动资源，详细原因见调试输出。")
		return
	level.segment_changed.connect(_on_segment_changed)
	level.finish_reached.connect(_on_finish_reached)
	level.boss_started.connect(_on_boss_started)
	player.health_changed.connect(_on_health_changed)
	player.crystal_collected.connect(_on_crystal_collected)
	player.rope_side_changed.connect(_on_rope_side_changed)
	player.run_failed.connect(_on_run_failed)
	combat.changed.connect(_update_status)
	if not level.build(player):
		_show_result("关卡无法加载", "请检查关卡资源，详细原因见调试输出。")
		return
	player.active = true
	if start_at_boss and level.boss_data != null:
		player.global_position.x = level.data.get_finish_x() - 65.0
		(player.get_node("Camera2D") as Camera2D).reset_smoothing()
	_update_status()

func _process(delta: float) -> void:
	if not get_tree().paused and not _finished:
		_elapsed_time += delta
		_update_status()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("restart"):
		_restart_run()
		return
	if event.is_action_pressed("pause") and not _finished:
		get_tree().paused = not get_tree().paused
		result_dimmer.visible = get_tree().paused
		if get_tree().paused:
			result_title.text = "已暂停"
			result_body.text = "按 Esc 继续\n按 R / Enter 重新开始"
			result_overlay.visible = true
		else:
			result_overlay.visible = false

func _ensure_input_map() -> void:
	_add_key_action("jump", [KEY_SPACE, KEY_UP, KEY_W])
	_add_key_action("drop", [KEY_DOWN, KEY_S])
	_add_key_action("dash", [KEY_SHIFT])
	if InputMap.has_action("attack"):
		InputMap.erase_action("attack")
	_add_key_action("skill", [KEY_K])
	_add_key_action("pause", [KEY_ESCAPE])
	_add_key_action("restart", [KEY_R, KEY_ENTER, KEY_KP_ENTER])

func _add_key_action(action_name: StringName, keycodes: Array) -> void:
	if not InputMap.has_action(action_name):
		InputMap.add_action(action_name)
	for keycode in keycodes:
		var already_bound := false
		for existing in InputMap.action_get_events(action_name):
			if existing is InputEventKey and existing.physical_keycode == keycode:
				already_bound = true
				break
		if already_bound:
			continue
		var event := InputEventKey.new()
		event.physical_keycode = keycode
		InputMap.action_add_event(action_name, event)

func _on_segment_changed(index: int, segment: RopeSegmentData) -> void:
	segment_title.text = "%s  ·  %d / %d  %s" % [level.data.title, index + 1, level.data.segments.size(), segment.title]
	segment_hint.text = segment.hint

func _on_health_changed(_current: int, _maximum: int) -> void:
	_update_status()

func _on_crystal_collected() -> void:
	_update_status()

func _on_rope_side_changed(_side: int) -> void:
	_update_status()

func _on_run_failed(reason: String) -> void:
	var section := level.data.segments[level.active_segment].title
	if is_instance_valid(level.boss):
		section = level.boss.data.display_name
	_show_result("挑战失败", "%s · %s\n用时 %.1f 秒" % [section, reason, _elapsed_time])

func _on_boss_started(boss: RopeBoss) -> void:
	boss_panel.show()
	segment_title.text = "%s · 首领  %s" % ["首领练习" if start_at_boss else level.data.title, boss.data.display_name]
	segment_hint.text = "上侧横扫往下翻，下侧横扫往上翻；齐射留意间隙，核心变金时按 K 攻击。"
	_update_status()

func _on_finish_reached() -> void:
	if _finished:
		return
	player.stop()
	run_result = _calculate_result()
	_update_status()
	progress_fill.size.x = progress_fill.get_parent().size.x
	progress_label.text = ("首领练习" if start_at_boss else ("关卡进度" if level.boss_data != null else "终点进度")) + "  100%"
	var boss_practice := start_at_boss and is_instance_valid(level.boss)
	var body := "评级 %s    总分 %d\n用时 %.1f 秒    受击 %d 次\n影晶 %d / %d    击破 %d\n最高连击 %d" % [run_result.rank, run_result.score, run_result.time_seconds, run_result.damage_count, run_result.collectible_count, run_result.collectible_total, run_result.kills, run_result.max_combo]
	if is_instance_valid(level.boss):
		body += "\n首领：%s · 已击破" % level.boss.data.display_name
	if boss_practice:
		body = "首领：%s · 已击破\n用时 %.1f 秒    受击 %d 次\n练习完成，可重试熟悉其他躲法" % [level.boss.data.display_name, run_result.time_seconds, run_result.damage_count]
	_show_result("%s · 完成" % ("首领练习" if boss_practice else level.data.title), body)

func _calculate_result() -> RunResult:
	return RunResult.calculate(_elapsed_time, level.get_nominal_seconds(), player.damage_count, player.crystals, level.pickup_positions.size(), combat.kills, combat.max_combo)

func _get_rank() -> String:
	return _calculate_result().rank

func _show_result(title: String, body: String) -> void:
	_finished = true
	if player.active:
		player.stop()
	result_title.text = title
	result_body.text = body
	result_dimmer.visible = true
	result_overlay.visible = true
	get_tree().paused = true

func _restart_run() -> void:
	get_tree().paused = false
	get_tree().reload_current_scene()

func _update_status() -> void:
	if not is_instance_valid(player) or player.tuning == null:
		return
	var progress := clampf(inverse_lerp(level.data.start_x, level.data.get_finish_x(), player.global_position.x), 0.0, 1.0)
	if level.boss_data != null:
		progress *= 0.0 if start_at_boss else 0.75
		if is_instance_valid(level.boss):
			progress += (1.0 if start_at_boss else 0.25) * (1.0 - float(level.boss.health) / float(level.boss.data.max_health))
	progress_fill.size.x = progress_fill.get_parent().size.x * progress
	var progress_title := "首领练习" if start_at_boss else ("关卡进度" if level.boss_data != null else "终点进度")
	progress_label.text = "%s  %d%%" % [progress_title, roundi(progress * 100.0)]
	status_text.text = "生命 %d / %d    影晶 %d / %d    时间 %.1fs    %s" % [
		player.health, player.tuning.max_health, player.crystals, level.pickup_positions.size(), _elapsed_time, player.get_rope_side_name()
	]
	hint_text.text = "↑ / Space：上翻或跳跃 · ↓：下翻 / 保持下侧 · Shift：影步 · Esc：暂停 · R：重来"
	var skill := player.character.active_skill
	var remaining := combat.skill_cooldown_remaining
	var cooldown_text := "就绪"
	if remaining > 0.00001:
		cooldown_text = "%.1fs" % remaining if remaining <= 2.0 else "%ds" % ceili(remaining)
	skill_text.text = "K  %s  ·  %s" % [skill.display_name, cooldown_text]
	skill_text.modulate = Color("d8b56a") if remaining <= 0.00001 else Color("91a1ad")
	skill_fill.size.x = skill_fill.get_parent().size.x * clampf(1.0 - remaining / skill.cooldown_seconds, 0.0, 1.0)
	protection_text.text = "月光庇护  %.1fs" % player.skill_immunity_remaining if player.skill_immunity_remaining > 0.00001 else "冷却 %.0fs · 释放后无敌 %.0fs" % [skill.cooldown_seconds, skill.invulnerability_seconds]
	protection_text.modulate = Color("d8b56a") if player.skill_immunity_remaining > 0.00001 else Color("91a1ad")
	character_text.text = "%s · 被动 %s" % [player.character.display_name, player.character.passive.display_name]
	passive_text.text = "空中追加跳跃  %d / %d" % [player.jumps_remaining, player.max_jump_count - 1]
	combat_text.text = "击破 %d  ·  连击 %d  ·  最高 %d" % [combat.kills, combat.combo, combat.max_combo]
	combat_feedback.text = combat.feedback
	if is_instance_valid(level.boss):
		var boss := level.boss
		boss_name.text = "%s · %d / %d" % [boss.data.display_name, boss.health, boss.data.max_health]
		boss_hint.text = boss.get_hint()
		boss_hint.modulate = Color("f0c36d") if boss.is_vulnerable() else Color("dde7e7")
		boss_health_fill.size.x = boss_health_fill.get_parent().size.x * float(boss.health) / float(boss.data.max_health)
	_update_threat_hint()

func _update_threat_hint() -> void:
	var nearest_seconds := INF
	var message := "前方：安全段"
	var nearest_side := ""
	var speed := player.tuning.dash_speed if player.dash_remaining > 0.0 else player.tuning.run_speed
	for hazard in level.hazards:
		if not is_instance_valid(hazard):
			continue
		var distance := hazard.global_position.x - player.global_position.x
		if distance >= -48.0 and distance <= hazard.warning_distance:
			var seconds := maxf(distance, 0.0) / maxf(speed, 1.0)
			if seconds < nearest_seconds:
				nearest_seconds = seconds
				nearest_side = hazard.cable_side
				var side := "上侧" if hazard.cable_side == "top" else "下侧"
				message = "前方预警  %s机关 · %.1fs" % [side, seconds]
	for enemy in level.enemies:
		if not is_instance_valid(enemy) or not enemy.alive:
			continue
		var distance := enemy.global_position.x - player.global_position.x
		if distance < -36.0 or distance > enemy.warning_distance:
			continue
		var seconds := maxf(distance, 0.0) / maxf(speed, 1.0)
		var side := "上侧" if enemy.cable_side == "top" else "下侧"
		var enemy_message := "%s哨兵 · 翻绳躲避 / K 月蚀斩" % side
		if seconds < nearest_seconds:
			nearest_seconds = seconds
			nearest_side = enemy.cable_side
			message = enemy_message
	for shooter in level.shooters:
		if shooter.attack_state != ScreenShooter.AttackState.WINDUP:
			continue
		var seconds := shooter.windup_remaining + shooter.get_flight_seconds()
		if seconds < nearest_seconds or (shooter.cable_side == nearest_side and seconds <= nearest_seconds + 0.7):
			nearest_seconds = minf(nearest_seconds, seconds)
			nearest_side = shooter.cable_side
			message = "右侧齐射 · %d 枚 · 蓄力 %.1fs" % [shooter.volley_count, shooter.windup_remaining]
	if is_instance_valid(level.projectile_root):
		for projectile: EnemyProjectile in level.projectile_root.get_children():
			var distance := projectile.global_position.x - player.global_position.x
			if projectile.spent or distance < -26.0:
				continue
			var seconds := maxf(distance, 0.0) / maxf(speed - projectile.velocity.x, 1.0)
			var cable_side := projectile.cable_side
			if cable_side.is_empty():
				cable_side = "top" if projectile.global_position.y < player.rope_y else "bottom"
			if seconds < nearest_seconds or (cable_side == nearest_side and seconds <= nearest_seconds + 0.25):
				nearest_seconds = minf(nearest_seconds, seconds)
				nearest_side = cable_side
				message = "平行飞弹 · %.1fs · 留意间隙" % seconds
	threat_text.text = message
	threat_text.modulate = Color("91a1ad") if nearest_seconds == INF else (Color("f08b68") if nearest_seconds <= 0.8 else Color("f0c36d"))
	if is_instance_valid(level.boss) and level.boss.state in [RopeBoss.State.WINDUP, RopeBoss.State.ACTIVE]:
		threat_text.text = level.boss.get_hint()
		threat_text.modulate = Color("f0c36d") if level.boss.state == RopeBoss.State.WINDUP else Color("f08b68")
