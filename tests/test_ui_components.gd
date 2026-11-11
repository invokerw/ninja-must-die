extends SceneTree

var _failures := 0
var _activations := 0
var _cancellations := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var scope := TestProfileScope.new("ui-components")
	await _test_busy_and_toggle()
	await _test_modal()
	await _test_read_only_settings()
	await _test_tabs_and_cards()
	await _test_preparation()
	await _test_run_panels()
	await _test_battle_hud()
	_test_design_contract()
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-dir="):
			await _capture(argument.trim_prefix("--capture-dir="))
		elif argument.begins_with("--capture-preparation-dir="):
			await _capture_preparation(argument.trim_prefix("--capture-preparation-dir="))
		elif argument.begins_with("--capture-run-dir="):
			await _capture_run_panels(argument.trim_prefix("--capture-run-dir="))
		elif argument.begins_with("--capture-hud-dir="):
			await _capture_battle_hud(argument.trim_prefix("--capture-hud-dir="))
	scope.close()
	if _failures == 0:
		print("UI_COMPONENTS_PASS (common controls, preparation, pause/results, battle HUD health/phases/quota/items/keyboard, token contract, safe layouts)")
	quit(0 if _failures == 0 else 1)

func _test_busy_and_toggle() -> void:
	var host := Control.new()
	host.size = ScreenLayout.DESIGN_SIZE
	root.add_child(host)
	var button := UIActionButton.new()
	button.text = "提交"
	button.size = UITokens.PRIMARY_SIZE
	button.pressed.connect(func() -> void: _activations += 1)
	host.add_child(button)
	await _frames()
	button.set_busy(true)
	await _tap(button)
	_check(_activations == 0, "Busy controls must ignore real touch input")
	button.set_available(false, "余额不足")
	button.set_busy(false)
	await _tap(button)
	_check(_activations == 0 and button.disabled, "An availability change while busy must survive completion")
	button.set_available(true)
	await _tap(button)
	_check(_activations == 1, "A fresh touch after busy completion activates once")
	var toggle := UIToggleRow.new()
	toggle.text = "画面震动"
	toggle.position = Vector2(0, 100)
	toggle.size = Vector2(360, 48)
	host.add_child(toggle)
	await _tap(toggle)
	_check(toggle.button_pressed, "A toggle row operates with touch through native Button semantics")
	toggle.set_pressed_no_signal(false)
	_check(not toggle.button_pressed, "External preferences can synchronize a toggle without another action")
	host.free()

func _test_modal() -> void:
	var host := Control.new()
	host.size = ScreenLayout.DESIGN_SIZE
	root.add_child(host)
	var outside := UIActionButton.new()
	outside.text = "底层按钮"
	outside.size = UITokens.PRIMARY_SIZE
	outside.pressed.connect(func() -> void: _activations += 1)
	host.add_child(outside)
	var modal := UIConfirmDialog.new()
	modal.configure("确认操作", "长说明\n".repeat(24), "确认", outside)
	modal.cancelled.connect(func() -> void:
		_cancellations += 1
		modal.get_parent().remove_child(modal)
		modal.queue_free()
	)
	host.add_child(modal)
	await _frames()
	_check(root.gui_get_focus_owner() == modal.cancel_button, "A consequential dialog starts with cancel focused")
	var before := _activations
	await _tap(outside)
	_check(_activations == before, "The modal dimmer must intercept underlying touches")
	await _key(KEY_TAB)
	_check(root.gui_get_focus_owner() == modal.confirm_button, "Tab remains inside the modal")
	await _key(KEY_TAB, true)
	_check(root.gui_get_focus_owner() == modal.cancel_button, "Shift-Tab remains inside the modal")
	_check(modal.body_label.size.y > modal._body_scroll.size.y, "Long content scrolls without displacing the action footer")
	_check(modal.panel.get_global_rect().encloses(modal.confirm_button.get_global_rect()), "Confirm actions remain inside the modal")
	ScreenLayout.fit_control(host, Rect2(60, 24, 1480, 648))
	await _frames()
	_check(Rect2(60, 24, 1480, 648).encloses(modal.panel.get_global_rect()), "The same dialog fits a transformed safe frame")
	await _key(KEY_ESCAPE)
	_check(_cancellations == 1 and root.gui_get_focus_owner() == outside, "Escape cancels once and restores the originating focus")
	host.free()

func _test_design_contract() -> void:
	# The design artifact is a test reference only; exported runtime code does not load it.
	var design: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://art/concepts/ui/common/v01/design_tokens.json"))
	_check(Color(design.colors.accent) == UITokens.ACCENT and Color(design.colors.danger) == UITokens.DANGER, "Shared accent and danger match the reviewed design contract")
	_check(Vector2(design.geometry.touch_target_min[0], design.geometry.touch_target_min[1]) == UITokens.TOUCH_MIN, "Shared hit targets match the reviewed design minimum")

