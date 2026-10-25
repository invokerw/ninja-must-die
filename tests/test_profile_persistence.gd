extends SceneTree

const PATH := "res://.godot/test-profile-restart.json"

func _initialize() -> void:
	var profile := PlayerProfile.new(PATH)
	profile.load_profile()
	var character := load("res://data/characters/shadow_runner.tres") as CharacterData
	if OS.get_cmdline_user_args().has("--write"):
		if not profile.try_equip(character, &"star_lance") or not profile.save_profile():
			push_error("Cross-process profile write failed")
			quit(1)
			return
		print("PROFILE_WRITE_PASS")
	else:
		if profile.get_equipped_weapon(character).weapon_id != &"star_lance":
			push_error("A fresh process did not restore the selected weapon")
			quit(1)
			return
		DirAccess.remove_absolute(ProjectSettings.globalize_path(PATH))
		print("PROFILE_RELOAD_PASS")
	quit(0)
