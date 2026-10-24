extends SceneTree

const MAIN_SCENE := preload("res://scenes/main.tscn")

var _failures := 0

func _initialize() -> void:
	for action in ["jump", "drop", "dash", "skill"]:
		if not InputMap.has_action(action):
			InputMap.add_action(action)
	_run.call_deferred()

func _run() -> void:
	_test_data()
	await _test_screen_anchor()
	await _test_fixed_direction_and_formation()
	await _test_windup_and_hit()
	await _test_flip_and_jump()
	await _test_protected_contacts()
	await _test_fast_crossings()
	await _test_independent_flight()
	await _test_pause_and_stop()
	await _test_lifetime()
	await _test_single_contact()
	await _test_level_lifecycle()
	if _failures == 0:
		print("PROJECTILES_PASS (screen anchor, fixed direction, parallel volleys/gaps, full flight, single contact, protection, swept hits, pause/reload/finish)")
	quit(0 if _failures == 0 else 1)

func _test_data() -> void:
	var level := RopeLevelData.new()
	var segment := RopeSegmentData.new()
	segment.segment_id = &"ranged"
	segment.title = "Ranged encounter"
	var enemy := RopeEnemyData.new()
	enemy.offset_x = 2000.0
	enemy.enemy_type = "shooter"
	segment.enemies.append(enemy)
	level.segments.append(segment)
	_check(level.get_validation_errors().is_empty(), "A standalone ranged encounter must be valid")
	var pickup := RopePickupData.new()
	pickup.offset_x = 2000.0
	segment.pickups.append(pickup)
	_check(level.get_validation_errors().is_empty(), "A screen emitter trigger must not act as an enemy body on the rope")
	pickup.offset_x = 2540.0
	_check(not level.get_validation_errors().is_empty(), "Validation must reject a crystal at the projected screen-origin shot encounter")
	pickup.cable_side = "bottom"
	_check(level.get_validation_errors().is_empty(), "The opposite lane must remain a valid collection route")
	enemy.windup_seconds = 0.2
	_check(not level.get_validation_errors().is_empty(), "Unreadably short telegraphs must be rejected")
	enemy.windup_seconds = 0.8
	enemy.projectile_speed = 0.0
	_check(not level.get_validation_errors().is_empty(), "Stationary projectiles must be rejected")
	enemy.projectile_speed = 720.0
	enemy.screen_edge_offset = 200.0
	_check(not level.get_validation_errors().is_empty(), "A source too far from the screen edge must be rejected")
	enemy.screen_edge_offset = 48.0
	enemy.screen_height_ratio = 1.2
	_check(not level.get_validation_errors().is_empty(), "A source beyond the vertical viewport must be rejected")
	enemy.screen_height_ratio = 0.55
	enemy.fire_direction = Vector2.ZERO
	_check(not level.get_validation_errors().is_empty(), "A zero firing direction must be rejected")
	enemy.fire_direction = Vector2.RIGHT
	_check(not level.get_validation_errors().is_empty(), "A right-facing direction must be rejected")
	enemy.fire_direction = Vector2(-1.0, 0.12)
	enemy.volley_count = 0
	_check(not level.get_validation_errors().is_empty(), "An empty volley must be rejected")
	enemy.volley_count = 3
	enemy.volley_spacing = 48.0
	_check(not level.get_validation_errors().is_empty(), "A volley with no room for the player must be rejected")
	enemy.volley_spacing = 144.0
	enemy.enemy_type = "unknown"
	_check(not level.get_validation_errors().is_empty(), "Unknown enemy types must be rejected")

func _arena(parent: Node = null) -> Node2D:
	var arena := Node2D.new()
	(parent if parent != null else root).add_child(arena)
	var scene := MAIN_SCENE.instantiate()
	var player := scene.get_node("Player") as PlayerController
	scene.remove_child(player)
	scene.free()
	player.tuning = load("res://data/control_tuning.tres").duplicate(true)
	arena.add_child(player)
	(player.get_node("Camera2D") as Camera2D).position_smoothing_enabled = false
	player.active = true
	return arena

func _shooter(player: PlayerController, side: String = "top") -> ScreenShooter:
	var shooter := ScreenShooter.new()
	shooter.trigger_x = player.position.x
	shooter.cable_side = side
	shooter.screen_height_ratio = 0.55 if side == "top" else 0.8
	shooter.fire_direction = Vector2(-1.0, 0.12) if side == "top" else Vector2(-1.0, -0.04)
	shooter.bind_player(player)
	var source_root := CanvasLayer.new()
	player.get_parent().add_child(source_root)
	shooter.projectile_parent = player.get_parent()
	source_root.add_child(shooter)
	return shooter