func _test_read_only_settings() -> void:
	var scope := TestProfileScope.new("ui-components-readonly")
	scope.profile._document.version = ProfileStore.VERSION + 1
	scope.profile.save_pending = true
	var host := Control.new()
	host.size = ScreenLayout.DESIGN_SIZE
	root.add_child(host)
	var panel := FeedbackSettingsPanel.new()
	panel.profile = scope.profile
	host.add_child(panel)
	await _frames()
	_check(panel.save_badge.status == &"readonly" and not panel.retry_button.visible, "Newer-version settings retain a read-only state without a misleading retry-write action")
	host.free()
	await _frames()
	scope.close()

func _test_tabs_and_cards() -> void:
	var host := Control.new()
	host.size = ScreenLayout.DESIGN_SIZE
	root.add_child(host)
	var tabs := UITabBar.new()
	tabs.size = Vector2(700, 52)
	tabs.set_entries([{"id": &"first", "title": "第一项"}, {"id": &"second", "title": "第二项"}], &"first")
	host.add_child(tabs)
	await _tap(tabs.buttons[&"second"])
	_check(tabs.selected_id == &"second" and tabs.buttons[&"second"].button_pressed, "A real tap selects a tab and marks the same native button")
	await _tap(tabs.buttons[&"second"])
	_check(tabs.buttons[&"second"].button_pressed and not tabs.buttons[&"first"].button_pressed, "Repeated selection cannot leave a tab group without an active item")
	var card := UISelectCard.new()
	card.configure(&"example", "未解锁项目", "完成前置挑战后开放")
	card.position = Vector2(0, 100)
	card.size = Vector2(400, 132)
	card.set_state(true, &"locked")
	host.add_child(card)
	card.pressed.connect(func() -> void: _activations += 1)
	var before := _activations
	await _tap(card)
	_check(_activations == before + 1 and card.selected and card.state_chip.status == &"locked", "Locked cards remain inspectable without losing their independent lock state")
	host.free()

func _test_preparation() -> void:
	var scope := TestProfileScope.new("ui-preparation")
	scope.profile.save_profile()
	var setup = load(RunNavigation.SETUP_SCENE).instantiate()
	root.add_child(setup)
	await _frames()
	var original: UISelectCard = setup.weapon_buttons[&"crescent_wheel"]
	var alternative: UISelectCard = setup.weapon_buttons[&"star_lance"]
	for card: UISelectCard in [original, alternative]:
		_check(card.get_global_rect().encloses(card.artwork.get_global_rect()) and card.get_global_rect().encloses(card.state_chip.get_global_rect()), "Initial card images and badges remain inside their native card bounds")
	await _tap(alternative)
	_check(original.state_chip.status == &"equipped" and alternative.selected and alternative.state_chip.status == &"preview", "Preview and equipped status remain distinct across two actual weapon cards")
	_check(scope.profile.get_equipped_weapon(setup.character).weapon_id == &"crescent_wheel", "Card selection must not alter the run loadout")
	await _tap(setup.tabs.buttons[&"scrolls"])
	_check(setup.pages[&"scrolls"].visible and not setup.pages[&"weapons"].visible and setup.scroll_summary.body_label.text.contains("已解锁 0 本"), "Tabs show true empty ownership without fictional items")
	await _tap(setup.tabs.buttons[&"weapons"])
	_check(setup.selected_weapon.weapon_id == &"star_lance" and alternative.selected, "Returning to weapons preserves the preview")
	setup.tabs.buttons[&"scrolls"].grab_focus()
	await _key(KEY_ENTER)
	_check(setup.tabs.selected_id == &"scrolls", "Keyboard accept selects the focused native tab")
	setup.tabs.select(&"weapons")
	await _tap(setup.equip_button)
	_check(alternative.state_chip.status == &"equipped" and setup.equip_button.disabled, "Explicit equipment action updates the selected card and disables duplicate equip")
	_check(scope.profile.purchase(&"guard_charm") and scope.profile.select_item(&"guard_charm"), "Prepare a real owned supply for the summary")
	await _tap(setup.tabs.buttons[&"supplies"])
	_check(setup.supply_summary.title_label.text.contains("护身符") and setup.supply_summary.body_label.text.contains("库存 1"), "Supply tab reads actual selected inventory")
	var inventory := scope.profile.get_inventory(&"guard_charm")
	setup._show_records()
	await _frames()
	_check(setup.tabs.selected_id == &"records" and setup.pages[&"records"].visible and setup.history_labels[&"full"].text.contains("尚无"), "History entry selects the record tab and retains an honest empty state")
	_check(scope.profile.get_inventory(&"guard_charm") == inventory, "Viewing preparation tabs never consumes supplies")
	_check(_seed_formal_record(scope.profile), "Formal record fixture must include a valid loadout and run context")
	setup._refresh_profile()
	_check(setup.history_labels[&"full"].text.contains("最高 3 星") and setup.history_labels[&"full"].text.contains("最高分 2650"), "Preparation shows the actual formal star record rather than a legacy rank")
	var records := setup.pages[&"records"].get_child(0) as UIDetailPanel
	await _frames()
	records.scroll.scroll_vertical = 10000
	await _frames()
	_check(records.scroll.get_global_rect().encloses(setup.history_labels[&"parkour_practice"].get_global_rect()), "The last practice record remains reachable in the scrolling detail panel")
	setup.tabs.select(&"weapons")
	original.grab_focus()
	setup._toggle_settings()
	await _key(KEY_ENTER)
	_check(not setup.feedback_menu.visible and setup.selected_weapon.weapon_id == &"star_lance" and root.gui_get_focus_owner() == original, "Opening settings transfers accept to close and restores the original card without activating it")
	setup._toggle_settings()
	await _key(KEY_TAB)
	_check(root.gui_get_focus_owner() == setup.feedback_menu.checks["sound"], "Settings keyboard navigation remains inside the overlay")
	await _key(KEY_ESCAPE)
	_check(not setup.feedback_menu.visible and root.gui_get_focus_owner() == original, "Escape closes settings without changing the selected loadout")
	scope.profile._document.version = ProfileStore.VERSION + 1
	setup._refresh_profile()
	setup.tabs.select(&"weapons")
	await _tap(original)
	_check(setup.equip_button.disabled and not setup.save_retry.visible and setup.save_badge.status == &"readonly", "Read-only archives permit inspection while blocking equipment writes")
	setup.free()
	await _frames()
	scope.close()

