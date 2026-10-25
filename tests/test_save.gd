extends SceneTree

const LEVEL := &"fog_ridge_60s"
const CHARACTER := preload("res://data/characters/shadow_runner.tres")
const STORE_PATH := "res://.godot/test-save-recovery.json"
var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var scope := TestProfileScope.new("save")
	_test_history()
	_test_legacy_and_validation()
	_test_recovery()
	_test_failed_save()
	await _test_settings_ui()
	await _test_real_completions()
	await _test_preparation_records()
	scope.close()
	_cleanup_store()
	if _failures == 0:
		print("SAVE_PASS (independent records/modes, legacy fields, validated settings, backup recovery, failed-save retry, real completion/death/exit, preparation UI)")
	quit(0 if _failures == 0 else 1)

func _test_history() -> void:
	var history := RunHistory.new()
	history.record_completion(LEVEL, &"full", _result(100.0, 0, 45))
	history.record_completion(LEVEL, &"full", _result(90.0, 2, 50))
	history.record_completion(LEVEL, &"full", _result(120.0, 1, 30))
	var record := history.get_record(LEVEL, &"full")
	_check(record.best_time == 90.0 and record.best_rank == "S" and record.best_collected == 50 and record.completions == 3, "Best time, rank and collection must update independently without regression")
	_check(record.best_score == _result(100.0, 0, 45).score, "A faster damaged run must not replace a higher score")
	history.record_completion(LEVEL, &"boss_practice", _result(30.0, 0, 0))
	history.record_completion(LEVEL, &"parkour_practice", _result(59.0, 0, 50))
	_check(history.get_record(LEVEL, &"full").best_time == 90.0 and history.get_record(LEVEL, &"boss_practice").best_time == 30.0 and history.get_record(LEVEL, &"parkour_practice").best_time == 59.0, "Each mode needs a separate record bucket")
	_check(not history.record_completion(LEVEL, &"unknown", _result()) and history.get_record(&"another_level", &"full").is_empty(), "Unknown modes must be rejected and different levels isolated")
	var invalid := _result()
	invalid.time_seconds = NAN
	_check(not history.record_completion(LEVEL, &"full", invalid), "Invalid result numbers must never enter saved progress")
	var document := history.to_dictionary()
	document[String(LEVEL)]["full"]["best_time"] = -1
	history.load_records(document)
	_check(history.get_record(LEVEL, &"full").is_empty() and not history.get_record(LEVEL, &"boss_practice").is_empty(), "A damaged mode record must not erase valid neighboring records")

func _test_legacy_and_validation() -> void:
	_cleanup_store()
	_write(STORE_PATH, JSON.stringify({"version": 1, "custom": {"keep": 7}, "best_times": {"old_level": 93.4}, "settings": {"sound": false, "particles": "false", "shake": 0, "flash": true, "future_setting": 42}, "character_loadouts": {"shadow_runner": {"weapon_id": "star_lance", "future_slot": "keep"}}}))
	var profile := PlayerProfile.new(STORE_PATH)
	profile.load_profile()
	_check(profile.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance" and not profile.feedback_settings.sound and profile.feedback_settings.particles and profile.feedback_settings.shake, "Legacy equipment and valid booleans must load; mistyped settings use defaults")
	_check(profile.try_equip(CHARACTER, &"crescent_wheel") and profile.save_profile(), "Additive save fields must remain compatible with v1 equipment files")
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(STORE_PATH))
	_check(document.custom.keep == 7 and document.best_times.old_level == 93.4 and document.settings.future_setting == 42 and document.character_loadouts.shadow_runner.future_slot == "keep", "Saving must preserve unrelated top-level, settings and loadout fields")
	_write(STORE_PATH, "[1,2,3]")
	_write(STORE_PATH + ".bak", "null")
	profile.load_profile()
	_check(profile.history.get_record(LEVEL, &"full").is_empty() and profile.get_equipped_weapon(CHARACTER).weapon_id == &"crescent_wheel" and not profile.load_notice.is_empty(), "Invalid JSON roots must fall back to playable defaults")
	_write(STORE_PATH, JSON.stringify({"version": 2, "settings": {"sound": false}, "future": [9]}))
	profile.load_profile()
	var original := FileAccess.get_file_as_string(STORE_PATH)
	var backup := FileAccess.get_file_as_string(STORE_PATH + ".bak")
	_check(not profile.record_completion(LEVEL, &"full", _result()) and profile.save_pending and FileAccess.get_file_as_string(STORE_PATH) == original and FileAccess.get_file_as_string(STORE_PATH + ".bak") == backup, "Newer versions must keep both original and backup untouched while this session retains progress")

