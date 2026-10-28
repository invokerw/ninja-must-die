extends SceneTree

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	PlayerProfile._shared = PlayerProfile.new(OS.get_temp_dir().path_join("ninja-p1-pack-profile.json"))
	PlayerProfile._shared.load_profile()
	TouchControls.preview_enabled = true
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	for index in range(4):
		await process_frame
	if not (main.touch_controls is PaintedTouchControls):
		_fail("Exported UI script missing")
		return
	if not (main.touch_controls.skin.textures.size() == 10):
		_fail("Exported button textures missing")
		return
	if not (main.level.get_node("PaintedBackdrop").get_child(0) is PaintedBackdrop):
		_fail("Exported background missing")
		return
	if not (main.player.get_node("PaintedVisual") is PaintedPlayerVisual):
		_fail("Exported player visual missing")
		return
	if PaintedPlayerVisual.ATLAS.get_size() != Vector2(1280, 1024):
		_fail("Exported character atlas missing")
		return
	if PaintedBackdrop.MIDDLE.get_width() != 1582 or Hazard.SPIKE.get_width() != 256:
		_fail("Exported ridge or spike missing")
		return
	if PaintedBackdrop.FOREGROUND.get_width() != 1582 or RopeBoss.ART_WEAK.get_width() != 768:
		_fail("Exported foreground or boss missing")
		return
	if WeaponArt.CRESCENT.get_width() != 256 or RopeSentry.WINGS_UP.get_width() != 256:
		_fail("Exported weapons or sentry missing")
		return
	if load(ProjectSettings.get_setting("application/config/icon")) == null:
		_fail("Exported application icon missing")
		return
	if FileAccess.file_exists("res://art/generated/player_sources_20261027/recovery.json"):
		_fail("Source generation evidence unexpectedly exported")
		return
	if FileAccess.file_exists("res://art/layered/ui_touch_v02_candidate/manifest.json"):
		_fail("Candidate manifest unexpectedly visible; run from an empty working directory")
		return
	if FileAccess.file_exists("res://art/generated/ui/touch_layout.json"):
		_fail("Runtime JSON was not excluded")
		return
	main.free()
	var setup = load("res://scenes/ui/character_setup.tscn").instantiate()
	root.add_child(setup)
	for index in range(4):
		await process_frame
	setup.free()
	print("EXPORTED_ART_PASS (standalone PCK, UI, character, 3 backgrounds, spike, boss, weapons, sentry, icon, setup, no source files or JSON)")
	quit()

func _fail(message: String) -> void:
	push_error(message)
	quit(1)
