extends Node2D

@export var start_at_boss := false
@export var force_touch_controls := false

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
@onready var feedback: RunFeedback = $Player/Feedback

var _elapsed_time := 0.0
var _finished := false
var run_result: RunResult
var feedback_menu: PanelContainer
var feedback_button: Button
var _feedback_checks: Dictionary = {}
var run_loadout: RunLoadout
var weapon_text: Label
var weapon_hint: Label
var weapon_fill: ColorRect
var character_details: PanelContainer
var _details_was_paused := false
var _transitioning := false
var _completion_recorded := false
var save_status: Label
var save_retry: Button
var touch_controls: TouchControls
var resume_button: Button
var character_details_button: Button
var _feedback_was_paused := false
var _feedback_paused_run := false
var painted_progress: ProgressRail

func _enter_tree() -> void:
	add_to_group("run_sessions")
	if run_loadout == null:
		run_loadout = RunNavigation.take_pending(scene_file_path)
	if run_loadout == null:
		run_loadout = PlayerProfile.current().resolve(($Player as PlayerController).character)
	else:
		run_loadout = run_loadout.copy()
	$Player.run_loadout = run_loadout
	$Player.character = run_loadout.character

func _ready() -> void:
	PaintedTheme.apply_font($UI/HUD)
	_ensure_input_map()
	feedback.bind_player(player)
	_setup_feedback_controls()
	if not player.configuration_errors.is_empty():
		_show_result("角色配置无效", "请检查角色主动和被动资源，详细原因见调试输出。")
		return
	_setup_equipment_controls()
	painted_progress = PaintedHUD.install(self)
	_setup_touch_controls()
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
		for shooter in level.shooters:
			shooter.cancel()
		player.global_position.x = level.data.get_finish_x() - 65.0
		(player.get_node("Camera2D") as Camera2D).reset_smoothing()
	_update_status()

func _process(delta: float) -> void:
	_sync_touch_controls()
	if not get_tree().paused and not _finished:
		_elapsed_time += delta
		_update_status()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("touch_preview"):
		TouchControls.preview_enabled = not TouchControls.preview_enabled
		_sync_touch_controls()
		_layout_ui()
		return
	if event.is_action_pressed("character_details"):
		_toggle_character_details()
		return
	if event.is_action_pressed("pause") and is_instance_valid(character_details) and character_details.visible:
		_toggle_character_details()
		return
	if event.is_action_pressed("feedback_settings"):
		feedback_menu.visible = not feedback_menu.visible
		_sync_touch_controls()
		return
	if event.is_action_pressed("mute"):
		_on_feedback_setting(not FeedbackSettings.sound_enabled, "sound")
		return
	if event.is_action_pressed("restart"):
		_restart_run()
		return
	if event.is_action_pressed("pause") and not _finished:
		_toggle_pause()

func _toggle_pause() -> void:
	if _finished:
		return
	if feedback_menu.visible:
		feedback_menu.hide()
		return
	if character_details.visible:
		_toggle_character_details()
		return
	_raise_modal_layers()
	get_tree().paused = not get_tree().paused
	result_dimmer.visible = get_tree().paused
	result_overlay.visible = get_tree().paused
	if get_tree().paused:
		result_title.text = "已暂停"
		result_body.text = "点击继续返回挑战\n也可重试或返回角色与武器准备页。" if touch_controls.enabled else "按 Esc 继续\n按 R / Enter 重新开始"
	_sync_touch_controls()

func _ensure_input_map() -> void:
	_add_key_action("jump", [KEY_SPACE, KEY_UP, KEY_W])
	_add_key_action("drop", [KEY_DOWN, KEY_S])
	_add_key_action("dash", [KEY_SHIFT])
	if InputMap.has_action("attack"):
		InputMap.erase_action("attack")
	_add_key_action("skill", [KEY_K])
	_add_key_action("weapon", [KEY_J])
	_add_key_action("character_details", [KEY_C])
	_add_key_action("pause", [KEY_ESCAPE])
	_add_key_action("restart", [KEY_R, KEY_ENTER, KEY_KP_ENTER])
	_add_key_action("feedback_settings", [KEY_F2])
	_add_key_action("mute", [KEY_M])
	_add_key_action("touch_preview", [KEY_F3])

