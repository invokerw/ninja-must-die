extends Node2D

@export var start_at_boss := false
@export var force_touch_controls := false
@export var greybox_character: CharacterData

@onready var player: PlayerController = $Player
@onready var combat: RunnerCombat = $Player/Combat
@onready var level: RopeLevelController = $Level
@onready var battle_hud: UIBattleHUD = $UI/HUD
@onready var result_overlay: UIRunPanel = $UI/HUD/ResultOverlay
@onready var result_dimmer: ColorRect = $UI/HUD/ResultDimmer
@onready var result_title: Label = $UI/HUD/ResultOverlay/ResultTitle
@onready var result_body: Label = $UI/HUD/ResultOverlay/ResultBody
@onready var threat_text: Label = battle_hud.threat.label
@onready var progress_label: Label = battle_hud.progress_label
@onready var segment_title: Label = battle_hud.segment_title
@onready var segment_hint: Label = battle_hud.segment_hint
@onready var boss_panel: UIBossStatus = battle_hud.boss
@onready var boss_name: Label = battle_hud.boss.title
@onready var boss_hint: Label = battle_hud.boss.phase_label
@onready var feedback: RunFeedback = $Player/Feedback

var _elapsed_time := 0.0
var _finished := false
var run_result: RunResult
var feedback_menu: PanelContainer
var feedback_button: Button
var _feedback_checks: Dictionary = {}
var run_loadout: RunLoadout
var _transitioning := false
var _completion_recorded := false
var save_status: Label
var save_retry: Button
var touch_controls: TouchControls
var resume_button: Button
var _feedback_was_paused := false
var _feedback_paused_run := false
var run_mode_override: StringName = &""
var selected_level_id: StringName = &""
var run_id := ""
var rewards_button: Button
var _result_stats := ""
var _reward_details := ""
var reward_notice: Label

func _enter_tree() -> void:
	run_id = Crypto.new().generate_random_bytes(16).hex_encode()
	add_to_group("run_sessions")
	var pending_level_id := RunNavigation.take_pending_level(scene_file_path)
	selected_level_id = pending_level_id
	run_mode_override = RunNavigation.take_pending_mode(scene_file_path)
	if not pending_level_id.is_empty():
		var level_entry := LevelCatalog.get_level(pending_level_id)
		var selected_data := LevelCatalog.get_data(pending_level_id)
		if selected_data != null:
			$Level.data = selected_data
		var boss_path: String = level_entry.get("boss_data_path", "")
		$Level.boss_data = load(boss_path) as BossEncounterData if not boss_path.is_empty() else null
	if run_loadout == null:
		run_loadout = RunNavigation.take_pending(scene_file_path)
	if run_loadout == null:
		run_loadout = PlayerProfile.current().resolve(greybox_character)
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
	battle_hud.pause_requested.connect(_toggle_pause)
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
	if get_run_mode() == &"full" and not PlayerProfile.current().can_start_formal_run():
		_show_result("请先保存奖励", PlayerProfile.current().last_error)
		_update_save_status()
		return
	if get_run_mode() == &"full":
		var profile := PlayerProfile.current()
		if not profile.consume_selected_item(run_id):
			_show_result("补给无法出战", profile.last_error)
			_update_save_status()
			return
		run_loadout.item_snapshot = run_loadout.item_snapshot.duplicate(true)
		run_loadout.item_snapshot.erase("consumed_item_id")
		var consumed: String = profile.economy_state().get("economy_ledger", {}).get("consumptions", {}).get(run_id, "")
		if not consumed.is_empty():
			run_loadout.item_snapshot["consumed_item_id"] = consumed
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
	if event.is_action_pressed("feedback_settings"):
		_toggle_feedback_menu()
		return
	if event.is_action_pressed("mute"):
		_on_feedback_setting(not FeedbackSettings.sound_enabled, "sound")
		return
	if event.is_action_pressed("restart"):
		if feedback_menu.visible or (result_overlay.visible and event is InputEventKey and event.keycode in [KEY_ENTER, KEY_KP_ENTER]):
			return
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
	_raise_modal_layers()
	get_tree().paused = not get_tree().paused
	result_dimmer.visible = get_tree().paused
	if get_tree().paused:
		result_overlay.set_pause_mode(true)
		result_overlay.loadout_label.text = _loadout_summary()
		result_title.text = "已暂停 · 技能说明"
		result_body.text = _pause_body_text()
		_update_save_status()
	result_overlay.visible = get_tree().paused
	_sync_touch_controls()

