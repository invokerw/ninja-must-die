extends SceneTree

var failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var scope := TestProfileScope.new("player-art")
	var scene := load("res://scenes/main.tscn").instantiate() as Node2D
	root.add_child(scene)
	var player: PlayerController = scene.get_node("Player")
	player.set_physics_process(false)
	var visual := player.get_node("PaintedVisual") as PaintedPlayerVisual
	_check(visual != null, "Actual player must own the painted visual")
	var position_before := player.position
	var shape := player.get_node("CollisionShape2D") as CollisionShape2D
	_check(shape.shape is CapsuleShape2D and is_equal_approx(shape.shape.height, 60.0), "Artwork must preserve the 60px capsule")
	player.on_rope = true
	player.rope_side = PlayerController.ROPE_TOP
	player.velocity = Vector2(player.tuning.run_speed, 0.0)
	_check(visual.select_animation() == &"run", "Upper rope must run")
	visual.animation = &"run"
	visual.animation_time = 0.0
	var observed := {}
	for index in range(8):
		visual.animation_time = (index + 0.1) / 14.0
		observed[visual.get_frame_index()] = true
	_check(observed.size() == 8, "Real run animation must visit all eight frames")
	player.rope_side = PlayerController.ROPE_BOTTOM
	_check(visual.select_animation() == &"hang", "Lower rope must use hands-up hanging")
	player.dash_remaining = 0.3
	_check(visual.select_animation() == &"hang", "Under-rope dash must keep hands on the rope")
	player.rope_side = PlayerController.ROPE_TOP
	_check(visual.select_animation() == &"dash", "Upper dash must select dash poses")
	player.dash_remaining = 0.0
	player.on_rope = false
	player.velocity.y = -100.0
	_check(visual.select_animation() == &"jump", "Ascent must use jumping")
	player.velocity.y = 100.0
	_check(visual.select_animation() == &"fall", "Descent must use falling")
	player.rope_flip_feedback_remaining = 0.2
	_check(visual.select_animation() == &"flip", "Accepted flip feedback must select transition")
	player.rope_flip_feedback_remaining = 0.0
	player.damage_count += 1
	visual._process(0.01)
	_check(visual.animation == &"hurt", "Real damage counter must produce hurt pose")
	player.health = 0
	_check(visual.select_animation() == &"death", "Zero health must select defeat")
	player.health = 3
	visual.hurt_remaining = 0.0
	player.on_rope = true
	scene.level._begin_boss()
	var boss: RopeBoss = scene.level.boss
	boss.set_physics_process(false)
	boss.state = RopeBoss.State.WINDUP
	_check(boss.get_art_texture() == RopeBoss.ART_ARMORED, "Windup must show closed armor")
	boss.enraged = true
	_check(boss.get_art_texture() == RopeBoss.ART_ARMORED, "Enrage must not visually open a protected core")
	boss.state = RopeBoss.State.RECOVERY
	_check(boss.get_art_texture() == RopeBoss.ART_ENRAGED, "Enraged recovery must show golden weak point")
	boss.enraged = false
	_check(boss.get_art_texture() == RopeBoss.ART_WEAK, "Normal recovery must show golden weak point")
	boss.state = RopeBoss.State.DEFEATED
	_check(boss.get_art_texture() == RopeBoss.ART_DEFEATED, "Defeated boss must show broken dark core")
	boss.state = RopeBoss.State.RECOVERY
	visual._process(0.1)
	var phase := visual.animation_time
	paused = true
	for index in range(4):
		await process_frame
	_check(is_equal_approx(visual.animation_time, phase), "Pause must freeze animation")
	paused = false
	player.stop()
	visual._process(0.2)
	_check(is_equal_approx(visual.animation_time, phase), "Stopped player must freeze animation")
	_check(player.position == position_before, "Visual updates must never move the body")
	_check(PaintedPlayerVisual.DRAW_RECT.position.y + 228.0 / 3.0 == player.rope_offset, "Run baseline must touch upper rope")
	_check(PaintedPlayerVisual.DRAW_RECT.position.y + 24.0 / 3.0 == -player.rope_offset, "Hand baseline must touch lower rope")
	scene.free()
	scope.close()
	if failures == 0:
		print("PLAYER_ART_PASS (8 run frames, 8 actions, rope anchors, real boss core states, pause, stop, collision invariance)")
	quit(0 if failures == 0 else 1)

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures += 1
		push_error(message)