func _capture_preparation(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "Preparation capture needs a graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Preparation screenshot directory must be writable")
	for state in ["initial", "preview", "equipped", "scrolls", "supplies", "records", "readonly", "save_failure", "safe", "settings"]:
		var scope := TestProfileScope.new("ui-preparation-capture")
		scope.profile.save_profile()
		FeedbackSettings.sound_enabled = false
		FeedbackSettings.particles_enabled = false
		var viewport := SubViewport.new()
		viewport.size = Vector2i(1600 if state == "safe" else 1280, 720)
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var setup = load(RunNavigation.SETUP_SCENE).instantiate()
		viewport.add_child(setup)
		if state in ["preview", "equipped", "save_failure", "readonly"]:
			setup._select_weapon(PlayerProfile.WEAPONS[&"star_lance"])
		if state == "equipped":
			setup._equip_selected()
		if state == "scrolls":
			scope.profile._reward_state.coins = 720
			scope.profile.purchase(&"light_scroll")
			scope.profile.select_scroll(&"light_scroll")
			setup.tabs.select(&"scrolls")
		if state == "supplies":
			scope.profile.purchase(&"guard_charm")
			scope.profile.select_item(&"guard_charm")
			setup.tabs.select(&"supplies")
		if state == "records":
			_check(_seed_formal_record(scope.profile), "Record capture must use a valid formal snapshot")
			setup._refresh_profile()
			setup._show_records()
		if state == "readonly":
			scope.profile._document.version = ProfileStore.VERSION + 1
			setup._refresh_profile()
		if state == "save_failure":
			ProfileStore.write_guard = func(stage: String) -> bool: return stage != "replace"
			setup._equip_selected()
			ProfileStore.write_guard = Callable()
		if state == "settings":
			setup.feedback_menu.show()
		var safe := Rect2(60, 24, 1480, 648) if state == "safe" else Rect2(Vector2.ZERO, viewport.size)
		ScreenLayout.fit_control(setup, safe)
		await _frames(5)
		await RenderingServer.frame_post_draw
		if setup.save_retry.visible:
			_check(not setup.save_retry.get_global_rect().intersects(setup.loadout_summary.get_global_rect()), "Save recovery actions must not cover the always-visible loadout summary")
		for node in setup.find_children("*", "", true, false):
			if (node is UIActionButton or node is UISelectCard) and node.is_visible_in_tree():
				_check(safe.encloses(node.get_global_rect()), "Preparation actions and cards fit the safe frame")
			if node is UISelectCard and node.is_visible_in_tree():
				_check(node.get_global_rect().encloses(node.state_chip.get_global_rect()), "A card badge must remain inside its actual card")
				_check(node.get_global_rect().encloses(node.artwork.get_global_rect()), "Artwork geometry must fit its actual card")
		var target := output.path_join("preparation_%s.png" % state)
		_check(viewport.get_texture().get_image().save_png(target) == OK, "Preparation screenshot saves successfully")
		print("PREPARATION_CAPTURE ", target)
		viewport.free()
		scope.close()

func _seed_formal_record(profile: PlayerProfile) -> bool:
	var result := RunResult.calculate(98.4, 60, 1, 40, 50, 5, 18)
	result.capture_context(LevelCatalog.FOG_RIDGE_ID, &"full", "ui-preparation-record", profile.resolve())
	result.apply_formal_rules()
	return profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", result)