func _setup_touch_controls() -> void:
	touch_controls = PaintedTouchControls.new()
	touch_controls.name = "TouchControls"
	touch_controls.player = player
	touch_controls.combat = combat
	touch_controls.pause_requested.connect(_toggle_pause)
	$UI.add_child(touch_controls)
	get_viewport().size_changed.connect(_layout_ui)
	_sync_touch_controls()
	_layout_ui()

func _sync_touch_controls() -> void:
	if not is_instance_valid(touch_controls):
		return
	touch_controls.enabled = force_touch_controls or TouchControls.is_requested()
	touch_controls.blocked = character_details.visible or feedback_menu.visible
	touch_controls.finished = _finished
	touch_controls.sync_state()
	resume_button.visible = get_tree().paused and not _finished and not character_details.visible

func _layout_ui() -> void:
	var touch := is_instance_valid(touch_controls) and touch_controls.enabled
	ScreenLayout.configure_window(get_viewport(), touch)
	ScreenLayout.fit_control($UI/HUD, ScreenLayout.safe_rect(get_viewport()))
	segment_hint.position = Vector2(44, 354 if touch else 656)
	segment_hint.add_theme_font_size_override("font_size", 16 if touch else 18)
	feedback_menu.position = Vector2(472, 186) if touch else Vector2(900, 404)

func _notification(what: int) -> void:
	if what in [NOTIFICATION_APPLICATION_FOCUS_OUT, NOTIFICATION_WM_WINDOW_FOCUS_OUT, NOTIFICATION_APPLICATION_PAUSED] and is_instance_valid(touch_controls):
		touch_controls.release_all()
		if touch_controls.enabled and player.active and not get_tree().paused and not _finished:
			_toggle_pause()

func _setup_feedback_controls() -> void:
	feedback_button = Button.new()
	feedback_button.text = "设置 F2"
	feedback_button.position = Vector2(1136.0, 114.0)
	feedback_button.size = Vector2(100.0, 32.0)
	feedback_button.z_index = 140
	feedback_button.focus_mode = Control.FOCUS_NONE
	$UI/HUD.add_child(feedback_button)
	PaintedTheme.style_button(feedback_button)
	var panel := FeedbackSettingsPanel.new()
	panel.profile = PlayerProfile.current()
	panel.feedback = feedback
	feedback_menu = panel
	feedback_menu.z_index = 130
	feedback_menu.mouse_filter = Control.MOUSE_FILTER_STOP
	feedback_menu.position = Vector2(900.0, 404.0)
	feedback_menu.hide()
	$UI/HUD.add_child(feedback_menu)
	feedback_menu.visibility_changed.connect(_on_feedback_visibility_changed)
	_feedback_checks = panel.checks
	feedback_button.pressed.connect(func() -> void:
		feedback_menu.visible = not feedback_menu.visible
		_sync_touch_controls()
	)
	_sync_feedback_controls()

func _on_feedback_visibility_changed() -> void:
	if _transitioning or not is_inside_tree():
		return
	if feedback_menu.visible:
		_feedback_was_paused = get_tree().paused
		_feedback_paused_run = _feedback_was_paused or (is_instance_valid(touch_controls) and touch_controls.enabled)
		if _feedback_paused_run:
			_raise_modal_layers()
			feedback_menu.move_to_front()
			if is_instance_valid(feedback_button):
				feedback_button.move_to_front()
			if is_instance_valid(character_details_button):
				character_details_button.move_to_front()
			get_tree().paused = true
			result_dimmer.show()
			result_overlay.hide()
	elif not feedback_menu.visible and _feedback_paused_run:
		_feedback_paused_run = false
		get_tree().paused = _feedback_was_paused or _finished or character_details.visible
		_raise_modal_layers()
		result_dimmer.visible = get_tree().paused
		result_overlay.visible = get_tree().paused and not character_details.visible
	_sync_touch_controls()

func _on_feedback_setting(enabled: bool, setting: String) -> void:
	(feedback_menu as FeedbackSettingsPanel).set_setting(enabled, setting)

