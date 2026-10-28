extends SceneTree

const MAIN := preload("res://scenes/main.tscn")
const SETUP := preload("res://scenes/ui/character_setup.tscn")
const OUTPUT := "res://art/validation/p1_player_20261027/"

func _initialize() -> void:
	_render.call_deferred()

func _render() -> void:
	if DisplayServer.get_name() == "headless":
		push_error("Artwork capture requires the graphical renderer.")
		quit(1)
		return
	var scope := TestProfileScope.new("production-art-render")
	TouchControls.preview_enabled = true
	FeedbackSettings.sound_enabled = false
	FeedbackSettings.particles_enabled = false
	DirAccess.make_dir_recursive_absolute(OUTPUT)
	for spec in [[1280, "top"], [1280, "bottom"], [1280, "air"], [1280, "jump"], [1280, "dash"], [1280, "flip"], [1280, "hurt"], [1280, "death"], [1600, "cooldown"], [1280, "boss"], [1280, "boss_armored"], [1280, "boss_weak"], [1280, "boss_defeated"], [1280, "sentry"], [1280, "skill"], [1280, "setup"], [1280, "wrap"]]:
		var viewport := SubViewport.new()
		viewport.size = Vector2i(spec[0], 720)
		viewport.world_2d = World2D.new()
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		if spec[1] == "setup":
			viewport.add_child(SETUP.instantiate())
		else:
			var main := MAIN.instantiate()
			main.force_touch_controls = true
			viewport.add_child(main)
			main._completion_recorded = true
			main.player.set_physics_process(false)
			var camera := main.player.get_node("Camera2D") as Camera2D
			camera.position_smoothing_enabled = false
			main.player.global_position.x = 1500.0
			main.player.velocity.x = main.player.tuning.run_speed
			main.player.on_rope = spec[1] not in ["air", "jump"]
			main.player.rope_side = PlayerController.ROPE_BOTTOM if spec[1] == "bottom" else PlayerController.ROPE_TOP
			main.player.position.y = 554 if spec[1] == "bottom" else (420 if spec[1] in ["air", "jump"] else 486)
			if spec[1] == "jump":
				main.player.velocity.y = -200.0
			if spec[1] == "dash":
				main.player.dash_remaining = 0.2
				main.player.state = PlayerController.State.DASH
			if spec[1] == "flip":
				main.player.rope_flip_feedback_remaining = 0.2
			if spec[1] == "hurt":
				main.player.damage_count = 1
			if spec[1] == "death":
				main.player.health = 0
				main.player.active = false
			if spec[1] == "wrap":
				main.player.position.x = 9000.0
			if spec[1] == "sentry":
				main.level.enemies[0].position = Vector2(1800, 486)
			if spec[1] == "skill":
				main.combat.skill_flash_remaining = 0.3
				main.combat._strike_origin = main.player.global_position
			if spec[1] == "cooldown":
				main.player.dash_cooldown = 0.3
				main.combat.skill_cooldown_remaining = 7.2
				main.combat.weapon.cooldown_remaining = 3.5
			if str(spec[1]).begins_with("boss"):
				main.level._begin_boss()
				main.level.boss.set_physics_process(false)
				main.level.boss.global_position = Vector2(2020, 480)
				main.level.boss.health = 80
				main.level.boss.enraged = true
				main.level.boss.state = RopeBoss.State.RECOVERY
				main.level.boss.remaining = 2.0
				if spec[1] == "boss_armored":
					main.level.boss.state = RopeBoss.State.WINDUP
				if spec[1] == "boss_weak":
					main.level.boss.enraged = false
				if spec[1] == "boss_defeated":
					main.level.boss.state = RopeBoss.State.DEFEATED
					main.level.boss.remaining = 0.4
			main.touch_controls.sync_state()
			main._update_status()
		for index in range(4):
			await process_frame
		await RenderingServer.frame_post_draw
		var target := OUTPUT + "game_%s_%s.png" % spec
		var error := viewport.get_texture().get_image().save_png(target)
		if error != OK:
			push_error("Cannot save " + target)
			quit(1)
			return
		print("ART_CAPTURE ", target)
		viewport.free()
	# Render a true gameplay loop, sampling the visual phase without advancing physics.
	var animation_viewport := SubViewport.new()
	animation_viewport.size = Vector2i(1280, 720)
	animation_viewport.world_2d = World2D.new()
	animation_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(animation_viewport)
	var animation_main := MAIN.instantiate()
	animation_main.force_touch_controls = true
	animation_viewport.add_child(animation_main)
	animation_main._completion_recorded = true
	animation_main.player.set_physics_process(false)
	(animation_main.player.get_node("Camera2D") as Camera2D).position_smoothing_enabled = false
	animation_main.player.position.x = 1500
	animation_main.player.velocity = Vector2(animation_main.player.tuning.run_speed, 0)
	var visual := animation_main.player.get_node("PaintedVisual") as PaintedPlayerVisual
	visual.set_process(false)
	visual.animation = &"run"
	for index in range(8):
		visual.animation_time = (index + 0.1) / 14.0
		visual.queue_redraw()
		for frame in range(3):
			await process_frame
		await RenderingServer.frame_post_draw
		animation_viewport.get_texture().get_image().save_png(OUTPUT + "run_%02d.png" % index)
	animation_viewport.free()
	TouchControls.preview_enabled = false
	scope.close()
	quit()