func _test_run_panels() -> void:
	var scope := TestProfileScope.new("ui-run-panels")
	scope.profile.save_profile()
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	await _frames()
	main._toggle_pause()
	var panel: UIRunPanel = main.result_overlay
	_check(root.gui_get_focus_owner() == main.resume_button, "Pause starts with the safe resume action focused")
	_check(main.result_body.text.contains(main.run_loadout.weapon.display_name) and panel.loadout_label.text.contains(main.run_loadout.character.display_name), "Pause reads immutable run equipment and character")
	main._toggle_feedback_menu()
	await _frames()
	var restart := InputEventAction.new()
	restart.action = "restart"
	restart.pressed = true
	main._unhandled_input(restart)
	main._restart_run()
	_check(main.feedback_menu.visible and not main._transitioning and paused, "Settings reject both keyboard and direct retry while the child dialog owns input")
	await _key(KEY_ESCAPE)
	_check(paused and panel.visible and not main.feedback_menu.visible and root.gui_get_focus_owner() == main.feedback_button, "Escape closes only settings and restores pause focus")
	await _key(KEY_ENTER)
	_check(main.feedback_menu.visible and not main._transitioning, "Enter activates focused settings instead of the global restart shortcut")
	await _key(KEY_ESCAPE)
	await _key(KEY_TAB)
	_check(root.gui_get_focus_owner() == panel.retry_button, "Tab stays among currently visible pause actions")
	main.resume_button.grab_focus()
	await _key(KEY_ENTER)
	_check(not paused and not panel.visible and not main._transitioning and main.player.active, "Keyboard resume leaves the current run active without retrying")
	main._toggle_pause()
	main.result_body.text = "长说明用于滚动验证\n".repeat(35) + "最后一行"
	await _frames()
	_check(main.result_body.size.y > panel.body_scroll.size.y, "Long pause descriptions scroll inside the fixed body viewport")
	panel.body_scroll.scroll_vertical = 10000
	await _frames()
	_check(panel.body_scroll.scroll_vertical > 0 and panel.body_scroll.get_global_rect().end.y <= main.rewards_button.get_global_rect().position.y, "Scrolling descriptions never displace footer actions")
	main._toggle_pause()
	main.player.crystals = 40
	main.player.damage_count = 1
	main._elapsed_time = 98.4
	main._on_finish_reached()
	await _frames()
	_check(panel.stars.stars == 3 and panel.rating_label.text == "本局未获无伤印" and panel.score_label.text.contains("2650"), "Formal rating uses real stars and independent flawless status")
	_check(panel.reward_summary.visible and panel.reward_summary.text.contains(str(scope.profile.coins)), "Reward balance remains visible outside scrolling boss statistics")
	var coins := scope.profile.coins
	await _tap(main.rewards_button)
	_check(main.result_body.text.contains("本次奖励") and main.rewards_button.text == "返回成绩", "Reward details reuse the same scrolling content")
	await _tap(main.rewards_button)
	main._on_finish_reached()
	_check(scope.profile.coins == coins and main.result_body.text.contains("本局 3 星"), "Switching reward views and duplicate finish cannot grant another reward")
	for button in [panel.retry_button, panel.setup_button, panel.settings_button, panel.rewards_button, panel.save_button, panel.resume_button]:
		_check(button.size.x >= 48 and button.size.y >= 48, "Every run-panel action retains a touch target of at least 48 design pixels")
	scope.profile._document.version = ProfileStore.VERSION + 1
	scope.profile.save_pending = true
	panel.retry_button.grab_focus()
	main._update_save_status()
	_check(panel.save_badge.status == &"readonly" and not main.save_retry.visible and root.gui_get_focus_owner() == panel.setup_button, "Result panels keep newer archives read-only and move focus from unavailable retry to a valid action")
	paused = false
	main.free()
	scope.close()
	# A fresh scope verifies that the save retry commits only the existing draft.
	scope = TestProfileScope.new("ui-run-save-failure")
	scope.profile.save_profile()
	main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	ProfileStore.write_guard = func(stage: String) -> bool: return stage != "replace"
	main._elapsed_time = 98.4
	main.player.crystals = 50
	main._on_finish_reached()
	ProfileStore.write_guard = Callable()
	var failed_balance := scope.profile.coins
	_check(main.save_retry.visible and main.result_overlay.save_badge.status == &"pending" and main.result_overlay.retry_button.disabled, "A failed reward save exposes a persistent pending state and blocks another formal run")
	await _tap(main.save_retry)
	_check(not main.save_retry.visible and main.result_overlay.save_badge.status == &"saved" and not main.result_overlay.retry_button.disabled and scope.profile.coins == failed_balance, "Touch save retry commits the draft without recalculating rewards and restores formal retry")
	paused = false
	main.free()
	scope.close()