func _sync_feedback_controls() -> void:
	(feedback_menu as FeedbackSettingsPanel).sync_settings()

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
	combat.bind_boss(boss)
	boss_panel.show()
	segment_title.text = "%s · 首领  %s" % ["首领练习" if start_at_boss else level.data.title, boss.data.display_name]
	segment_hint.text = "翻绳躲避并接住三刃球自动反击 · J 武器 · K 忍术 · 核心变金时伤害更高。"
	_update_status()

func _on_finish_reached() -> void:
	if _finished:
		return
	player.stop()
	run_result = _calculate_result()
	feedback.finish(true)
	_update_status()
	progress_fill.size.x = progress_fill.get_parent().size.x
	progress_label.text = ("首领练习" if start_at_boss else ("关卡进度" if level.boss_data != null else "终点进度")) + "  100%"
	var boss_practice := start_at_boss and is_instance_valid(level.boss)
	var body := "评级 %s    总分 %d\n用时 %.1f 秒    受击 %d 次\n影晶 %d / %d    击破 %d\n最高连击 %d" % [run_result.rank, run_result.score, run_result.time_seconds, run_result.damage_count, run_result.collectible_count, run_result.collectible_total, run_result.kills, run_result.max_combo]
	if is_instance_valid(level.boss):
		body += "\n首领：%s · 已击破" % level.boss.data.display_name
		body += "\n伤害：武器 %d · 忍术 %d · 飞镖 %d" % [combat.damage_by_source[&"weapon"], combat.damage_by_source[&"skill"], combat.damage_by_source[&"pickup"]]
	if boss_practice:
		body = "首领：%s · 已击破\n用时 %.1f 秒    受击 %d 次\n练习完成，可重试熟悉其他躲法" % [level.boss.data.display_name, run_result.time_seconds, run_result.damage_count]
		body += "\n%s · 武器 %d / 忍术 %d / 飞镖 %d" % [run_loadout.weapon.display_name, combat.damage_by_source[&"weapon"], combat.damage_by_source[&"skill"], combat.damage_by_source[&"pickup"]]
	if not _completion_recorded:
		_completion_recorded = true
		PlayerProfile.current().record_completion(level.data.level_id, get_run_mode(), run_result)
	_show_result("%s · 完成" % ("首领练习" if boss_practice else level.data.title), body)
	_update_save_status()

func get_run_mode() -> StringName:
	if start_at_boss:
		return &"boss_practice"
	return &"full" if level.boss_data != null else &"parkour_practice"

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
	_raise_modal_layers()
	result_dimmer.visible = true
	result_overlay.visible = true
	get_tree().paused = true
	_sync_touch_controls()

func _restart_run() -> void:
	if _transitioning:
		return
	_transitioning = true
	player.stop()
	if RunNavigation.launch(get_tree(), scene_file_path, run_loadout) != OK:
		_transitioning = false

func _return_to_setup() -> void:
	if _transitioning:
		return
	_transitioning = true
	player.stop()
	if RunNavigation.return_to_setup(get_tree()) != OK:
		_transitioning = false