func _loadout_summary() -> String:
	if run_loadout == null or run_loadout.character == null or run_loadout.weapon == null:
		return "本局配置无效"
	var scroll_name := "未装备秘卷"
	var scroll_id := StringName(run_loadout.item_snapshot.get("selected_scroll_id", ""))
	if EconomyService.ITEMS.has(scroll_id):
		scroll_name = EconomyService.ITEMS[scroll_id].name
	var supply := StringName(run_loadout.item_snapshot.get("consumed_item_id", ""))
	var supply_name: String = EconomyService.ITEMS[supply].name if EconomyService.ITEMS.has(supply) else "未消耗补给"
	return "%s · %s · %s · %s" % [run_loadout.character.display_name, run_loadout.weapon.display_name, scroll_name, supply_name]

func _ability_description_text() -> String:
	var character := player.character
	var active := character.active_skill
	var lines := PackedStringArray()
	lines.append("K  %s：%s" % [active.display_name, active.description()])
	lines.append("冷却 %.0f 秒 · 释放后保护 %.0f 秒" % [active.cooldown_seconds, active.invulnerability_seconds])
	lines.append("身法  %s：%s" % [character.mobility.display_name, character.mobility.description])
	if run_loadout != null and run_loadout.weapon != null and run_loadout.weapon.skill != null:
		var weapon := run_loadout.weapon
		var weapon_skill := weapon.skill
		lines.append("J  %s：%s" % [weapon.display_name, weapon.description])
		lines.append("冷却 %.0f 秒 · %d 枚 × %d 首领基础伤害" % [weapon_skill.cooldown_seconds, weapon_skill.projectile_count, weapon_skill.boss_damage])
	return "\n".join(lines)

func _pause_body_text() -> String:
	var controls := "点击继续返回挑战" if is_instance_valid(touch_controls) and touch_controls.enabled else "按 Esc 继续"
	return "%s\n%s" % [_ability_description_text(), controls]

func _ensure_input_map() -> void:
	_add_key_action("jump", [KEY_SPACE, KEY_UP, KEY_W])
	_add_key_action("drop", [KEY_DOWN, KEY_S])
	_add_key_action("mobility", [KEY_SHIFT])
	_add_key_action("dash", [KEY_SHIFT])
	if InputMap.has_action("attack"):
		InputMap.erase_action("attack")
	_add_key_action("skill", [KEY_K])
	_add_key_action("weapon", [KEY_J])
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
	touch_controls.blocked = feedback_menu.visible
	touch_controls.finished = _finished
	touch_controls.sync_state()
	battle_hud.pause_button.visible = not touch_controls.enabled and not _finished and not get_tree().paused and not feedback_menu.visible
	resume_button.visible = get_tree().paused and not _finished

func _layout_ui() -> void:
	var touch := is_instance_valid(touch_controls) and touch_controls.enabled
	ScreenLayout.configure_window(get_viewport(), touch)
	ScreenLayout.fit_control($UI/HUD, ScreenLayout.safe_rect(get_viewport()))
	_layout_dimmer()

func _layout_dimmer() -> void:
	var inverse := ($UI/HUD as Control).get_global_transform_with_canvas().affine_inverse()
	var bounds := get_viewport().get_visible_rect()
	result_dimmer.set_anchors_preset(Control.PRESET_TOP_LEFT)
	result_dimmer.position = inverse * bounds.position
	result_dimmer.size = inverse.basis_xform(bounds.size)

func _notification(what: int) -> void:
	if what in [NOTIFICATION_APPLICATION_FOCUS_OUT, NOTIFICATION_WM_WINDOW_FOCUS_OUT, NOTIFICATION_APPLICATION_PAUSED] and is_instance_valid(touch_controls):
		touch_controls.release_all()
		if touch_controls.enabled and player.active and not get_tree().paused and not _finished:
			_toggle_pause()

