extends SceneTree

const PATH := "res://.godot/test-profile-restart.json"

func _initialize() -> void:
	if OS.get_cmdline_user_args().has("--write"):
		for suffix in ["", ".bak", ".tmp", ".bak.tmp", ".corrupt"]:
			if FileAccess.file_exists(PATH + suffix):
				DirAccess.remove_absolute(ProjectSettings.globalize_path(PATH + suffix))
	var profile := PlayerProfile.new(PATH)
	profile.load_profile()
	var character := load("res://data/characters/shadow_runner.tres") as CharacterData
	if OS.get_cmdline_user_args().has("--write"):
		if not profile.try_equip(character, &"star_lance") or not profile.save_profile():
			push_error("Cross-process profile write failed")
			quit(1)
			return
		profile.set_feedback_setting("sound", false)
		profile.set_feedback_setting("particles", false)
		profile.set_feedback_setting("shake", false)
		profile.set_feedback_setting("flash", false)
		if not profile.record_completion(&"fog_ridge_60s", &"full", RunResult.calculate(98.4, 100.0, 0, 50, 50, 1, 8)) or not profile.record_completion(&"fog_ridge_60s", &"boss_practice", RunResult.calculate(34.3, 40.0, 0, 0, 50, 1, 1)):
			push_error("Cross-process records/settings write failed")
			quit(1)
			return
		var formal := RunResult.calculate(85.0, 85.0, 1, 40, 50, 0, 4)
		formal.capture_context(LevelCatalog.WIND_BAMBOO_ID, &"full", "cross-process-formal", profile.resolve(character))
		formal.apply_formal_rules()
		formal.completed = true
		if not profile.record_completion(LevelCatalog.WIND_BAMBOO_ID, &"full", formal):
			push_error("Cross-process star snapshot write failed")
			quit(1)
			return
		if not profile.upgrade_growth(&"weapon_training") or not profile.purchase(&"guard_charm") or not profile.purchase(&"guard_charm") or not profile.select_item(&"guard_charm") or not profile.consume_selected_item("cross-process-supply"):
			push_error("Cross-process economy write failed")
			quit(1)
			return
		var first_clear := RunResult.calculate(98.4, 60.0, 0, 50, 50, 1, 8)
		first_clear.capture_context(LevelCatalog.FOG_RIDGE_ID, &"full", "cross-process-unlock", profile.resolve(character))
		first_clear.apply_formal_rules()
		first_clear.completed = true
		if not profile.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", first_clear):
			push_error("Cross-process character entitlement write failed")
			quit(1)
			return
		var wind := CharacterRegistry.get_character(&"wind_scout")
		if not profile.try_equip(wind, &"crescent_wheel") or not profile.try_select_character(&"wind_scout") or not profile.save_profile():
			push_error("Cross-process selected character write failed")
			quit(1)
			return
		print("PROFILE_WRITE_PASS")
	else:
		FeedbackSettings.apply(profile.feedback_settings)
		var record := profile.history.get_record(&"fog_ridge_60s", &"full")
		record = record.get("legacy_record", record)
		if profile.get_equipped_weapon(character).weapon_id != &"star_lance" or FeedbackSettings.sound_enabled or FeedbackSettings.particles_enabled or FeedbackSettings.shake_enabled or FeedbackSettings.flash_enabled or record.get("best_time", 0.0) != 98.4 or record.get("best_rank", "") != "S" or profile.history.get_record(&"fog_ridge_60s", &"boss_practice").get("best_time", 0.0) != 34.3:
			push_error("A fresh process did not restore equipment, settings and separate records")
			quit(1)
			return
		if profile.selected_character_id != &"wind_scout" or profile.resolve().character.character_id != &"wind_scout" or profile.resolve().weapon.weapon_id != &"crescent_wheel" or not profile.owns_character(&"wind_scout") or profile.owns_character(&"thunder_guard"):
			push_error("A fresh process did not restore character ownership and independent equipment")
			quit(1)
			return
		var formal := profile.history.get_record(LevelCatalog.WIND_BAMBOO_ID, &"full")
		if formal.get("best_stars") != 3 or formal.get("flawless") != false or formal.get("best_score") != 2650 or formal.get("best_score_snapshot", {}).get("weapon_id") != "star_lance" or formal.get("best_score_snapshot", {}).get("run_id") != "cross-process-formal":
			push_error("A fresh process did not restore stars and their complete configuration snapshot")
			quit(1)
			return
		var repeated := RunResult.calculate(85.0, 85.0, 1, 40, 50, 0, 4)
		repeated.capture_context(LevelCatalog.WIND_BAMBOO_ID, &"full", "cross-process-formal", profile.resolve(character))
		repeated.apply_formal_rules()
		repeated.completed = true
		if profile.record_completion(LevelCatalog.WIND_BAMBOO_ID, &"full", repeated) or profile.history.get_record(LevelCatalog.WIND_BAMBOO_ID, &"full").completions != 1:
			push_error("A reloaded run ID was recorded twice")
			quit(1)
			return
		if profile.coins != 726 or profile.reward_summary("cross-process-formal").get("total") != 356 or not profile.pending_transaction.is_empty():
			push_error("A fresh process did not restore one atomic wallet/reward-ledger generation")
			quit(1)
			return
		if profile.get_growth_level(&"weapon_training") != 1 or profile.get_inventory(&"guard_charm") != 1 or not profile.economy_state().selected_item_id.is_empty() or profile.economy_state().economy_ledger.get("consumptions", {}).get("cross-process-supply") != "guard_charm":
			push_error("A fresh process did not restore growth, inventory and consumption ledger")
			quit(1)
			return
		if not profile.consume_selected_item("cross-process-supply") or profile.get_inventory(&"guard_charm") != 1:
			push_error("A reloaded consumption ID deducted another supply")
			quit(1)
			return
		for suffix in ["", ".bak", ".tmp", ".bak.tmp"]:
			if FileAccess.file_exists(PATH + suffix):
				DirAccess.remove_absolute(ProjectSettings.globalize_path(PATH + suffix))
		print("PROFILE_RELOAD_PASS")
	quit(0)