func _setup_equipment_controls() -> void:
	character_details_button = _hud_button($UI/HUD, "角色 / 武器 C", Rect2(880, 114, 230, 32), _toggle_character_details)
	character_details_button.z_index = 140
	# Keep the full HUD above the boss volley's highest lane (y=396).
	$UI/HUD/CharacterPanel.size.y = 72.0
	character_text.position.y = 2.0
	character_text.size.y = 26.0
	passive_text.position.y = 28.0
	passive_text.size.y = 22.0
	combat_text.position.y = 50.0
	combat_text.size.y = 20.0
	combat_text.add_theme_font_size_override("font_size", 14)
	$UI/HUD/SkillPanel.position.y = 236.0
	$UI/HUD/SkillPanel.size.y = 76.0
	skill_text.position.y = 2.0
	skill_text.size.y = 30.0
	skill_text.add_theme_font_size_override("font_size", 20)
	protection_text.position.y = 32.0
	protection_text.size.y = 22.0
	protection_text.add_theme_font_size_override("font_size", 14)
	$UI/HUD/SkillPanel/CooldownBack.position.y = 64.0
	$UI/HUD/SkillPanel/CooldownBack.size.y = 4.0
	skill_fill.size.y = 4.0
	var panel := ColorRect.new()
	panel.position = Vector2(880, 324)
	panel.size = Vector2(356, 60)
	panel.color = Color(0.067, 0.094, 0.149, 0.94)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	$UI/HUD.add_child(panel)
	PaintedTheme.decorate_panel(panel)
	var icon := WeaponPreview.new()
	icon.weapon = run_loadout.weapon
	icon.icon_only = true
	icon.position = Vector2(8, 6)
	icon.size = Vector2(40, 40)
	icon.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(icon)
	weapon_text = _hud_label(panel, Rect2(54, 2, 294, 28), 18)
	weapon_hint = _hud_label(panel, Rect2(54, 31, 294, 22), 14)
	var back := ColorRect.new()
	back.position = Vector2(18, 54)
	back.size = Vector2(320, 4)
	back.color = Color("233142")
	back.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(back)
	weapon_fill = ColorRect.new()
	weapon_fill.size = back.size
	weapon_fill.color = Color("d8b56a")
	weapon_fill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	back.add_child(weapon_fill)
	combat_feedback.position = Vector2(60, 318)
	combat_feedback.size = Vector2(720, 28)
	character_details = PanelContainer.new()
	character_details.position = Vector2(320, 160)
	character_details.size = Vector2(640, 400)
	character_details.z_index = 120
	character_details.mouse_filter = Control.MOUSE_FILTER_STOP
	var style := StyleBoxFlat.new()
	style.bg_color = Color("111827")
	style.border_color = Color("d8b56a")
	style.set_border_width_all(2)
	character_details.add_theme_stylebox_override("panel", style)
	$UI/HUD.add_child(character_details)
	var content := Control.new()
	content.custom_minimum_size = Vector2(636, 396)
	content.mouse_filter = Control.MOUSE_FILTER_STOP
	character_details.add_child(content)
	var title := _hud_label(content, Rect2(32, 24, 570, 42), 28)
	title.text = "%s · 本局装备" % player.character.display_name
	title.modulate = Color("d8b56a")
	var body := _hud_label(content, Rect2(32, 86, 570, 212), 20)
	var skill := run_loadout.weapon.skill
	body.text = "K  %s · 冷却 %.0f 秒 / 无敌 %.0f 秒\n被动  %s\n\nJ  %s · 冷却 %.0f 秒\n%d 枚 × %d 首领战基础伤害 · 无无敌\n本局装备固定，返回准备页可更换。" % [player.character.active_skill.display_name, player.character.active_skill.cooldown_seconds, player.character.active_skill.invulnerability_seconds, player.character.passive.display_name, run_loadout.weapon.display_name, skill.cooldown_seconds, skill.projectile_count, skill.boss_damage]
	_hud_button(content, "继续 / 关闭 C", Rect2(32, 324, 228, 44), _toggle_character_details)
	_hud_button(content, "结束本局并返回准备", Rect2(280, 324, 324, 44), _return_to_setup)
	character_details.hide()
	result_overlay.position = Vector2(320, 160)
	result_overlay.size = Vector2(640, 400)
	result_title.position = Vector2(32, 24)
	result_title.size = Vector2(576, 50)
	result_body.position = Vector2(32, 84)
	result_body.size = Vector2(576, 220)
	save_status = _hud_label(result_overlay, Rect2(32, 304, 400, 23), 15)
	save_retry = _hud_button(result_overlay, "重试保存", Rect2(440, 294, 168, 30), PlayerProfile.current().save_profile)
	save_retry.hide()
	PlayerProfile.current().save_status_changed.connect(_update_save_status)
	$UI/HUD/ResultOverlay/RetryHint.hide()
	_hud_button(result_overlay, "重试 R / Enter", Rect2(32, 330, 272, 44), _restart_run)
	_hud_button(result_overlay, "角色与武器", Rect2(328, 330, 280, 44), _return_to_setup)
	resume_button = _hud_button(result_overlay, "继续挑战", Rect2(440, 24, 168, 44), _toggle_pause)
	resume_button.hide()
	_update_save_status()

func _update_save_status() -> void:
	if not is_instance_valid(save_status):
		return
	var profile := PlayerProfile.current()
	save_status.text = "暂未保存，可重试" if profile.save_pending else ("成绩已保存" if _completion_recorded else "")
	save_retry.visible = profile.save_pending