func _capture_run_panels(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "Run-panel capture requires a graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Run-panel capture directory is writable")
	for state in ["pause", "pause_wide", "pause_safe", "settings", "formal", "rewards", "save_failure", "failed", "practice", "boss_practice", "readonly"]:
		paused = false
		var scope := TestProfileScope.new("ui-run-capture")
		scope.profile.save_profile()
		FeedbackSettings.sound_enabled = false
		var viewport := SubViewport.new()
		viewport.size = Vector2i(1600 if state in ["pause_wide", "pause_safe"] else 1280, 720)
		viewport.world_2d = World2D.new()
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var path := "res://scenes/practice.tscn" if state == "practice" else ("res://scenes/boss_practice.tscn" if state == "boss_practice" else "res://scenes/main.tscn")
		var main = load(path).instantiate()
		# Enable touch after the fixture finishes so OS focus changes cannot pause
		# a scripted boss defeat while its viewport is being initialized.
		main.force_touch_controls = false
		viewport.add_child(main)
		main.set_process(false)
		main.player.set_physics_process(false)
		main.player.get_node("Camera2D").position_smoothing_enabled = false
		main.player.position.x = 1500
		main.player.crystals = 40
		main.player.damage_count = 1
		main._elapsed_time = 98.4
		if state == "boss_practice":
			main.player.crystals = 0
			main._elapsed_time = 33.0
		if state.begins_with("pause") or state == "settings":
			main.force_touch_controls = true
			main._sync_touch_controls()
			main._toggle_pause()
			if state == "settings":
				main._toggle_feedback_menu()
		elif state == "failed":
			main._on_run_failed("机关碰撞")
		else:
			if state == "save_failure":
				ProfileStore.write_guard = func(stage: String) -> bool: return stage != "replace"
			if state == "practice":
				main._on_finish_reached()
			else:
				main.player.position.x = main.level.data.get_finish_x() - 65.0
				main.player.set_physics_process(true)
				main.level._begin_boss()
				await _frames(3)
				main.level.boss.health = 24
				main.level.boss.state = RopeBoss.State.RECOVERY
				main.level.boss.remaining = 10.0
				_check(main.combat.try_skill(), "The capture skill must be ready")
				for frame in range(90):
					await _frames(1)
					if main._finished:
						break
				_check(main._finished, "Result capture must finish through a real boss defeat")
			ProfileStore.write_guard = Callable()
			if state == "rewards":
				main.rewards_button.pressed.emit()
			elif state == "readonly":
				scope.profile._document.version = ProfileStore.VERSION + 1
				main._update_save_status()
		main.force_touch_controls = true
		main._sync_touch_controls()
		await _frames(4)
		var safe := Rect2(60, 24, 1480, 648) if state == "pause_safe" else Rect2(Vector2.ZERO, viewport.size)
		ScreenLayout.fit_control(main.get_node("UI/HUD"), safe)
		main._layout_dimmer()
		await _frames(2)
		var panel: UIRunPanel = main.result_overlay
		_check(safe.encloses(panel.get_global_rect()), "Run panels fit each captured safe area")
		_check(main.result_dimmer.get_global_rect().encloses(viewport.get_visible_rect()), "Modal dimmers cover the full viewport outside the fitted safe frame")
		for child in panel.find_children("*", "Button", true, false):
			if child.is_visible_in_tree():
				_check(panel.get_global_rect().encloses(child.get_global_rect()), "Run-panel actions stay within the panel")
		await RenderingServer.frame_post_draw
		var target := output.path_join("run_%s.png" % state)
		_check(viewport.get_texture().get_image().save_png(target) == OK, "Run-panel screenshot saves successfully")
		print("RUN_PANEL_CAPTURE ", target)
		paused = false
		viewport.free()
		scope.close()