func _test_recovery() -> void:
	_cleanup_store()
	var profile := PlayerProfile.new(STORE_PATH)
	profile.load_profile()
	profile.try_equip(CHARACTER, &"star_lance")
	profile.feedback_settings.sound = false
	profile.history.record_completion(LEVEL, &"full", _result())
	_check(profile.save_profile(), "First save must also create a usable backup")
	profile.history.record_completion(LEVEL, &"boss_practice", _result(35.0))
	_check(profile.save_profile(), "Second generation must atomically replace the main file")
	_write(STORE_PATH, "{ interrupted")
	var restored := PlayerProfile.new(STORE_PATH)
	restored.load_profile()
	_check(restored.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance" and not restored.feedback_settings.sound and restored.history.get_record(LEVEL, &"full").completions == 1 and not restored.load_notice.is_empty(), "Damaged main file must recover the previous valid equipment, settings and records together")
	_check(restored.save_profile() and FileAccess.get_file_as_string(STORE_PATH + ".corrupt") == "{ interrupted", "Recovery save must retain damaged original and restore a readable primary")
	var again := PlayerProfile.new(STORE_PATH)
	again.load_profile()
	_check(again.load_notice.is_empty() and again.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance", "A repaired primary must load normally on the next launch")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(STORE_PATH))
	again.load_profile()
	_check(again.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance" and not again.load_notice.is_empty(), "A missing main file must still recover an existing backup")

func _test_failed_save() -> void:
	var profile := PlayerProfile.new("res://.godot/missing-save-directory/save.json")
	profile.try_equip(CHARACTER, &"star_lance")
	_check(not profile.record_completion(LEVEL, &"full", _result()) and profile.history.get_record(LEVEL, &"full").completions == 1 and profile.save_pending, "Disk failure must keep this session's new record and mark it pending")
	_check(not profile.set_feedback_setting("sound", false) and not FeedbackSettings.sound_enabled, "Settings must take effect even when storage is unavailable")
	profile.save_path = STORE_PATH
	_check(profile.save_profile() and not profile.save_pending, "Retry must save accumulated equipment, settings and records without recording a second completion")
	var restored := PlayerProfile.new(STORE_PATH)
	restored.load_profile()
	_check(restored.history.get_record(LEVEL, &"full").completions == 1 and restored.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance" and not restored.feedback_settings.sound, "Retry must preserve all pending changes")
	FeedbackSettings.apply(PlayerProfile.current().feedback_settings)

func _test_settings_ui() -> void:
	var profile := PlayerProfile.current()
	var setup: Control = load("res://scenes/ui/character_setup.tscn").instantiate()
	root.add_child(setup)
	_check(setup.history_labels[&"full"].text.contains("尚无"), "Fresh preparation page must show an empty record state")
	for setting in ["sound", "particles", "shake", "flash"]:
		setup.feedback_menu.checks[setting].button_pressed = false
	var restored := PlayerProfile.new(profile.save_path)
	restored.load_profile()
	_check(restored.feedback_settings == {"sound": false, "particles": false, "shake": false, "flash": false}, "All four preparation switches must save their actual booleans")
	var key := InputEventKey.new()
	key.physical_keycode = KEY_M
	key.pressed = true
	setup._unhandled_key_input(key)
	_check(FeedbackSettings.sound_enabled and setup.feedback_menu.checks.sound.button_pressed, "Preparation mute shortcut must synchronize the visible switch")
	var original_path := profile.save_path
	profile.save_path = "res://.godot/missing-save-directory/save.json"
	setup.feedback_menu.checks.shake.button_pressed = true
	_check(profile.save_pending and setup.feedback_menu.retry_button.visible and setup.save_retry.visible, "Failed saves need a visible retry action in settings and preparation")
	profile.save_path = original_path
	setup.feedback_menu.retry_button.pressed.emit()
	_check(not profile.save_pending and not setup.save_retry.visible and not setup.feedback_menu.retry_button.visible, "Retry action must clear pending state without reverting settings")
	setup.free()
	var main: Node2D = load("res://scenes/practice.tscn").instantiate()
	root.add_child(main)
	paused = true
	main._on_feedback_setting(true, "particles")
	var mute := InputEventAction.new()
	mute.action = "mute"
	mute.pressed = true
	main._unhandled_input(mute)
	restored.load_profile()
	_check(restored.feedback_settings.particles and not restored.feedback_settings.sound and not main._feedback_checks.sound.button_pressed, "Paused gameplay switches and M must persist through the same path")
	paused = false
	main.free()

func _test_real_completions() -> void:
	var profile := PlayerProfile.current()
	for path in ["res://scenes/main.tscn", "res://scenes/practice.tscn", "res://scenes/boss_practice.tscn"]:
		var main: Node2D = load(path).instantiate()
		root.add_child(main)
		var mode: StringName = main.get_run_mode()
		main.player.crystals = 50 if mode != &"boss_practice" else 0
		if mode != &"parkour_practice":
			main.player.position.x = main.level.data.get_finish_x() - 65.0
			await _frames(13)
			var boss := main.level.boss as RopeBoss
			boss.health = 24
			boss.state = RopeBoss.State.RECOVERY
			boss.remaining = 10.0
			main._elapsed_time = 97.0 if mode == &"full" else 33.0
			main.combat.try_skill()
			await _frames(56)
		else:
			main._elapsed_time = 59.0
			main.player.position.x = main.level.data.get_finish_x() - 65.0
			await _frames(15)
		var record := profile.history.get_record(LEVEL, mode)
		_check(main._finished and record.get("completions", 0) == 1 and is_equal_approx(float(record.get("best_time", 0.0)), main.run_result.time_seconds), "Actual completion callback must record the correct mode once: %s" % mode)
		main._on_finish_reached()
		_check(profile.history.get_record(LEVEL, mode).completions == 1, "Repeated finish signals cannot inflate completion count")
		_check(main.save_status.text == "成绩已保存", "Successful results must show save status")
		paused = false
		main.free()
	var before := profile.history.to_dictionary()
	var failure: Node2D = load("res://scenes/main.tscn").instantiate()
	root.add_child(failure)
	failure.player.take_damage(failure.player.health)
	await _frames(2)
	_check(failure._finished and profile.history.to_dictionary() == before, "Death must not write a completed run")
	paused = false
	failure.free()
	var unsaved: Node2D = load("res://scenes/practice.tscn").instantiate()
	root.add_child(unsaved)
	var original_path := profile.save_path
	profile.save_path = "res://.godot/missing-save-directory/save.json"
	unsaved._elapsed_time = 65.0
	unsaved.player.position.x = unsaved.level.data.get_finish_x() - 65.0
	await _frames(15)
	_check(unsaved._finished and profile.save_pending and unsaved.save_retry.visible and unsaved.save_status.text.contains("暂未保存"), "A real completion with unavailable storage must keep the result and expose retry")
	profile.save_path = original_path
	unsaved.save_retry.pressed.emit()
	_check(not profile.save_pending and not unsaved.save_retry.visible and profile.history.get_record(LEVEL, &"parkour_practice").completions == 2, "Result retry must save once without duplicating the completion")
	paused = false
	unsaved.free()
	before = profile.history.to_dictionary()
	var abandoned: Node2D = load("res://scenes/practice.tscn").instantiate()
	root.add_child(abandoned)
	current_scene = abandoned
	abandoned._return_to_setup()
	await _frames(5)
	_check(profile.history.to_dictionary() == before, "Returning to preparation mid-run must not create a completion")
	current_scene.free()

func _test_preparation_records() -> void:
	var setup: Control = load("res://scenes/ui/character_setup.tscn").instantiate()
	root.add_child(setup)
	var full := PlayerProfile.current().history.get_record(LEVEL, &"full")
	_check(setup.history_labels[&"full"].text.contains("最高分 %d" % full.best_score) and setup.history_labels[&"full"].text.contains("50 / 50"), "Preparation must display saved full-run score and collection")
	_check(setup.history_labels[&"boss_practice"].text.contains("不计整关评级") and not setup.history_labels[&"boss_practice"].text.contains("最高分"), "Boss practice must retain its own timing without presenting a full-run rank")
	setup.free()

func _result(seconds: float = 100.0, damage: int = 0, collected: int = 50) -> RunResult:
	return RunResult.calculate(seconds, 100.0, damage, collected, 50, 1, 4)

func _write(path: String, text: String) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(text)
	file.close()

func _cleanup_store() -> void:
	for suffix in ["", ".tmp", ".bak", ".bak.tmp", ".corrupt"]:
		if FileAccess.file_exists(STORE_PATH + suffix):
			DirAccess.remove_absolute(ProjectSettings.globalize_path(STORE_PATH + suffix))

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
