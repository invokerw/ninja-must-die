extends SceneTree

const LEVEL := LevelCatalog.FOG_RIDGE_ID
const WIND := LevelCatalog.WIND_BAMBOO_ID
const SELECT := preload("res://scenes/ui/level_select.tscn")
var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var scope := TestProfileScope.new("stars-records")
	_test_formula()
	_test_history()
	_test_legacy_and_storage()
	_test_validation()
	await _test_actual_finish()
	await _test_map()
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-dir="):
			await _capture(argument.trim_prefix("--capture-dir="))
	scope.close()
	if _failures == 0:
		print("STARS_RECORDS_PASS (integer thresholds, independent flawless, whole-run/config snapshots, character records, v1 migration, v2 persistence/retry/dedupe, real formal/practice/failure, map views)")
	quit(0 if _failures == 0 else 1)

func _result(id: String, collected := 50, damage := 0, seconds := 100.0, character: StringName = &"shadow_runner", level: StringName = LEVEL) -> RunResult:
	var loadout := RunLoadout.capture(CharacterRegistry.get_character(character), PlayerProfile.WEAPONS[&"star_lance"])
	loadout.growth_snapshot = {"training": {"level": 0}}
	var result := RunResult.calculate(seconds, 100.0, damage, collected, 50, 1, 4)
	result.capture_context(level, &"full", id, loadout)
	result.apply_formal_rules()
	result.completed = true
	return result

func _test_formula() -> void:
	for spec in [[30, 2, 2300, 2], [30, 4, 2000, 1], [40, 1, 2650, 3], [50, 2, 2700, 3], [50, 0, 3000, 3], [0, 0, 2000, 1]]:
		var result := _result("formula", spec[0], spec[1])
		_check(result.score == spec[2] and result.stars == spec[3] and result.flawless == (spec[1] == 0), "Stars and flawless must follow raw collection/hit counts: %s" % [spec])
	for spec in [[199, 2199, 1], [200, 2200, 2], [599, 2599, 2], [600, 2600, 3]]:
		var score := RunResult.star_score(spec[0], 1000, 0)
		_check(score == spec[1] and RunResult.stars_for_score(score) == spec[2], "Integer score thresholds must not round up")
	_check(RunResult.star_score(2, 3, 0) == 2666, "Fractional collection points must truncate")
	_check(RunResult.star_score(0, 0, 0) == -1 and RunResult.star_score(51, 50, 0) == -1 and RunResult.star_score(-1, 50, 0) == -1 and RunResult.star_score(1, 50, -1) == -1, "Invalid counts must not produce stars")
	var slow := _result("slow", 40, 1, 900.0)
	slow.kills = 99
	slow.max_combo = 999
	slow.apply_formal_rules()
	_check(slow.score == 2650 and slow.stars == 3, "Time, kills and combo must not affect formal stars")

func _test_history() -> void:
	var history := RunHistory.new()
	var clean := _result("clean-low-collection", 0)
	var damaged := _result("damaged-high-collection", 50, 4, 90.0, &"wind_scout")
	_check(history.record_completion(LEVEL, &"full", clean) and history.record_completion(LEVEL, &"full", damaged), "Valid formal runs must enter history")
	var record := history.get_record(LEVEL, &"full")
	_check(record.best_stars == 2 and record.flawless and record.best_score == 2400, "Separate clean/collected runs must never be combined into synthetic three stars")
	_check(record.best_score_snapshot.damage_count == 4 and record.flawless_snapshot.collected == 0 and record.fastest_snapshot.character_id == "wind_scout", "Each independent record must preserve its actual complete run")
	_check(history.get_record(LEVEL, &"full", &"shadow_runner").best_stars == 1 and history.get_record(LEVEL, &"full", &"wind_scout").best_stars == 2 and history.get_record(LEVEL, &"full", &"thunder_guard").is_empty(), "Character views must remain separate from overall")
	_check(not history.record_completion(LEVEL, &"full", damaged) and history.get_record(LEVEL, &"full").completions == 2, "Repeated run IDs must not create another completion")
	damaged.growth_snapshot.training.level = 8
	record.best_score_snapshot.growth_snapshot.training.level = 9
	_check(history.get_record(LEVEL, &"full").best_score_snapshot.growth_snapshot.training.level == 0, "Stored and returned nested snapshots must be independent")
	history.record_completion(LEVEL, &"full", _result("three", 40, 1, 95.0))
	history.record_completion(LEVEL, &"full", _result("worse", 10, 5, 120.0))
	record = history.get_record(LEVEL, &"full")
	_check(record.best_stars == 3 and record.best_score == 2650 and record.best_time == 90.0 and record.flawless_snapshot.run_id == clean.run_id and record.completions == 4, "Worse runs must not lower stars, time or replace the first flawless stamp")
	var practice := RunResult.calculate(60, 60, 0, 50, 50, 0, 0)
	history.record_completion(LEVEL, &"parkour_practice", practice)
	_check(not history.get_record(LEVEL, &"parkour_practice").has("best_stars") and history.get_record(LEVEL, &"full").completions == 4, "Practice must not update formal stars")

