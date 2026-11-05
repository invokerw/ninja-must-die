extends SceneTree

const LEVEL := LevelCatalog.FOG_RIDGE_ID
const WIND := LevelCatalog.WIND_BAMBOO_ID
var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var outer := TestProfileScope.new("reward-transactions")
	_test_rewards()
	_test_milestones()
	_test_migration()
	_test_extensions_and_validation()
	_test_failures()
	_test_corruption_and_future()
	await _test_actual_ui()
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-dir="):
			await _capture(argument.trim_prefix("--capture-dir="))
	ProfileStore.write_guard = Callable()
	outer.close()
	if _failures == 0:
		print("REWARD_TRANSACTIONS_PASS (starter/clear/star/flawless/milestones, v1/v2 migration, atomic I/O boundaries, pending lock/retry, backup/future/corrupt, actual finish/practice/UI)")
	quit(0 if _failures == 0 else 1)

func _result(id: String, collected := 40, damage := 2, level: StringName = LEVEL, character: StringName = &"shadow_runner") -> RunResult:
	var result := RunResult.calculate(100, 100, damage, collected, 50, 1, 4)
	result.capture_context(level, &"full", id, RunLoadout.capture(CharacterRegistry.get_character(character), PlayerProfile.WEAPONS[&"star_lance"]))
	result.apply_formal_rules()
	result.completed = true
	return result

func _test_rewards() -> void:
	var scope := TestProfileScope.new("reward-values")
	var profile := scope.profile
	_check(profile.coins == 120 and profile.can_start_formal_run(), "Starter grant must persist once before the first formal run")
	_check(profile.record_completion(LEVEL, &"full", _result("first")), "A completed formal run must commit")
	var summary := profile.reward_summary("first")
	_check(summary.total == 316 and profile.coins == 436 and summary.breakdown.first_clear == 160 and summary.breakdown.stars == 80, "First two-star clear must award 60+16+160+80")
	_check(String(WIND) in profile.reward_state().unlocked_level_ids and "wind_scout" in profile.reward_state().unlocked_character_ids, "Clear, character and next-level ownership must commit with the reward")
	_check(not profile.record_completion(LEVEL, &"full", _result("first")) and profile.coins == 436, "A repeated run ID must award nothing")
	profile.record_completion(LEVEL, &"full", _result("repeat"))
	_check(profile.reward_summary("repeat").total == 76 and profile.coins == 512, "An equal new clear must only award base+collection")
	profile.record_completion(LEVEL, &"full", _result("improve", 45, 1))
	_check(profile.reward_summary("improve").total == 118 and profile.reward_summary("improve").new_stars == 1, "A better star result must only pay the new star delta")
	profile.record_completion(LEVEL, &"full", _result("flawless", 45, 0, LEVEL, &"wind_scout"))
	_check(profile.reward_summary("flawless").total == 108 and profile.reward_summary("flawless").breakdown.flawless == 30, "First flawless is per-level and independent of character/star upgrades")
	profile.record_completion(LEVEL, &"full", _result("other-character", 50, 0, LEVEL, &"thunder_guard"))
	_check(profile.reward_summary("other-character").total == 80, "Changing character must not repeat clear/stars/flawless rewards")
	profile.record_completion(WIND, &"full", _result("second", 50, 0, WIND))
	_check(profile.reward_summary("second").total == 510 and profile.reward_summary("second").breakdown.milestones == 120, "The second three-star clear must award chapter six-star milestone once")
	profile.record_completion(WIND, &"full", _result("second-repeat", 50, 0, WIND))
	_check(profile.reward_summary("second-repeat").total == 80, "An already claimed chapter milestone must not repeat")
	var balance := profile.coins
	var before := profile.history.progress_to_dictionary()
	var practice := RunResult.calculate(60, 60, 0, 50, 50, 0, 0)
	profile.record_completion(LEVEL, &"parkour_practice", practice)
	_check(profile.coins == balance and profile.history.progress_to_dictionary() == before, "Practice must not change money or main progress")
	var invalid := _result("invalid")
	invalid.score += 10
	_check(not profile.record_completion(LEVEL, &"full", invalid) and profile.coins == balance, "Inconsistent scoring must reject the entire transaction")
	invalid = _result("unknown", 50, 0, &"unknown")
	_check(not profile.record_completion(&"unknown", &"full", invalid), "Unknown levels cannot create rewards")
	invalid = _result("not-completed")
	invalid.completed = false
	_check(not profile.record_completion(LEVEL, &"full", invalid) and profile.coins == balance, "A failed/unfinished raw result cannot pay a clear reward")
	summary.breakdown.base = 999
	_check(profile.reward_summary("first").breakdown.base == 60, "Returned summaries must be isolated from the ledger")
	scope.close()