func _test_battle_hud() -> void:
	var scope := TestProfileScope.new("ui-battle-hud")
	scope.profile.save_profile()
	var main = load("res://scenes/practice.tscn").instantiate()
	root.add_child(main)
	main.set_process(false)
	main.player.set_physics_process(false)
	main._update_status()
	main._sync_touch_controls()
	var hud: UIBattleHUD = main.battle_hud
	var actions: Dictionary = main.touch_controls.action_views
	_check(hud.health_label.text == "3 / 3" and is_equal_approx(hud.health.ratio, 1), "Common health text and meter read actual runtime health")
	_check(not main.touch_controls.enabled and actions[&"skill"].visible and actions[&"skill"].key_hint.text == "K", "Keyboard mode retains visible live action feedback without enabling touch input")
	_check(hud.item.text.contains("未携带") and not hud.boss.visible, "Empty supply and no-boss states must stay honest")
	_check(hud.threat.label.size.x >= 240 and hud.portrait.size == Vector2(72, 72), "Threat text and portrait keep their requested geometry after entering the tree")
	var lance_region := WeaponArt.icon_region_for(&"star_lance")
	_check(lance_region.has_area() and lance_region.size.y < WeaponArt.LANCE.get_height() * 0.5 and lance_region.size.x > lance_region.size.y * 2, "Compact weapon icons omit transparent margins while preserving the lance silhouette")
	main.player.take_damage(2)
	main._update_status()
	_check(hud.health_label.text == "1 / 3" and is_equal_approx(hud.health.ratio, 1.0 / 3), "A real hit updates low-health text and meter without changing damage rules")
	main.combat.try_skill()
	main._sync_touch_controls()
	var cooldown: float = main.combat.skill_cooldown_remaining
	_check(actions[&"skill"].counter.text.contains("12") and actions[&"skill"].radial.ratio > 0.99 and not actions[&"skill"].state.available, "Cooldown seconds and arc read the same actual cooldown")
	main._toggle_pause()
	await _frames(3)
	_check(is_equal_approx(cooldown, main.combat.skill_cooldown_remaining) and not actions[&"skill"].visible, "Pause hides combat actions and freezes cooldown instead of ticking a UI timer")
	main._toggle_pause()
	main.free()
	paused = false
	main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	main.set_process(false)
	main.player.set_physics_process(false)
	main.level._begin_boss()
	main.level.boss.set_physics_process(false)
	var boss: RopeBoss = main.level.boss
	for spec in [[RopeBoss.State.ENTRANCE, &"entrance"], [RopeBoss.State.WINDUP, &"windup"], [RopeBoss.State.ACTIVE, &"attack"], [RopeBoss.State.RECOVERY, &"weak"]]:
		boss.state = spec[0]
		boss.remaining = 1.8
		main._update_status()
		_check(main.battle_hud.boss.phase == spec[1], "Boss phase presentation must be mutually exclusive and follow actual state")
	boss.enraged = true
	boss.health = 72
	main._update_status()
	_check(main.boss_name.text.contains("72 / 180") and main.boss_name.text.contains("半血强化") and main.boss_hint.text.contains("弱点"), "Enrage remains independent from the current weak phase")
	_check(main.battle_hud.progress.markers.size() == main.level.data.segments.size() + 1 and is_equal_approx(main.battle_hud.progress.markers[-2], 0.75), "Formal route checkpoints come from actual segments and the boss boundary")
	main.free()
	for character_id in [&"wind_scout", &"thunder_guard"]:
		main = load("res://scenes/practice.tscn").instantiate()
		main.run_loadout = RunLoadout.capture(CharacterRegistry.get_character(character_id), PlayerProfile.WEAPONS[&"crescent_wheel"])
		root.add_child(main)
		main.set_process(false)
		main.player.set_physics_process(false)
		main.player.on_rope = false
		main.player.jumps_remaining = 0
		main.player.velocity.y = 100
		var mobility: MobilityRuntime = main.player.mobility
		mobility.try_start(main.player._mobility_context())
		mobility.update_hold(true, main.player._mobility_context(), 0.4)
		main._sync_touch_controls()
		var view: UICombatAction = main.touch_controls.action_views[&"mobility"]
		_check(view.state.glyph == mobility.data.mobility_id and view.caption.text == mobility.data.display_name, "Each mobility action reads its own configured identity")
		if mobility.data.input_mode == MobilityData.InputMode.HOLD:
			_check(view.radial.quota and view.counter.text.contains("0.8") and is_equal_approx(view.radial.ratio, 2.0 / 3), "Glide air quota stays distinct from cooldown and reflects consumption")
		else:
			_check(not view.radial.quota and view.counter.text.contains("6") and view.radial.ratio > 0.99, "Burst cooldown uses the real six-second runtime")
		main.free()
	for item_id in [&"guard_charm", &"spring_potion"]:
		scope.profile._reward_state.coins = 1000
		_check(scope.profile.purchase(item_id) and scope.profile.select_item(item_id), "The HUD supply fixture uses real inventory and selection transactions")
		main = load("res://scenes/main.tscn").instantiate()
		root.add_child(main)
		main.set_process(false)
		main.player.set_physics_process(false)
		main._update_status()
		var balance := scope.profile.coins
		var stock := scope.profile.get_inventory(item_id)
		_check(main.battle_hud.item.status == &"carried" and main.battle_hud.item.text.contains("待触发"), "Only an actually consumed run supply appears as waiting")
		main.player.take_damage(1 if item_id == &"guard_charm" else 2)
		main._update_status()
		main._update_status()
		_check(main.battle_hud.item.status == &"used" and main.battle_hud.item.text.contains("已触发"), "Actual passive activation updates the persistent supply chip")
		_check(scope.profile.coins == balance and scope.profile.get_inventory(item_id) == stock, "Refreshing the HUD never consumes inventory or applies another transaction")
		main.free()
	scope.close()