func _test_legacy_and_storage() -> void:
	var profile := PlayerProfile.current()
	var path := profile.save_path
	var legacy := RunHistory.new()
	legacy.record_completion(&"fog_ridge_60s", &"full", RunResult.calculate(97, 100, 0, 50, 50, 1, 8))
	var old_records := legacy.to_dictionary()
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify({"version": 1, "run_records": old_records, "custom": {"preserve": true}, "settings": {"sound": false}, "character_loadouts": {"shadow_runner": {"weapon_id": "star_lance"}}}))
	file.close()
	profile.load_profile()
	var old := profile.history.get_record(LEVEL, &"full")
	_check(old.get("legacy", false) and not old.has("best_stars") and not old.has("flawless") and old.best_score > 3000, "Old scores/ranks must remain legacy without invented stars or flawless")
	_check(profile.history.get_record(LEVEL, &"full", &"shadow_runner").is_empty(), "Old aggregate records must not be assigned to a character")
	_check(profile.get_equipped_weapon(CharacterRegistry.get_character(&"shadow_runner")).weapon_id == &"star_lance" and not profile.feedback_settings.sound, "Migration must preserve equipment and settings")
	# Save failure retains one result. Retrying storage or loading it again cannot
	# recalculate/increment the same run.
	var result := _result("persisted-run")
	profile.save_path = "res://.godot/missing-stars-directory/save.json"
	_check(not profile.record_completion(LEVEL, &"full", result) and profile.save_pending, "Failed save must keep new stars pending")
	profile.save_path = path
	_check(profile.save_profile(), "Pending stars must save without recomputing completion")
	var restored := PlayerProfile.new(path)
	restored.load_profile()
	var record := restored.history.get_record(&"fog_ridge_60s", &"full")
	_check(record.best_stars == 3 and record.flawless and record.completions == 1 and record.legacy_record.best_score == old.best_score, "v2 reload and legacy alias must expose new stars plus untouched old record")
	_check(not restored.record_completion(LEVEL, &"full", result) and restored.history.get_record(LEVEL, &"full").completions == 1, "Reloaded run IDs must remain deduplicated")
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	_check(document.version == ProfileStore.VERSION and document.run_records == JSON.parse_string(JSON.stringify(old_records)) and document.custom.preserve, "Save migration must preserve unknown fields and original legacy buckets")
	document.level_progress[String(LEVEL)]["future_entry"] = {"keep": 4}
	document.level_progress[String(LEVEL)].overall["future_record"] = 9
	document.level_progress[String(LEVEL)].characters["future_character"] = {"keep": true}
	file = FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(document))
	file.close()
	restored.load_profile()
	_check(restored.record_completion(LEVEL, &"full", _result("preserve-extensions", 40, 1)), "A new result must update the existing entry")
	document = JSON.parse_string(FileAccess.get_file_as_string(path))
	_check(document.level_progress[String(LEVEL)].future_entry.keep == 4 and document.level_progress[String(LEVEL)].overall.future_record == 9 and document.level_progress[String(LEVEL)].characters.future_character.keep, "Progress writes must preserve unknown entry, record and character extensions")
	file = FileAccess.open(path, FileAccess.WRITE)
	file.store_string("{ interrupted")
	file.close()
	restored.load_profile()
	_check(not restored.load_notice.is_empty() and restored.history.get_record(LEVEL, &"full").completions == 1 and not restored.history.record_completion(LEVEL, &"full", result), "Backup must restore stars, raw snapshot and run IDs from the same generation")
	_check(restored.save_profile(), "Recovered star progress must repair the primary file")
	var stable := FileAccess.get_file_as_string(path)
	var backup := FileAccess.get_file_as_string(path + ".bak")
	document = JSON.parse_string(stable)
	document.version = ProfileStore.VERSION + 1
	file = FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(document))
	file.close()
	var future := FileAccess.get_file_as_string(path)
	restored.load_profile()
	_check(not restored.record_completion(LEVEL, &"full", _result("future-memory-only")) and restored.save_pending and FileAccess.get_file_as_string(path) == future and FileAccess.get_file_as_string(path + ".bak") == backup, "Newer documents must retain original/backup while allowing only in-memory stars")
	file = FileAccess.open(path, FileAccess.WRITE)
	file.store_string(stable)
	file.close()
	profile.load_profile()

