extends SceneTree

const SETUP := preload("res://scenes/ui/character_setup.tscn")
const LEVEL_SELECT := preload("res://scenes/ui/level_select.tscn")

var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var profile_scope := TestProfileScope.new("level_select")
	await _test_open_and_lock_state()
	await _test_unlocked_launch()
	await _test_return_and_story()
	await _test_read_only_state()
	await _test_journey_and_snapshot()
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-dir="):
			await _capture_states(argument.trim_prefix("--capture-dir="))
	if _failures == 0:
		print("LEVEL_SELECT_PASS (preparation entry, lock requirement, selected loadout, level data launch)")
	profile_scope.close()
	quit(0 if _failures == 0 else 1)

func _test_open_and_lock_state() -> void:
	var setup := SETUP.instantiate()
	root.add_child(setup)
	current_scene = setup
	await _frames(2)
	var button := _find_button(setup, "关卡选择")
	_check(button != null, "Preparation must expose the level selection entry")
	setup._open_level_select()
	await _frames(4)
	var select := current_scene as Control
	_check(select != null and select.scene_file_path == "res://scenes/ui/level_select.tscn", "Level selection must open from preparation")
	if select == null:
		return
	_check(select.level_buttons.size() == 2, "Chapter one map must list the first two catalog levels")
	_check(select.level_buttons[LevelCatalog.FOG_RIDGE_ID].unlocked and select.level_buttons[LevelCatalog.FOG_RIDGE_ID].selected, "The initial unlocked selection must use the common selected card")
	_check(not select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].unlocked, "The unavailable second card must show its locked state")
	await _tap_button(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID])
	_check(select.selected_level_id == LevelCatalog.WIND_BAMBOO_ID, "A real touch must select the second card")
	_check(select.start_button.disabled and select.practice_button.disabled, "The second level must disable start and practice until the first clear")
	_check(select.status.text.contains("雾岭断桥"), "The locked second level must show its concrete prerequisite")
	_check(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].selected, "The selected locked card must remain highlighted")
	_check(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].state_chip.status == &"locked", "The locked card must display its lock status")
	_check(not select.level_buttons[LevelCatalog.FOG_RIDGE_ID].selected and select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].selected and not select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].unlocked, "Selecting a locked card must clear the old highlight while keeping the locked status")
	_check(select.detail_record.text.contains("尚无纪录"), "Empty records must not display concept ratings")
	await _tap_button(select.start_button)
	_check(current_scene == select, "Touching a disabled action must not launch a locked level")
	await _tap_button(select.level_buttons[LevelCatalog.FOG_RIDGE_ID])
	_check(not select.start_button.disabled, "Returning to an unlocked card must restore actions")
	select.free()

func _test_unlocked_launch() -> void:
	var select := LEVEL_SELECT.instantiate()
	root.add_child(select)
	current_scene = select
	await _frames(2)
	select.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60.0, 60.0, 0, 50, 50, 0, 0))
	select._select_level(LevelCatalog.WIND_BAMBOO_ID)
	_check(not select.start_button.disabled and not select.practice_button.disabled, "The first clear must unlock the second level actions")
	_check(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].state_chip.status != &"locked", "Unlocking a level must clear the locked status")
	_check(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].unlocked and select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].selected, "The second unlocked selection must receive the common selection highlight")
	_check(select.level_buttons[LevelCatalog.FOG_RIDGE_ID].unlocked and not select.level_buttons[LevelCatalog.FOG_RIDGE_ID].selected, "The first unlocked card must become neutral when selecting the second")
	await _tap_button(select.level_buttons[LevelCatalog.FOG_RIDGE_ID])
	_check(select.level_buttons[LevelCatalog.FOG_RIDGE_ID].selected and select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].unlocked and not select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].selected, "Touching the first card must leave the second in its unlocked neutral state")
	_check(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID].state_chip.text == "已解锁", "Unlocked second card must not retain a locked badge")
	await _tap_button(select.level_buttons[LevelCatalog.WIND_BAMBOO_ID])
	select._start_level(true)
	await _frames(5)
	var run := current_scene as Node2D
	_check(run != null and run.get_node("Level").data.level_id == LevelCatalog.WIND_BAMBOO_ID, "Launching the second level must inject its catalog resource")
	_check(run != null and run.get_node("Level").boss_data == null, "The second level graybox must launch without the first level boss")
	_check(run != null and run.get_run_mode() == &"parkour_practice", "Practice launch must keep its isolated practice record bucket")
	if run != null:
		run.free()
	var formal_select := LEVEL_SELECT.instantiate()
	root.add_child(formal_select)
	current_scene = formal_select
	await _frames(2)
	formal_select.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60.0, 60.0, 0, 50, 50, 0, 0))
	formal_select._select_level(LevelCatalog.WIND_BAMBOO_ID)
	formal_select._start_level(false)
	await _frames(5)
	var formal_run := current_scene as Node2D
	_check(formal_run != null and formal_run.get_run_mode() == &"full", "Formal launch must retain the full-run record bucket even without a boss")
	if formal_run != null:
		formal_run.free()