func _capture_battle_hud(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "HUD capture requires a graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "HUD capture output is writable")
	for state in ["route_touch", "route_keyboard", "wide", "safe", "second_level", "low_health", "cooldown", "boss_entrance", "boss_windup", "boss_attack", "boss_weak", "boss_enraged", "glide_quota", "burst_cooldown", "guard_waiting", "guard_used", "potion_used"]:
		paused = false
		var scope := TestProfileScope.new("ui-battle-capture")
		scope.profile.save_profile()
		FeedbackSettings.sound_enabled = false
		var item_id: StringName = &"spring_potion" if state == "potion_used" else &"guard_charm"
		if state in ["guard_waiting", "guard_used", "potion_used"]:
			scope.profile._reward_state.coins = 1000
			scope.profile.purchase(item_id)
			scope.profile.select_item(item_id)
		var viewport := SubViewport.new()
		viewport.size = Vector2i(1600 if state in ["wide", "safe"] else 1280, 720)
		viewport.world_2d = World2D.new()
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var main = load("res://scenes/main.tscn").instantiate()
		if state == "second_level":
			main.get_node("Level").data = LevelCatalog.get_data(LevelCatalog.WIND_BAMBOO_ID)
			main.get_node("Level").boss_data = null
			main.run_mode_override = &"parkour_practice"
		if state in ["glide_quota", "burst_cooldown"]:
			main.greybox_character = CharacterRegistry.get_character(&"wind_scout" if state == "glide_quota" else &"thunder_guard")
		viewport.add_child(main)
		main.set_process(false)
		main.player.set_physics_process(false)
		main.player.position.x = 1500
		main.player.get_node("Camera2D").position_smoothing_enabled = false
		main.player.crystals = 24
		main._elapsed_time = 32.7
		if state == "low_health":
			main.player.take_damage(2)
		elif state == "cooldown":
			main.combat.skill_cooldown_remaining = 3.2
		elif state.begins_with("boss_"):
			main.player.position.x = main.level.data.get_finish_x() - 65
			main.level._begin_boss()
			var boss: RopeBoss = main.level.boss
			boss.set_physics_process(false)
			boss.state = {"boss_entrance": RopeBoss.State.ENTRANCE, "boss_windup": RopeBoss.State.WINDUP, "boss_attack": RopeBoss.State.ACTIVE, "boss_weak": RopeBoss.State.RECOVERY, "boss_enraged": RopeBoss.State.RECOVERY}[state]
			boss.remaining = 1.2 if state == "boss_windup" else 2.6
			boss.health = 72 if state == "boss_enraged" else 120
			boss.enraged = state == "boss_enraged"
		elif state in ["glide_quota", "burst_cooldown"]:
			main.player.on_rope = false
			main.player.jumps_remaining = 0
			main.player.velocity.y = 100
			main.player.mobility.try_start(main.player._mobility_context())
			main.player.mobility.update_hold(true, main.player._mobility_context(), 0.4)
		elif state in ["guard_used", "potion_used"]:
			main.player.take_damage(1 if state == "guard_used" else 2)
		main.force_touch_controls = state != "route_keyboard"
		main._sync_touch_controls()
		main._update_status()
		await _frames(3)
		var safe := Rect2(60, 24, 1480, 648) if state == "safe" else Rect2(Vector2.ZERO, viewport.size)
		ScreenLayout.fit_control(main.battle_hud, safe)
		main.touch_controls.safe_area_override = safe
		main.touch_controls.sync_state()
		main._layout_dimmer()
		await _frames(2)
		for action in TouchControls.ACTIONS:
			var view: UICombatAction = main.touch_controls.action_views[action]
			if view.visible:
				_check(safe.grow(0.1).encloses(view.get_global_rect()), "HUD action views stay in the same safe targets")
				_check(safe.grow(0.1).encloses(view.caption.get_global_rect()), "Action names remain inside the safe screen")
		_check(main.battle_hud.boss.get_global_rect().end.y < 360, "Boss status stays above the gameplay and highest volley lane")
		await RenderingServer.frame_post_draw
		var target := output.path_join("hud_%s.png" % state)
		_check(viewport.get_texture().get_image().save_png(target) == OK, "HUD screenshot saves successfully")
		print("BATTLE_HUD_CAPTURE ", target)
		paused = false
		viewport.free()
		scope.close()

func _capture(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "Component capture requires the graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Capture output must be writable")
	for spec in [[1280, "components"], [1280, "setup"], [1280, "shop"], [1280, "confirmation"], [1600, "safe"], [1280, "settings"], [1280, "settings_error"], [1280, "pause"], [1280, "hud"]]:
		paused = false
		var scope := TestProfileScope.new("ui-components-capture")
		scope.profile.save_profile()
		FeedbackSettings.sound_enabled = false
		FeedbackSettings.particles_enabled = false
		var viewport := SubViewport.new()
		viewport.size = Vector2i(spec[0], 720)
		viewport.world_2d = World2D.new()
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var screen: Node
		if spec[1] == "components":
			screen = _component_board()
			viewport.add_child(screen)
		elif spec[1] in ["shop", "confirmation", "safe"]:
			scope.profile._reward_state.coins = 720
			scope.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60, 60, 0, 50, 50, 0, 0))
			screen = load(RunNavigation.SHOP_SCENE).instantiate()
			viewport.add_child(screen)
			if spec[1] == "confirmation":
				screen._primary_action()
		elif spec[1] in ["pause", "hud"]:
			screen = load("res://scenes/main.tscn").instantiate()
			screen.force_touch_controls = true
			viewport.add_child(screen)
			screen._completion_recorded = true
			screen.set_process(false)
			screen.player.set_physics_process(false)
			screen.player.position.x = 1500
			screen.player.get_node("Camera2D").position_smoothing_enabled = false
			if spec[1] == "pause":
				screen._toggle_pause()
		else:
			screen = load(RunNavigation.SETUP_SCENE).instantiate()
			viewport.add_child(screen)
			if spec[1] in ["settings", "settings_error"]:
				screen.feedback_menu.show()
			if spec[1] == "settings_error":
				ProfileStore.write_guard = func(stage: String) -> bool: return stage != "replace"
				scope.profile.set_feedback_setting("shake", false)
				ProfileStore.write_guard = Callable()
		var safe := Rect2(60, 24, 1480, 648) if spec[1] == "safe" else Rect2(Vector2.ZERO, viewport.size)
		if screen is Control:
			ScreenLayout.fit_control(screen, safe)
		await _frames(4)
		await RenderingServer.frame_post_draw
		for node in screen.find_children("*", "", true, false):
			if (node is UIActionButton or node is UIToggleRow or node is UIStatusChip) and node.is_visible_in_tree():
				_check(safe.encloses(node.get_global_rect()), "Common controls must remain inside the safe frame")
		var target: String = output.path_join("%s_%s.png" % [spec[1], spec[0]])
		_check(viewport.get_texture().get_image().save_png(target) == OK, "A real component screenshot saves successfully")
		print("UI_COMPONENTS_CAPTURE ", target)
		paused = false
		viewport.free()
		scope.close()