func _test_validation() -> void:
	for field in ["score", "stars", "damage_count", "collectible_total", "time_seconds", "score_rule_version"]:
		var history := RunHistory.new()
		var result := _result("invalid")
		match field:
			"score": result.score += 1
			"stars": result.stars = 1
			"damage_count": result.damage_count = -1
			"collectible_total": result.collectible_total = 0
			"time_seconds": result.time_seconds = INF
			"score_rule_version": result.score_rule_version = 2
		_check(not history.record_completion(LEVEL, &"full", result), "Malformed result must be rejected: " + field)
	var history := RunHistory.new()
	_check(not history.record_completion(WIND, &"full", _result("wrong-level")) and not history.record_completion(LEVEL, &"parkour_practice", _result("wrong-mode")), "Wrong level and practice must not accept a formal snapshot")
	history.record_completion(LEVEL, &"full", _result("valid"))
	var progress := history.progress_to_dictionary()
	progress[String(LEVEL)].overall.best_score_snapshot.collected = NAN
	history.load_progress(progress)
	_check(history.get_record(LEVEL, &"full").is_empty() and history.get_record(LEVEL, &"full", &"shadow_runner").best_stars == 3, "Corrupt aggregate must not erase a valid character record")
	history.record_completion(LEVEL, &"full", _result("repair", 40, 1))
	_check(history.get_record(LEVEL, &"full").best_score == 2650, "A new valid result must repair a damaged aggregate from real raw statistics")

func _test_actual_finish() -> void:
	var profile := PlayerProfile.current()
	var loadout := profile.resolve()
	var previous_run_id := ""
	for path in ["res://scenes/main.tscn", "res://scenes/practice.tscn"]:
		_check(RunNavigation.launch_level(self, path, loadout, WIND) == OK, "Second level must launch")
		await _frames(4)
		var main := current_scene
		_check(main.run_id != previous_run_id and not main.run_id.is_empty(), "Each run must have a fresh stable ID")
		previous_run_id = main.run_id
		main.player.crystals = 40
		main.player.damage_count = 1
		main._elapsed_time = 84.0
		main.player.position.x = main.level.data.get_finish_x() - 65.0
		await _frames(18)
		_check(main._finished, "Real finish gate must finish the selected level")
		if path.ends_with("main.tscn"):
			_check(main.run_result.stars == 3 and not main.run_result.flawless and main.result_body.text.contains("本局 3 星") and main.result_body.text.contains("受击 1 次"), "Formal UI must show stars and independent hit count")
			_check(profile.history.get_record(WIND, &"full").best_score_snapshot.run_id == main.run_id, "Real completion must save its actual run context")
		else:
			_check(main.run_result.stars == 0 and not profile.history.get_record(WIND, &"parkour_practice").has("best_stars"), "Practice must retain separate legacy scoring")
		main._on_finish_reached()
		_check(profile.history.get_record(WIND, main.get_run_mode()).completions == 1, "Duplicate finish signals must not record another completion")
		paused = false
		main.free()
	var before := profile.history.progress_to_dictionary()
	RunNavigation.launch_level(self, "res://scenes/main.tscn", loadout, WIND)
	await _frames(4)
	var failed := current_scene
	failed.player.take_damage(failed.player.health)
	await _frames(2)
	_check(profile.history.progress_to_dictionary() == before and not failed.result_body.text.contains("本局 3 星"), "Failure must not create stars or replace progress")
	var failed_id: String = failed.run_id
	failed._restart_run()
	await _frames(4)
	var retried := current_scene
	_check(retried.run_id != failed_id and retried.player.active and retried._elapsed_time < 1.0 and profile.history.progress_to_dictionary() == before, "Retry must generate a fresh run ID without recording the abandoned run")
	retried.free()