func _test_milestones() -> void:
	var history := RunHistory.new()
	var state := RewardService.initial_state({}, history)
	RewardService.claim_milestones(state, &"chapter_test", 5)
	_check(state.coins == 120, "Five stars must not meet a six-star threshold")
	RewardService.claim_milestones(state, &"chapter_test", 15)
	_check(state.coins == 740, "Crossing multiple thresholds pays 120+200+300 together")
	RewardService.claim_milestones(state, &"chapter_test", 15)
	_check(state.coins == 740, "Each stable chapter milestone ID must only pay once")

func _test_migration() -> void:
	for version in [1, 2]:
		var scope := TestProfileScope.new("reward-migration-%d" % version)
		var profile := scope.profile
		var history := RunHistory.new()
		if version == 1:
			history.record_completion(&"fog_ridge_60s", &"full", RunResult.calculate(98, 100, 0, 50, 50, 1, 4))
		else:
			history.record_completion(LEVEL, &"full", _result("old-v2", 50, 0))
		var document := {"version": version, "run_records": history.to_dictionary(), "level_progress": history.progress_to_dictionary(), "custom": {"keep": true}}
		_write(profile.save_path, document)
		profile.load_profile()
		_check(profile.coins == (280 if version == 1 else 430), "Migration grants only starter, first clear and known star/flawless entitlements")
		_check(profile.can_start_formal_run(), "Migration must save before formal play")
		profile.load_profile()
		_check(profile.coins == (280 if version == 1 else 430), "Reload must not repeat migration")
		if version == 2:
			_check(not profile.record_completion(LEVEL, &"full", _result("old-v2", 50, 0)), "Already recorded v2 run IDs must not be retroactively paid again")
		_check(JSON.parse_string(FileAccess.get_file_as_string(profile.save_path)).custom.keep, "Unknown fields must survive migration")
		scope.close()
	var scope := TestProfileScope.new("reward-practice-migration")
	var history := RunHistory.new()
	history.record_completion(&"fog_ridge_60s", &"parkour_practice", RunResult.calculate(60, 60, 0, 50, 50, 0, 0))
	_write(scope.profile.save_path, {"version": 1, "run_records": history.to_dictionary()})
	scope.profile.load_profile()
	_check(scope.profile.coins == 120 and "wind_scout" not in scope.profile.reward_state().unlocked_character_ids, "Old practice cannot grant first-clear rewards or character ownership")
	scope.close()

func _test_failures() -> void:
	for stage in ["temporary", "backup", "replace"]:
		var scope := TestProfileScope.new("reward-failure-" + stage)
		var profile := scope.profile
		_check(profile.save_profile(), "Establish a committed generation before injecting I/O failure")
		var original := FileAccess.get_file_as_string(profile.save_path)
		ProfileStore.write_guard = func(boundary: String) -> bool: return boundary != stage
		var result := _result("pending-" + stage, 50, 0)
		_check(not profile.record_completion(LEVEL, &"full", result), "The failed write must report failure at " + stage)
		var pending := profile.pending_transaction
		_check(profile.coins == 510 and pending.kind == "completion" and profile.save_pending, "The full reward/record draft must remain in memory")
		_check(FileAccess.get_file_as_string(profile.save_path) == original, "Partial write must not replace the committed primary")
		var reloaded := PlayerProfile.new(profile.save_path)
		reloaded.load_profile()
		_check(reloaded.coins == 120 and reloaded.history.get_record(LEVEL, &"full").is_empty(), "Restart after failure must see a complete old generation")
		_check(not profile.record_completion(WIND, &"full", _result("blocked", 50, 0, WIND)) and profile.coins == 510 and profile.pending_transaction == pending, "Another economic transaction must not overwrite the pending draft")
		_check(RunNavigation.launch_level(self, "res://scenes/main.tscn", profile.resolve(), LEVEL) == ERR_BUSY, "Pending failure must block new formal navigation")
		result.collectible_count = 0
		result.stars = 1
		ProfileStore.write_guard = Callable()
		_check(profile.save_profile() and profile.pending_transaction.is_empty(), "Retry must persist the staged result without recalculating the mutated input")
		reloaded.load_profile()
		_check(reloaded.coins == 510 and reloaded.history.get_record(LEVEL, &"full").best_stars == 3 and reloaded.reward_summary(result.run_id).total == 390, "Retry must persist balance, stars, ownership and ledger together")
		_check(not reloaded.record_completion(LEVEL, &"full", _result(result.run_id, 50, 0)) and reloaded.coins == 510, "Reloaded settled IDs must remain deduplicated")
		scope.close()