func _component_board() -> Control:
	var host := Control.new()
	host.size = ScreenLayout.DESIGN_SIZE
	PaintedTheme.apply_font(host)
	var background := ColorRect.new()
	background.color = UITokens.INK
	background.size = ScreenLayout.DESIGN_SIZE
	host.add_child(background)
	_board_label(host, "月下墨金 · 通用控件首批", Rect2(48, 32, 1184, 50), 34)
	_board_label(host, "Godot 原生绘制 · 统一主题 / 按钮 / 面板 / 状态 / 开关 / 确认弹层", Rect2(48, 90, 1184, 32), 18)
	for index in range(4):
		var button := UIActionButton.new()
		button.variant = ["primary", "secondary", "quiet", "danger"][index]
		button.text = ["开始挑战", "进入练习", "查看详情", "放弃挑战"][index]
		button.position = Vector2(48 + index * 300, 156)
		button.size = Vector2(264, 56)
		host.add_child(button)
	for index in range(4):
		var button := UIActionButton.new()
		button.text = ["常态按钮", "余额不足", "正在保存", "键盘焦点"][index]
		button.position = Vector2(48 + index * 300, 240)
		button.size = Vector2(264, 56)
		host.add_child(button)
		if index == 1:
			button.set_available(false, "还差 60 铜钱")
		elif index == 2:
			button.set_busy(true)
		elif index == 3:
			button.ready.connect(button.grab_focus)
	for index in range(6):
		var chip := UIStatusChip.new()
		chip.set_status([&"selected", &"equipped", &"carried", &"pending", &"readonly", &"error"][index])
		chip.position = Vector2(48 + index * 200, 336)
		chip.size = Vector2(164, 36)
		host.add_child(chip)
	for index in range(2):
		var toggle := UIToggleRow.new()
		toggle.text = "音效" if index == 0 else "画面震动"
		toggle.position = Vector2(48 + index * 600, 412)
		toggle.size = Vector2(564, 48)
		toggle.set_pressed_no_signal(index == 0)
		host.add_child(toggle)
	var panel := Panel.new()
	panel.position = Vector2(48, 504)
	panel.size = Vector2(1164, 168)
	panel.add_theme_stylebox_override("panel", PaintedTheme.surface_style(true))
	host.add_child(panel)
	_board_label(panel, "通用面板与显示层", Rect2(24, 18, 1116, 36), 26)
	_board_label(panel, "生命、冷却、价格和保存状态从运行时读取；概念图不参与绘制。", Rect2(24, 70, 1116, 32), 20)
	_board_label(panel, "按钮忙碌时拦截重复触摸；确认弹层默认聚焦取消，关闭后恢复原焦点。", Rect2(24, 116, 1116, 28), 18)
	return host

func _board_label(parent: Node, caption: String, rect: Rect2, font_size: int) -> void:
	var label := Label.new()
	label.text = caption
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)

func _tap(button: Button) -> void:
	for pressed in [true, false]:
		var event := InputEventScreenTouch.new()
		event.index = 0
		event.position = button.get_global_transform_with_canvas() * (button.size * 0.5)
		event.pressed = pressed
		button.get_viewport().push_input(event, true)
		await _frames()

func _key(code: Key, shift: bool = false) -> void:
	for pressed in [true, false]:
		var event := InputEventKey.new()
		event.keycode = code
		event.pressed = pressed
		event.shift_pressed = shift
		root.push_input(event, true)
		await _frames()

func _frames(count: int = 2) -> void:
	for index in range(count):
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