func _shot(player: PlayerController, offset: Vector2 = Vector2(30, 0), speed: float = 360.0) -> EnemyProjectile:
	var shot := EnemyProjectile.new()
	shot.target = player
	shot.position = player.position + offset
	shot.velocity = Vector2(-speed, 0)
	player.get_parent().add_child(shot)
	return shot

func _shots(arena: Node) -> Array[EnemyProjectile]:
	var shots: Array[EnemyProjectile] = []
	for child in arena.get_children():
		if child is EnemyProjectile and not child.spent:
			shots.append(child)
	return shots

func _test_screen_anchor() -> void:
	for size in [Vector2i(960, 720), Vector2i(1280, 720), Vector2i(1600, 900)]:
		var viewport := SubViewport.new()
		viewport.size = size
		viewport.world_2d = World2D.new()
		root.add_child(viewport)
		var arena := _arena(viewport)
		var player := arena.get_node("Player") as PlayerController
		player.position.x = 5000.0
		var shooter := _shooter(player)
		# Keep this test focused on positioning, without firing during camera checks.
		shooter.trigger_x = 100000.0
		await _frames(3)
		var screen := shooter.get_global_transform_with_canvas().origin
		_check(absf(screen.x - float(size.x) - 48.0) < 1.0, "Emitter must stay beyond the actual right edge at %s" % size)
		_check(absf(screen.y - float(size.y) * 0.55) < 1.0, "Emitter height must use the actual viewport")
		var world_x := shooter.get_world_origin().x
		player.position.x += 400.0
		await _frames(3)
		screen = shooter.get_global_transform_with_canvas().origin
		_check(shooter.get_world_origin().x > world_x + 300.0 and absf(screen.x - float(size.x) - 48.0) < 1.0, "Camera scrolling must move the source through the world while its screen position stays fixed")
		(player.get_node("Camera2D") as Camera2D).zoom = Vector2(1.25, 1.25)
		await _frames(3)
		screen = shooter.get_global_transform_with_canvas().origin
		_check(absf(screen.x - float(size.x) - 48.0) < 1.0, "Camera zoom must preserve the screen anchor")
		viewport.size = size + Vector2i(160, 80)
		await _frames(3)
		screen = shooter.get_global_transform_with_canvas().origin
		_check(absf(screen.x - float(viewport.size.x) - 48.0) < 1.0, "Live resizing must update the screen anchor")
		shooter.screen_edge_offset = -48.0
		await _frames(2)
		screen = shooter.get_global_transform_with_canvas().origin
		_check(absf(screen.x - float(viewport.size.x) + 48.0) < 1.0, "An inset configuration must keep a floating source at the visible right edge")
		viewport.free()

func _test_fixed_direction_and_formation() -> void:
	var previous_velocity := Vector2.ZERO
	for count in [1, 3, 5]:
		var arena := _arena()
		var player := arena.get_node("Player") as PlayerController
		player.position.x = float(count * 1000)
		player.tuning.run_speed = 250.0 if count == 1 else 420.0
		var shooter := _shooter(player)
		shooter.fire_direction = Vector2(-1.0, 0.2)
		shooter.volley_count = count
		var velocities: Array[Vector2] = []
		var positions: Array[Vector2] = []
		var screen_positions: Array[Vector2] = []
		shooter.projectile_fired.connect(func(projectile: EnemyProjectile) -> void:
			velocities.append(projectile.velocity)
			positions.append(projectile.global_position)
			screen_positions.append(projectile.get_global_transform_with_canvas().origin)
		)
		await _frames(47)
		# Change the player's height immediately before firing; it must not steer the shot.
		if count > 1:
			player.on_rope = false
			player.position.y = 200.0
			player.velocity.y = 0.0
		await _frames(2)
		_check(velocities.size() == count and shooter.volleys_fired == 1, "The selected count must fire together in one volley")
		for index in range(velocities.size()):
			_check(absf(velocities[index].y / -velocities[index].x - 0.2) < 0.0001, "Firing angle must equal the configured direction regardless of player position or speed")
			_check(screen_positions[index].x > root.get_visible_rect().end.x, "Every parallel row must start outside the right edge")
			if previous_velocity != Vector2.ZERO:
				_check(velocities[index].is_equal_approx(previous_velocity), "All rows and encounters must keep the same selected velocity")
			previous_velocity = velocities[index]
			if index > 0:
				var separation := positions[index] - positions[index - 1]
				_check(absf(separation.length() - 144.0) < 0.1 and absf(separation.dot(velocities[index].normalized())) < 0.1, "Bullets must form a spaced column perpendicular to their common trajectory")
		arena.free()