func _test_map() -> void:
	var select := SELECT.instantiate()
	root.add_child(select)
	select._select_level(LEVEL)
	for button in select._record_view_buttons:
		_check(button.size.y >= 48.0, "Record view controls must retain a usable touch target")
	_check(select.detail_record.text.contains("3 星") and select.detail_record.text.contains("无伤印") and select.detail_score.text.contains("3000"), "Map must display actual stars, flawless and new score")
	await _touch_button(select._record_view_buttons[1])
	_check(select.detail_record.text.contains("3 星"), "Current character view must use its own record")
	select.run_loadout = RunLoadout.capture(CharacterRegistry.get_character(&"thunder_guard"), PlayerProfile.WEAPONS[&"star_lance"])
	select._set_record_view(true)
	_check(select.detail_record.text.contains("尚无纪录"), "A character without runs must not inherit overall records")
	await _touch_button(select._record_view_buttons[0])
	_check(select.detail_record.text.contains("3 星"), "Overall view must restore global record")
	select.free()

func _capture(output: String) -> void:
	_check(DisplayServer.get_name() != "headless", "Visual capture requires a graphical renderer")
	if DisplayServer.get_name() == "headless":
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Capture directory must be writable")
	for width in [1280, 1600]:
		for state in ["stars", "legacy", "character_empty", "result"]:
			var viewport := SubViewport.new()
			viewport.size = Vector2i(width, 720)
			viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
			root.add_child(viewport)
			if state == "result":
				var main: Node2D = load("res://scenes/main.tscn").instantiate()
				viewport.add_child(main)
				main.player.position.x = main.level.data.get_finish_x() - 65.0
				await _frames(13)
				main.player.crystals = 40
				main.player.damage_count = 1
				main._elapsed_time = 99.0
				main.level.boss.health = 24
				main.level.boss.state = RopeBoss.State.RECOVERY
				main.level.boss.remaining = 10.0
				main.combat.try_skill()
				await _frames(56)
				_check(main._finished and main.result_body.get_line_count() <= 7, "Full boss result and reward must fit above settings/save actions")
			else:
				var select := SELECT.instantiate()
				select.profile = PlayerProfile.new()
				if state == "legacy":
					select.profile.history.record_completion(LEVEL, &"full", RunResult.calculate(97, 100, 0, 50, 50, 1, 8))
				else:
					select.profile.history.record_completion(LEVEL, &"full", _result("capture"))
				viewport.add_child(select)
				select._set_record_view(state == "character_empty")
				if state == "character_empty":
					select.run_loadout = RunLoadout.capture(CharacterRegistry.get_character(&"wind_scout"), PlayerProfile.WEAPONS[&"crescent_wheel"])
					select._set_record_view(true)
			await _frames(2)
			RenderingServer.force_draw()
			_check(viewport.get_texture().get_image().save_png(output.path_join("%d_%s.png" % [width, state])) == OK, "Capture must save")
			print("STARS_CAPTURE %d_%s.png" % [width, state])
			paused = false
			viewport.free()

func _touch_button(button: Button) -> void:
	var point := button.get_global_transform_with_canvas() * (button.size * 0.5)
	for pressed in [true, false]:
		var event := InputEventScreenTouch.new()
		event.index = 0
		event.position = point
		event.pressed = pressed
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