func _test_extensions_and_validation() -> void:
	var scope := TestProfileScope.new("reward-extensions")
	var profile := scope.profile
	profile.record_completion(LEVEL, &"full", _result("extension-first"))
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
	document.reward_ledger["future_field"] = {"keep": 7}
	document.reward_ledger.runs["extension-first"]["future_receipt"] = true
	document.unlocked_level_ids.append("future_level")
	_write(profile.save_path, document)
	profile.load_profile()
	profile.record_completion(LEVEL, &"full", _result("extension-next"))
	document = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
	_check(document.reward_ledger.future_field.keep == 7 and document.reward_ledger.runs["extension-first"].future_receipt and "future_level" in document.unlocked_level_ids, "New transactions must preserve unknown ledger, receipt and ownership extensions")
	for bad in [-1, NAN, INF, true, 1.5, RewardService.MAX_COINS + 1]:
		var state := profile.reward_state()
		state.coins = bad
		_check(not RewardService.valid_state(state), "Invalid coin types/ranges must be rejected")
	var malformed := profile.reward_state()
	malformed.reward_ledger.runs["extension-first"].breakdown.base = "60"
	_check(not RewardService.valid_state(malformed), "Malformed receipts must not load into the wallet/UI")
	scope.close()

func _test_corruption_and_future() -> void:
	var scope := TestProfileScope.new("reward-corruption")
	var profile := scope.profile
	profile.save_profile()
	profile.record_completion(LEVEL, &"full", _result("saved", 50, 0))
	profile.save_profile() # The backup now contains the complete reward generation.
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
	document.coins = -1
	_write(profile.save_path, document)
	profile.load_profile()
	_check(profile.coins == 510 and not profile.load_notice.is_empty() and profile.history.get_record(LEVEL, &"full").completions == 1, "Invalid economy data must restore a whole backup generation")
	_check(not profile.record_completion(LEVEL, &"full", _result("saved", 50, 0)), "Backup recovery must retain settled run IDs")
	profile.save_profile()
	document = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
	document.version = ProfileStore.VERSION + 1
	_write(profile.save_path, document)
	var original := FileAccess.get_file_as_string(profile.save_path)
	var backup := FileAccess.get_file_as_string(profile.save_path + ".bak")
	profile.load_profile()
	_check(not profile.can_start_formal_run() and not profile.save_profile() and FileAccess.get_file_as_string(profile.save_path) == original and FileAccess.get_file_as_string(profile.save_path + ".bak") == backup, "Future documents must remain read-only with formal transactions blocked")
	scope.close()