func _test_return_and_story() -> void:
	var select := LEVEL_SELECT.instantiate()
	root.add_child(select)
	current_scene = select
	await _frames(2)
	select._replay_story()
	_check(select.status.text.contains("暂未开放"), "Unavailable story must give a clear player-facing message")
	var event := InputEventKey.new()
	event.keycode = KEY_ESCAPE
	event.pressed = true
	select._unhandled_key_input(event)
	await _frames(4)
	_check(current_scene != null and current_scene.scene_file_path == "res://scenes/ui/character_setup.tscn", "Escape must return to the preparation page")
	if current_scene != null:
		current_scene.free()

func _test_read_only_state() -> void:
	var select := LEVEL_SELECT.instantiate()
	select.profile = PlayerProfile.new()
	select.profile._document.version = ProfileStore.VERSION + 1
	select.profile.save_pending = true
	root.add_child(select)
	await _frames(2)
	select._select_level(LevelCatalog.FOG_RIDGE_ID)
	_check(select.save_badge.status == &"readonly" and select.save_badge.visible, "A newer-version archive must keep a visible read-only badge on the map")
	_check(not select.save_retry.visible and select.start_button.disabled and not select.practice_button.disabled, "A read-only map blocks formal challenge and save retry while keeping free practice available")
	select.free()

func _test_journey_and_snapshot() -> void:
	var select := LEVEL_SELECT.instantiate()
	select.profile = PlayerProfile.new()
	root.add_child(select)
	current_scene = select
	await _frames(2)
	await _tap_button(select.route.buttons[LevelCatalog.WIND_BAMBOO_ID])
	_check(select.selected_level_id == LevelCatalog.WIND_BAMBOO_ID and select.start_button.disabled, "Route lanterns must select locked details without unlocking a level")
	select.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60.0, 60.0, 0, 50, 50, 0, 0))
	select._select_level(LevelCatalog.FOG_RIDGE_ID)
	_check(select.chapter_stars.text.contains("0 / 6"), "Legacy clears must not fabricate chapter stars")
	_check(select.level_buttons[LevelCatalog.FOG_RIDGE_ID].state_chip.text == "已通关", "Completion must remain independent from selection")
	await _tap_button(select.snapshot_button)
	_check(select.snapshot_dialog != null and select.snapshot_dialog.body_label.text.contains("旧版"), "Touch must open an honest legacy snapshot explanation")
	var selected: StringName = select.selected_level_id
	await _tap_button(select.route.buttons[LevelCatalog.WIND_BAMBOO_ID])
	select._select_level(LevelCatalog.WIND_BAMBOO_ID)
	select._start_level(true)
	_check(select.selected_level_id == selected and current_scene == select, "The record overlay must block selection and gameplay launch underneath")
	var event := InputEventKey.new()
	event.keycode = KEY_ESCAPE
	event.pressed = true
	root.push_input(event, true)
	await _frames(3)
	_check(select.snapshot_dialog == null and current_scene == select, "Escape must close only the snapshot overlay")
	_check(root.gui_get_focus_owner() == select.snapshot_button, "Closing the snapshot must restore its source focus")
	await _tap_button(select.record_tabs.buttons[&"character"])
	_check(select.record_character_only and select.snapshot_button.disabled, "Touching the current-character tab must keep empty character records separate")
	var result := _sample_result(select.run_loadout)
	select.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", result)
	select._set_record_view(false)
	_check(select.chapter_stars.text.contains("3 / 6") and select.detail_record.text.contains("无伤印"), "Chapter stars and independent flawless must read the actual formal record")
	await _tap_button(select.snapshot_button)
	_check(select.snapshot_dialog != null and select.snapshot_dialog.body_label.text.contains("最高分单局"), "Formal snapshots must be available through touch")
	await _tap_button(select.snapshot_dialog.confirm_button)
	_check(select.snapshot_dialog == null and root.gui_get_focus_owner() == select.snapshot_button, "The snapshot action must close and return focus")
	select.profile._pending_transaction = {"id": "pending-reward", "kind": "completion"}
	select.profile.save_pending = true
	select.profile.last_error = "测试保存失败"
	var pending: Dictionary = select.profile.pending_transaction
	select._select_level(LevelCatalog.FOG_RIDGE_ID)
	_check(select.start_button.disabled and not select.practice_button.disabled and select.save_retry.visible, "Pending rewards must block formal challenge while keeping save retry and free practice")
	_check(select.profile.pending_transaction == pending, "Rendering a selected level must not commit or replace its pending transaction")
	select.free()

