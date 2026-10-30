extends SceneTree

const MAIN := preload("res://scenes/main.tscn")
const OUTPUT := "res://art/validation/hud_open_20261030/"

func _initialize() -> void:
	_render.call_deferred()

func _render() -> void:
	if DisplayServer.get_name() == "headless":
		push_error("HUD capture requires the graphical renderer.")
		quit(1)
		return
	var scope := TestProfileScope.new("hud-open-preview")
	FeedbackSettings.sound_enabled = false
	FeedbackSettings.particles_enabled = false
	DirAccess.make_dir_recursive_absolute(OUTPUT)
	for spec in [[1280, "top"], [1600, "wide"], [1280, "low_health"], [1280, "boss"]]:
		var viewport := SubViewport.new()
		viewport.size = Vector2i(spec[0], 720)
		viewport.world_2d = World2D.new()
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var main := MAIN.instantiate()
		main.force_touch_controls = true
		viewport.add_child(main)
		main._completion_recorded = true
		main.set_process(false)
		main.player.set_physics_process(false)
		main.player.global_position.x = 1500.0
		main.player.position.y = 486.0
		main.player.velocity.x = main.player.tuning.run_speed
		(main.player.get_node("Camera2D") as Camera2D).position_smoothing_enabled = false
		main._elapsed_time = 0.3
		if spec[1] == "low_health":
			main.player.health = 1
			main.player.crystals = 12
			main._elapsed_time = 32.7
		if spec[1] == "boss":
			main.level._begin_boss()
			main.level.boss.set_physics_process(false)
			main.level.boss.global_position = Vector2(2020, 480)
		main.touch_controls.sync_state()
		main._update_status()
		for frame in range(5):
			await process_frame
		await RenderingServer.frame_post_draw
		var target := OUTPUT + "hud_%s_%s.png" % spec
		var error := viewport.get_texture().get_image().save_png(target)
		if error != OK:
			push_error("Cannot save " + target)
			scope.close()
			quit(1)
			return
		print("HUD_CAPTURE ", target)
		viewport.free()
	scope.close()
	quit()
