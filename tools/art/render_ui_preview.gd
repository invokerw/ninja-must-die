extends SceneTree

const PREVIEW := preload("res://scenes/art/ui_touch_preview.tscn")
const OUTPUT := "res://art/workbench/ui_touch_combat_v02_20261026_01/inspection/"

func _initialize() -> void:
	_render.call_deferred()

func _render() -> void:
	if DisplayServer.get_name() == "headless":
		push_error("UI capture needs the graphical renderer; omit --headless.")
		quit(1)
		return
	var scope := TestProfileScope.new("ui-art-render")
	var output := OUTPUT
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--output-dir="):
			output = argument.trim_prefix("--output-dir=")
	if DirAccess.make_dir_recursive_absolute(output) != OK:
		push_error("Cannot create preview output directory: %s" % output)
		scope.close()
		quit(1)
		return
	FeedbackSettings.sound_enabled = false
	FeedbackSettings.particles_enabled = false
	for spec in [[1280, "top"], [1280, "bottom"], [1280, "air"], [1600, "cooldown"]]:
		var viewport := SubViewport.new()
		viewport.size = Vector2i(spec[0], 720)
		viewport.world_2d = World2D.new()
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var main := PREVIEW.instantiate()
		main.get_node("Level").boss_data = null
		viewport.add_child(main)
		main.player.set_physics_process(false)
		(main.player.get_node("Camera2D") as Camera2D).position_smoothing_enabled = false
		main.player.on_rope = spec[1] != "air"
		main.player.rope_side = PlayerController.ROPE_BOTTOM if spec[1] == "bottom" else PlayerController.ROPE_TOP
		main.player.position.y = 554 if spec[1] == "bottom" else (420 if spec[1] == "air" else 486)
		if spec[1] == "cooldown":
			main.player.dash_cooldown = 0.3
			main.combat.skill_cooldown_remaining = 7.2
			main.combat.weapon.cooldown_remaining = 3.5
		if spec[1] == "air":
			main.touch_controls._press_finger(0, main.touch_controls.get_action_rect(&"rope_flip").get_center())
		main.touch_controls.sync_state()
		await process_frame
		await RenderingServer.frame_post_draw
		var image := viewport.get_texture().get_image()
		var target := output.path_join("ui_candidate_%s_%s.png" % spec)
		var error := image.save_png(target)
		if error != OK:
			push_error("Cannot save preview: %s" % target)
			quit(1)
			return
		print("UI_CAPTURE ", target, " ", image.get_size())
		main.touch_controls.release_all()
		viewport.free()
	scope.close()
	quit()