func _sample_result(loadout: RunLoadout) -> RunResult:
	var result := RunResult.calculate(95.9, 100.0, 0, 50, 50, 1, 4)
	result.capture_context(LevelCatalog.FOG_RIDGE_ID, &"full", "journey-sample", loadout)
	result.apply_formal_rules()
	result.completed = true
	return result

func _capture_states(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "Capture requires the graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Capture directory must be writable")
	for spec in [[1280, "first"], [1280, "locked"], [1280, "unlocked"], [1600, "unlocked"], [1280, "record"], [1600, "record"], [1600, "safe"], [1280, "readonly"], [1280, "wallet_max"], [1280, "legacy"], [1280, "snapshot"], [1600, "snapshot"], [1280, "character_empty"], [1280, "save_error"]]:
		var viewport := SubViewport.new()
		viewport.size = Vector2i(spec[0], 720)
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var select := LEVEL_SELECT.instantiate()
		# Each screenshot starts with explicit in-memory state in the isolated scope.
		select.profile = PlayerProfile.new()
		select.profile._pending_transaction = {}
		select.profile.save_pending = false
		if spec[1] == "readonly":
			select.profile._document.version = ProfileStore.VERSION + 1
		elif spec[1] == "save_error":
			select.profile._pending_transaction = {"id": "capture-pending", "kind": "completion"}
			select.profile.save_pending = true
			select.profile.last_error = "测试保存失败"
		elif spec[1] == "wallet_max":
			select.profile._reward_state.coins = RewardService.MAX_COINS
		viewport.add_child(select)
		if spec[1] in ["unlocked", "record", "legacy", "snapshot", "character_empty"]:
			select.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60.0, 60.0, 0, 50, 50, 0, 0))
		if spec[1] in ["record", "snapshot", "character_empty"]:
			select.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", _sample_result(select.run_loadout))
		if spec[1] in ["locked", "unlocked"]:
			select._select_level(LevelCatalog.WIND_BAMBOO_ID)
		else:
			select._select_level(LevelCatalog.FOG_RIDGE_ID)
		if spec[1] == "character_empty":
			select.run_loadout = RunLoadout.capture(CharacterRegistry.get_character(&"thunder_guard"), PlayerProfile.WEAPONS[&"star_lance"])
			select._set_record_view(true)
		elif spec[1] == "snapshot":
			select._open_snapshot()
		await _frames(2)
		if spec[1] == "safe":
			ScreenLayout.fit_control(select, Rect2(60, 24, 1480, 648))
		await RenderingServer.frame_post_draw
		_check(not select.wallet.get_global_rect().intersects(select.save_badge.get_global_rect()), "Even the maximum wallet must remain separate from the persistent save badge")
		for button: Button in select.level_buttons.values():
			_check(ScreenLayout.fit_frame(Rect2(Vector2.ZERO, viewport.size)).encloses(button.get_global_rect()), "Card hit areas must fit the safe design frame")
		var target := output.path_join("level_select_%s_%s.png" % spec)
		_check(viewport.get_texture().get_image().save_png(target) == OK, "Capture must save successfully")
		print("LEVEL_SELECT_CAPTURE ", target)
		viewport.free()

func _find_button(node: Node, text: String) -> Button:
	for child in node.find_children("*", "Button", true, false):
		if child.text == text:
			return child as Button
	return null

func _tap_button(button: Button) -> void:
	var point := button.get_global_transform_with_canvas() * (button.size * 0.5)
	for pressed in [true, false]:
		var event := InputEventScreenTouch.new()
		event.index = 0
		event.position = point
		event.pressed = pressed
		# Inject viewport coordinates so window focus/OS scaling cannot redirect a tap.
		button.get_viewport().push_input(event, true)
		await _frames(2)

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