func _test_actual_ui() -> void:
	var scope := TestProfileScope.new("reward-ui")
	var profile := scope.profile
	RunNavigation.launch_level(self, "res://scenes/main.tscn", profile.resolve(), LEVEL)
	await _frames(4)
	var main := current_scene
	main.player.crystals = 50
	main._elapsed_time = 98
	main._on_finish_reached()
	var balance := profile.coins
	_check(main.result_body.text.contains("铜钱 +390") and main.result_body.text.contains("岚织加入"), "Formal result must show the actual reward and unlock summary")
	await _touch(main.rewards_button)
	_check(main.result_body.text.contains("首通 160") and main.result_body.text.contains("新星 120") and main.result_body.text.contains("首次无伤 30"), "Touch must reveal the immutable reward breakdown")
	await _touch(main.rewards_button)
	main._on_finish_reached()
	_check(profile.coins == balance, "Duplicate real finish must not pay twice")
	paused = false
	main.free()
	RunNavigation.launch_level(self, "res://scenes/main.tscn", profile.resolve(), WIND)
	await _frames(4)
	main = current_scene
	ProfileStore.write_guard = func(_stage: String) -> bool: return false
	main.player.crystals = 40
	main._elapsed_time = 84
	main._on_finish_reached()
	_check(main.save_status.text.contains("内存") and main.save_retry.visible, "Failed reward commit must remain visibly pending")
	main._restart_run()
	await _frames(2)
	_check(current_scene == main and not main._transitioning, "Pending rewards must prevent formal retry from starting another economic run")
	var select: Control = load("res://scenes/ui/level_select.tscn").instantiate()
	root.add_child(select)
	_check(select.wallet.text.contains("待保存") and select.save_retry.visible, "Map must expose pending wallet and storage retry")
	select.free()
	var setup: Control = load("res://scenes/ui/character_setup.tscn").instantiate()
	root.add_child(setup)
	_check(setup.wallet.text.contains("待保存"), "Preparation must preserve pending-wallet visibility")
	setup.free()
	var pending_balance := profile.coins
	_check(RunNavigation.launch_level(self, "res://scenes/practice.tscn", profile.resolve(), WIND) == OK, "Pending economic save must still allow free practice")
	await _frames(4)
	main = current_scene
	_check(main.player.active, "Free practice must start while the old reward remains pending")
	_check(main.reward_notice.visible, "Active free practice must retain a persistent pending-reward notice")
	main._elapsed_time = 84
	main.player.crystals = 50
	main._on_finish_reached()
	_check(profile.coins == pending_balance and not main.result_body.text.contains("铜钱"), "Free practice must not stack another economic transaction")
	ProfileStore.write_guard = Callable()
	main.save_retry.pressed.emit()
	_check(profile.pending_transaction.is_empty() and not main.save_retry.visible, "The visible retry must commit the existing draft")
	paused = false
	main.free()
	var before := profile.coins
	RunNavigation.launch_level(self, "res://scenes/practice.tscn", profile.resolve(), WIND)
	await _frames(4)
	main = current_scene
	main._elapsed_time = 84
	main.player.crystals = 50
	main._on_finish_reached()
	_check(profile.coins == before and not main.result_body.text.contains("铜钱"), "Real practice finish must remain reward-free")
	paused = false
	main.free()
	scope.close()

func _capture(output: String) -> void:
	_check(DisplayServer.get_name() != "headless", "Capture needs a graphical renderer")
	if DisplayServer.get_name() == "headless":
		return
	DirAccess.make_dir_recursive_absolute(output)
	for width in [1280, 1600]:
		var scope := TestProfileScope.new("reward-capture-%d" % width)
		var profile := scope.profile
		var viewport := SubViewport.new()
		viewport.size = Vector2i(width, 720)
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var main: Node2D = load("res://scenes/main.tscn").instantiate()
		viewport.add_child(main)
		main.player.position.x = main.level.data.get_finish_x() - 65
		await _frames(13)
		main.player.crystals = 50
		main._elapsed_time = 98
		main.level.boss.health = 24
		main.level.boss.state = RopeBoss.State.RECOVERY
		main.level.boss.remaining = 10
		ProfileStore.write_guard = func(_stage: String) -> bool: return false
		main.combat.try_skill()
		await _frames(56)
		await _save_view(viewport, output.path_join("%d_pending.png" % width))
		await _touch(main.rewards_button)
		await _save_view(viewport, output.path_join("%d_details.png" % width))
		await _touch(main.rewards_button)
		ProfileStore.write_guard = Callable()
		main.save_retry.pressed.emit()
		await _save_view(viewport, output.path_join("%d_saved.png" % width))
		paused = false
		main.free()
		var select: Control = load("res://scenes/ui/level_select.tscn").instantiate()
		viewport.add_child(select)
		await _save_view(viewport, output.path_join("%d_map.png" % width))
		select.free()
		var setup: Control = load("res://scenes/ui/character_setup.tscn").instantiate()
		viewport.add_child(setup)
		await _save_view(viewport, output.path_join("%d_setup.png" % width))
		setup.free()
		viewport.free()
		scope.close()

func _save_view(viewport: SubViewport, path: String) -> void:
	await _frames(2)
	RenderingServer.force_draw()
	_check(viewport.get_texture().get_image().save_png(path) == OK, "Screenshot must save")
	print("REWARDS_CAPTURE ", path)

func _touch(button: Button) -> void:
	var point := button.get_global_transform_with_canvas() * (button.size * 0.5)
	for pressed in [true, false]:
		var event := InputEventScreenTouch.new()
		event.index = 0
		event.position = point
		event.pressed = pressed
		button.get_viewport().push_input(event, true)
		await _frames(2)

func _write(path: String, document: Dictionary) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(document))
	file.close()

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