func _setup_feedback_controls() -> void:
	result_overlay.bind_labels(result_title, result_body)
	feedback_button = result_overlay.settings_button
	resume_button = result_overlay.resume_button
	save_status = result_overlay.save_status
	save_retry = result_overlay.save_button
	rewards_button = result_overlay.rewards_button
	result_dimmer.color = UITokens.MODAL_DIMMER
	result_overlay.resume_requested.connect(_toggle_pause)
	result_overlay.retry_requested.connect(_restart_run)
	result_overlay.setup_requested.connect(_return_to_setup)
	result_overlay.settings_requested.connect(_toggle_feedback_menu)
	result_overlay.save_requested.connect(PlayerProfile.current().save_profile)
	result_overlay.rewards_requested.connect(func() -> void:
		var showing_details := result_body.text == _reward_details
		result_body.text = _result_stats if showing_details else _reward_details
		rewards_button.text = "奖励明细" if showing_details else "返回成绩"
		result_overlay.reset_scroll()
	)
	PlayerProfile.current().save_status_changed.connect(_update_save_status)
	reward_notice = battle_hud.notice
	reward_notice.text = "奖励未保存，请返回准备页重试保存"
	reward_notice.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
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
	_sync_feedback_controls()
	_update_save_status()

func _toggle_feedback_menu() -> void:
	if _finished and not get_tree().paused:
		return
	if feedback_menu.visible:
		feedback_menu.hide()
		return
	if not get_tree().paused:
		_toggle_pause()
	feedback_menu.show()
	_sync_touch_controls()

func _on_feedback_visibility_changed() -> void:
	if _transitioning or not is_inside_tree():
		return
	if feedback_menu.visible:
		_feedback_was_paused = get_tree().paused
		_feedback_paused_run = _feedback_was_paused or (is_instance_valid(touch_controls) and touch_controls.enabled)
		if _feedback_paused_run:
			_raise_modal_layers()
			feedback_menu.move_to_front()
			get_tree().paused = true
			result_dimmer.show()
			result_overlay.hide()
	elif not feedback_menu.visible and _feedback_paused_run:
		_feedback_paused_run = false
		get_tree().paused = _feedback_was_paused or _finished
		_raise_modal_layers()
		result_dimmer.visible = get_tree().paused
		result_overlay.visible = get_tree().paused
		if result_overlay.visible:
			feedback_button.grab_focus()
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
	run_result.completed = true
	feedback.finish(true)
	_update_status()
	battle_hud.progress.progress = 1.0
	progress_label.text = ("首领练习" if start_at_boss else ("关卡进度" if level.boss_data != null else "终点进度")) + "  100%"
	var boss_practice := start_at_boss and is_instance_valid(level.boss)
	if not _completion_recorded:
		_completion_recorded = true
		PlayerProfile.current().record_completion(level.data.level_id, get_run_mode(), run_result)
	var body := "评级 %s    总分 %d\n用时 %.1f 秒    受击 %d 次\n影晶 %d / %d    击破 %d\n最高连击 %d" % [run_result.rank, run_result.score, run_result.time_seconds, run_result.damage_count, run_result.collectible_count, run_result.collectible_total, run_result.kills, run_result.max_combo]
	if get_run_mode() == &"full":
		var record := PlayerProfile.current().history.get_record(level.data.level_id, &"full")
		body = "本局 %d 星 · 历史 %d 星 · %s\n分数 %d / 3000 · 影晶 %d / %d · 受击 %d 次\n用时 %.1f 秒 · 击破 %d · 最高连击 %d" % [run_result.stars, record.get("best_stars", run_result.stars), "无伤印" if run_result.flawless else "本局未获无伤印", run_result.score, run_result.collectible_count, run_result.collectible_total, run_result.damage_count, run_result.time_seconds, run_result.kills, run_result.max_combo]
	if is_instance_valid(level.boss):
		body += "\n首领：%s · 已击破" % level.boss.data.display_name
		body += "\n伤害：武器 %d · 忍术 %d · 飞镖 %d" % [combat.damage_by_source[&"weapon"], combat.damage_by_source[&"skill"], combat.damage_by_source[&"pickup"]]
	if boss_practice:
		body = "首领：%s · 已击破\n用时 %.1f 秒    受击 %d 次\n练习完成，可重试熟悉其他躲法" % [level.boss.data.display_name, run_result.time_seconds, run_result.damage_count]
		body += "\n%s · 武器 %d / 忍术 %d / 飞镖 %d" % [run_loadout.weapon.display_name, combat.damage_by_source[&"weapon"], combat.damage_by_source[&"skill"], combat.damage_by_source[&"pickup"]]
	var summary := PlayerProfile.current().reward_summary(run_id)
	if not summary.is_empty():
		body += "\n" + ResultRewards.line(summary)
	_show_result("%s · 完成" % ("首领练习" if boss_practice else level.data.title), body)
	if get_run_mode() == &"full":
		result_overlay.set_rating(run_result.stars, run_result.flawless, run_result.score)
	if not summary.is_empty():
		result_body.tooltip_text = ResultRewards.breakdown(summary)
		_result_stats = body
		_reward_details = ResultRewards.details(summary)
		rewards_button.show()
		result_overlay.reward_summary.text = "铜钱 +%d · 余额 %d" % [summary.total, summary.balance]
		result_overlay.reward_summary.show()
	_update_save_status()

