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
		print("PROFILE_WRITE_PASS")
	else:
		FeedbackSettings.apply(profile.feedback_settings)
		var record := profile.history.get_record(&"fog_ridge_60s", &"full")
		if profile.get_equipped_weapon(character).weapon_id != &"star_lance" or FeedbackSettings.sound_enabled or FeedbackSettings.particles_enabled or FeedbackSettings.shake_enabled or FeedbackSettings.flash_enabled or record.get("best_time", 0.0) != 98.4 or record.get("best_rank", "") != "S" or profile.history.get_record(&"fog_ridge_60s", &"boss_practice").get("best_time", 0.0) != 34.3:
			push_error("A fresh process did not restore equipment, settings and separate records")
			quit(1)
			return
		for suffix in ["", ".bak", ".tmp", ".bak.tmp"]:
			if FileAccess.file_exists(PATH + suffix):
				DirAccess.remove_absolute(ProjectSettings.globalize_path(PATH + suffix))
		print("PROFILE_RELOAD_PASS")
	quit(0)