func _test_windup_and_hit() -> void:
	for side in ["top", "bottom"]:
		var arena := _arena()
		var player := arena.get_node("Player") as PlayerController
		if side == "bottom":
			await _tap("drop")
		var combat := player.get_node("Combat") as RunnerCombat
		player.collect_crystal()
		var shooter := _shooter(player, side)
		var launch_positions: Array[Vector2] = []
		shooter.projectile_fired.connect(func(projectile: EnemyProjectile) -> void: launch_positions.append(projectile.get_global_transform_with_canvas().origin))
		await _frames(1)
		_check(shooter.attack_state == ScreenShooter.AttackState.WINDUP and shooter.shots_fired == 0, "Screen attack must start with a visible telegraph")
		await _frames(47)
		_check(shooter.shots_fired == 0 and _shots(arena).is_empty(), "The entire 0.8 second windup must precede the shot")
		await _frames(1)
		_check(shooter.shots_fired == 3 and shooter.volleys_fired == 1 and _shots(arena).size() == 3, "Each encounter must emit one three-bullet volley after its windup")
		if not _shots(arena).is_empty():
			_check(launch_positions.size() == 3 and launch_positions[0].x > root.get_visible_rect().end.x, "An actual volley must originate outside the right edge")
		await _frames(65)
		_check(player.health == 2 and player.damage_count == 1 and combat.combo == 0, "An unprotected same-lane shot must deal one hit and break combo")
		_check(not _shots(arena).is_empty(), "Bullets must continue across the screen after passing or hitting the player")
		await _frames(60)
		_check(shooter.shots_fired == 3 and _shots(arena).is_empty(), "The volley must finish its flight and leave the screen without repeated firing")
		arena.free()

func _test_flip_and_jump() -> void:
	for action in ["drop", "jump"]:
		var arena := _arena()
		var player := arena.get_node("Player") as PlayerController
		_shooter(player)
		await _frames(96 if action == "jump" else 50)
		_check(_shots(arena).size() == 3, "Evasion fixture must contain a real parallel volley with gaps")
		await _tap(action)
		await _frames(40)
		_check(player.damage_count == 0, "A timely %s must avoid a screen-origin shot without a skill" % action)
		arena.free()

func _test_protected_contacts() -> void:
	for action in ["skill", "dash"]:
		var arena := _arena()
		var player := arena.get_node("Player") as PlayerController
		player.collect_crystal()
		var shot := _shot(player)
		await _tap(action)
		_check(is_instance_valid(shot) and shot.contact_resolved and player.damage_count == 0, "Same-frame %s must protect before contact while the bullet continues flying" % action)
		_check((player.get_node("Combat") as RunnerCombat).combo == 1, "Protected contacts must preserve combo")
		await _frames(125)
		_check(player.damage_count == 0, "An already resolved contact must not damage again after immunity expires")
		arena.free()
	var arena := _arena()
	var player := arena.get_node("Player") as PlayerController
	player.take_damage()
	player.collect_crystal()
	_shot(player)
	await _frames(3)
	_check(player.damage_count == 1 and (player.get_node("Combat") as RunnerCombat).combo == 1, "Hurt immunity must also protect against projectiles")
	await _frames(50)
	_shot(player)
	await _frames(3)
	_check(player.damage_count == 2, "New shots must damage normally after protection ends")
	arena.free()

func _test_fast_crossings() -> void:
	var arena := _arena()
	var player := arena.get_node("Player") as PlayerController
	await _frames(2)
	_shot(player, Vector2(240, 0), 30000.0)
	await _frames(1)
	_check(player.damage_count == 1, "A projectile crossing the entire body in one tick must not tunnel")
	arena.free()
	arena = _arena()
	player = arena.get_node("Player")
	await _frames(2)
	_shot(player, Vector2(240, 0))
	player.tuning.run_speed = 30000.0
	await _frames(1)
	_check(player.damage_count == 1, "A player crossing a shot in one tick must also register contact")
	arena.free()
	arena = _arena()
	player = arena.get_node("Player")
	await _frames(2)
	_shot(player, Vector2(240, 68), 30000.0)
	await _frames(1)
	_check(player.damage_count == 0, "Swept collision must preserve separation between rope lanes")
	arena.free()

func _test_independent_flight() -> void:
	var arena := _arena()
	var player := arena.get_node("Player") as PlayerController
	var shooter := _shooter(player)
	await _tap("skill")
	await _frames(12)
	_check(shooter.attack_state == ScreenShooter.AttackState.WINDUP and (player.get_node("Combat") as RunnerCombat).kills == 0, "A remote source must not become a rope enemy or a skill kill")
	await _frames(36)
	_check(_shots(arena).size() == 3, "Fixture must contain a fired parallel volley")
	if not _shots(arena).is_empty():
		var shot := _shots(arena)[0]
		var velocity := shot.velocity
		var position := shot.global_position
		shooter.free()
		await _tap("drop")
		await _frames(4)
		_check(is_instance_valid(shot) and shot.velocity == velocity and shot.global_position != position, "A fired projectile must follow its fixed world trajectory after the source disappears or player changes lane")
	player.stop()
	await _frames(2)
	arena.free()