func get_run_mode() -> StringName:
	if not run_mode_override.is_empty():
		return run_mode_override
	if start_at_boss:
		return &"boss_practice"
	return &"full" if level.boss_data != null else &"parkour_practice"

func _calculate_result() -> RunResult:
	var result := RunResult.calculate(_elapsed_time, level.get_nominal_seconds(), player.damage_count, player.crystals, level.pickup_positions.size(), combat.kills, combat.max_combo)
	result.capture_context(level.data.level_id, get_run_mode(), run_id, run_loadout)
	if get_run_mode() == &"full":
		result.apply_formal_rules()
	return result

func _get_rank() -> String:
	return _calculate_result().rank

func _show_result(title: String, body: String) -> void:
	_finished = true
	if player.active:
		player.stop()
	result_title.text = title
	result_overlay.set_pause_mode(false)
	result_overlay.loadout_label.text = _loadout_summary()
	result_body.text = body
	_update_save_status()
	_raise_modal_layers()
	result_dimmer.visible = true
	result_overlay.visible = true
	get_tree().paused = true
	_sync_touch_controls()

func _restart_run() -> void:
	if _transitioning or feedback_menu.visible:
		return
	_transitioning = true
	player.stop()
	var error: Error
	if not selected_level_id.is_empty():
		error = RunNavigation.launch_level(get_tree(), scene_file_path, run_loadout, selected_level_id)
	else:
		error = RunNavigation.launch(get_tree(), scene_file_path, run_loadout)
	if error != OK:
		_transitioning = false

func _return_to_setup() -> void:
	if _transitioning or feedback_menu.visible:
		return
	_transitioning = true
	player.stop()
	if RunNavigation.return_to_setup(get_tree()) != OK:
		_transitioning = false

func _update_save_status() -> void:
	if not is_instance_valid(save_status):
		return
	var profile := PlayerProfile.current()
	save_status.text = "暂未保存，可重试" if profile.save_pending else ("成绩已保存" if _completion_recorded else "")
	if not profile.pending_transaction.is_empty():
		save_status.text = "奖励仅在内存中，请先重试保存"
	reward_notice.visible = not profile.pending_transaction.is_empty() and not profile.last_error.is_empty()
	result_overlay.save_badge.visible = profile.save_pending or profile.is_read_only() or _completion_recorded
	result_overlay.save_badge.set_status(&"readonly" if profile.is_read_only() else (&"pending" if profile.save_pending else &"saved"))
	if profile.is_read_only():
		save_status.text = "存档版本较新，本次更改不会覆盖原档案。"
	save_retry.visible = profile.save_pending and not profile.is_read_only()
	var formal_blocked := get_run_mode() == &"full" and (profile.is_read_only() or (not profile.pending_transaction.is_empty() and not profile.last_error.is_empty()))
	result_overlay.retry_button.set_available(not formal_blocked, "请先保存奖励，再开始新的正式挑战。" if formal_blocked else "")
	result_overlay.refresh_action_focus()

func _raise_modal_layers() -> void:
	result_dimmer.move_to_front()
	result_overlay.move_to_front()

func _hud_label(parent: Node, rect: Rect2, font_size: int) -> Label:
	var label := Label.new()
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label

func _update_status() -> void:
	if not is_instance_valid(player) or player.tuning == null or player.mobility == null:
		return
	battle_hud.render(BattleHUDPresenter.snapshot(player, combat, level, _elapsed_time, start_at_boss, run_result != null and run_result.completed))

func _update_threat_hint() -> void:
	var value := BattleHUDPresenter.threat_snapshot(player, level)
	battle_hud.threat.set_notice(value.text, value.side, value.urgent, value.active)