func _toggle_character_details() -> void:
	if not is_instance_valid(character_details):
		return
	if feedback_menu.visible:
		feedback_menu.hide()
	if character_details.visible:
		character_details.hide()
		get_tree().paused = _details_was_paused
		result_dimmer.visible = _details_was_paused
		result_overlay.visible = _details_was_paused
	else:
		_details_was_paused = get_tree().paused
		get_tree().paused = true
		result_dimmer.show()
		result_overlay.hide()
		character_details.show()
		character_details.move_to_front()
	_sync_touch_controls()

func _raise_modal_layers() -> void:
	result_dimmer.move_to_front()
	result_overlay.move_to_front()

func _hud_button(parent: Node, text: String, rect: Rect2, callback: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.position = rect.position
	button.size = rect.size
	button.focus_mode = Control.FOCUS_NONE
	button.add_theme_font_size_override("font_size", 18)
	PaintedTheme.style_button(button)
	parent.add_child(button)
	button.pressed.connect(callback)
	return button

func _hud_label(parent: Node, rect: Rect2, font_size: int) -> Label:
	var label := Label.new()
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label

func _update_status() -> void:
	if not is_instance_valid(player) or player.tuning == null:
		return
	var progress := clampf(inverse_lerp(level.data.start_x, level.data.get_finish_x(), player.global_position.x), 0.0, 1.0)
	if level.boss_data != null:
		progress *= 0.0 if start_at_boss else 0.75
		if is_instance_valid(level.boss):
			progress += (1.0 if start_at_boss else 0.25) * (1.0 - float(level.boss.health) / float(level.boss.data.max_health))
	progress_fill.size.x = progress_fill.get_parent().size.x * progress
	if is_instance_valid(painted_progress):
		painted_progress.progress = progress
	var progress_title := "首领练习" if start_at_boss else ("关卡进度" if level.boss_data != null else "终点进度")
	progress_label.text = "%s  %d%%" % [progress_title, roundi(progress * 100.0)]
	status_text.text = "生命 %d / %d    影晶 %d / %d    时间 %.1fs    %s" % [
		player.health, player.tuning.max_health, player.crystals, level.pickup_positions.size(), _elapsed_time, player.get_rope_side_name()
	]
	hint_text.text = "左侧跳跃 / 翻绳 · 右侧影步 / 武器 / 忍术 · 顶部暂停" if is_instance_valid(touch_controls) and touch_controls.enabled else "↑ / Space：上翻或跳跃 · ↓：下翻 / 保持下侧 · Shift：影步 · Esc：暂停 · R：重来"
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
	var weapon_remaining := combat.weapon.cooldown_remaining
	var weapon_state := "就绪" if weapon_remaining <= 0.00001 else "%.1fs" % weapon_remaining
	if not is_instance_valid(level.boss):
		weapon_state = "首领战启用"
	elif not level.boss.is_in_combat():
		weapon_state = "等待交战" if level.boss.alive else "已击破"
	weapon_text.text = "J  %s · %s" % [run_loadout.weapon.display_name, weapon_state]
	weapon_text.modulate = Color("d8b56a") if combat.is_weapon_ready() else Color("91a1ad")
	weapon_hint.text = "%d 枚 × %d 伤害 · 冷却 %.0fs · 无无敌" % [run_loadout.weapon.skill.projectile_count, run_loadout.weapon.skill.boss_damage, run_loadout.weapon.skill.cooldown_seconds]
	weapon_fill.size.x = 320.0 * clampf(1.0 - weapon_remaining / run_loadout.weapon.skill.cooldown_seconds, 0.0, 1.0)
	if is_instance_valid(level.boss):
		var boss := level.boss
		boss_name.text = "%s%s · %d / %d" % [boss.data.display_name, " · 半血强化" if boss.enraged else "", boss.health, boss.data.max_health]
		boss_hint.text = boss.get_hint()
		boss_hint.modulate = Color("f0c36d") if boss.is_vulnerable() else Color("dde7e7")
		boss_health_fill.color = Color("f08b68") if boss.enraged else Color("b24b4b")
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