func _test_pause_and_stop() -> void:
	var arena := _arena()
	var player := arena.get_node("Player") as PlayerController
	var shooter := _shooter(player)
	var shot := _shot(player, Vector2(500, 68))
	await _frames(4)
	var windup := shooter.windup_remaining
	var position := shot.position
	var lifetime := shot.lifetime_remaining
	paused = true
	await _frames(20)
	_check(shooter.windup_remaining == windup and shot.position == position and shot.lifetime_remaining == lifetime, "Pause must freeze telegraphs, projectile motion and lifetime")
	paused = false
	await _frames(48)
	_check(shooter.shots_fired == 3 and shooter.volleys_fired == 1 and not _shots(arena).is_empty(), "Resume must continue the pending volley exactly once")
	player.stop()
	_check(shooter.attack_state == ScreenShooter.AttackState.SPENT and shooter.windup_remaining == 0.0, "Stop must cancel windup synchronously")
	await _frames(2)
	_check(_shots(arena).is_empty(), "Stop must remove every live shot")
	arena.free()

func _test_lifetime() -> void:
	var arena := _arena()
	var player := arena.get_node("Player") as PlayerController
	var shot := _shot(player, Vector2(500, -150), 1.0)
	shot.lifetime_remaining = 0.2
	await _frames(14)
	_check(not is_instance_valid(shot), "An unmatched shot must expire on a bounded lifetime")
	shot = _shot(player, Vector2(-120, 68))
	await _frames(2)
	_check(is_instance_valid(shot) and shot.get_global_transform_with_canvas().origin.x > 0.0, "Passing behind the player must not remove a bullet that is still onscreen")
	await _frames(60)
	_check(not is_instance_valid(shot), "Bullets must be removed after completing their flight off the left edge")
	arena.free()

func _test_single_contact() -> void:
	var arena := _arena()
	var player := arena.get_node("Player") as PlayerController
	var shot := _shot(player, Vector2.ZERO)
	shot.velocity = Vector2(player.tuning.run_speed, 0.0)
	await _frames(125)
	_check(is_instance_valid(shot) and shot.contact_resolved and player.damage_count == 1, "A bullet overlapping beyond hurt immunity must still resolve contact only once")
	arena.free()

func _test_level_lifecycle() -> void:
	var main := MAIN_SCENE.instantiate()
	root.add_child(main)
	current_scene = main
	var shooters: Array[ScreenShooter] = main.level.shooters
	_check(shooters.size() == 2 and shooters[0].cable_side != shooters[1].cable_side, "The shipped route must include a ranged encounter on each lane")
	_check(main.level.enemies.size() == 5, "Remote sources must not leave enemy bodies on the rope")
	main.player.position.x = shooters[0].trigger_x
	(main.player.get_node("Camera2D") as Camera2D).reset_smoothing()
	await _frames(2)
	_check(main.threat_text.text.contains("蓄力"), "The actual ranged telegraph must remain visible beside a nearby same-lane hazard")
	var shot := EnemyProjectile.new()
	shot.target = main.player
	shot.position = main.player.position + Vector2(400, 0)
	main.level.projectile_root.add_child(shot)
	await _frames(1)
	_check(main.threat_text.text.contains("飞弹"), "HUD must warn about a live shot rather than report a safe lane")
	main._restart_run()
	await _frames(2)
	main = current_scene
	_check(not is_instance_valid(shot) and main.level.projectile_root.get_child_count() == 0, "Reload must discard old shots")
	for shooter in main.level.shooters:
		_check(shooter.attack_state == ScreenShooter.AttackState.IDLE and shooter.shots_fired == 0, "Reload must reset ranged encounter state")
	shot = EnemyProjectile.new()
	shot.target = main.player
	shot.position = Vector2(main.level.data.get_finish_x() + 200.0, main.player.position.y)
	main.level.projectile_root.add_child(shot)
	main.player.position.x = main.level.data.get_finish_x() - 60.0
	await _frames(20)
	_check(main._finished and main.result_title.text.contains("完成") and not is_instance_valid(shot), "Finish must remove in-flight shots even when results pause the tree")
	paused = false
	main.free()
	main = MAIN_SCENE.instantiate()
	root.add_child(main)
	shot = EnemyProjectile.new()
	shot.target = main.player
	shot.position = main.player.position + Vector2(400, 0)
	main.level.projectile_root.add_child(shot)
	main.player.take_damage(main.player.health)
	await _frames(2)
	_check(main._finished and not is_instance_valid(shot), "Death must also remove shots while the tree is paused")
	paused = false
	main.free()

func _tap(action: StringName) -> void:
	Input.action_press(action)
	await _frames(1)
	Input.action_release(action)
	await _frames(1)

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
