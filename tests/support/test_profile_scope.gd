class_name TestProfileScope
extends RefCounted

var profile: PlayerProfile
var _previous: PlayerProfile
var _settings: Dictionary

func _init(suite: String) -> void:
	_previous = PlayerProfile._shared
	_settings = FeedbackSettings.snapshot()
	profile = PlayerProfile.new("res://.godot/test-isolated-%s.json" % suite)
	_cleanup()
	profile.load_profile()
	PlayerProfile._shared = profile
	FeedbackSettings.apply(profile.feedback_settings)

func close() -> void:
	PlayerProfile._shared = _previous
	FeedbackSettings.apply(_settings)
	_cleanup()

func _cleanup() -> void:
	for suffix in ["", ".tmp", ".bak", ".bak.tmp", ".corrupt"]:
		var path := ProjectSettings.globalize_path(profile.save_path + suffix)
		if FileAccess.file_exists(path):
			DirAccess.remove_absolute(path)
