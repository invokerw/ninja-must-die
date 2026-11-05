extends SceneTree

const PRACTICE_SCENE := preload("res://scenes/practice.tscn")
const LEVEL_DATA := preload("res://data/levels/wind_bamboo_85s.tres")

var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var profile_scope := TestProfileScope.new("wind_bamboo")
	_test_catalog()
	_test_data()
	await _test_falling_bamboo_pause()
	await _test_full_route()
	if _failures == 0:
		print("WIND_BAMBOO_PASS (catalog, 85 second route, 50 crystals, falling bamboo pause)")
	profile_scope.close()
	quit(0 if _failures == 0 else 1)

func _test_catalog() -> void:
	_check(LevelCatalog.canonicalize(&"fog_ridge_60s") == LevelCatalog.FOG_RIDGE_ID, "Legacy fog ridge ID must resolve to the canonical catalog ID")
	_check(LevelCatalog.get_level(LevelCatalog.WIND_BAMBOO_ID).get("collectible_total", 0) == 50, "Wind bamboo catalog entry must declare fifty crystals")
	_check(LevelCatalog.is_unlocked(LevelCatalog.FOG_RIDGE_ID, []), "The first chapter level must be unlocked for a new profile")
	_check(not LevelCatalog.is_unlocked(LevelCatalog.WIND_BAMBOO_ID, []), "The second level must require the first clear")
	_check(LevelCatalog.is_unlocked(LevelCatalog.WIND_BAMBOO_ID, [LevelCatalog.FOG_RIDGE_ID]), "The second level must unlock after the first clear")
	_check(LevelCatalog.is_unlocked(LevelCatalog.WIND_BAMBOO_ID, [&"fog_ridge_60s"]), "Legacy completion IDs must satisfy the canonical prerequisite")

func _test_data() -> void:
	_check(LEVEL_DATA.get_validation_errors().is_empty(), "Wind bamboo data must pass route validation")
	_check(LEVEL_DATA.segments.size() == 5, "Wind bamboo must contain five authored sections")
	_check(is_equal_approx(LEVEL_DATA.get_nominal_seconds(), 85.0), "Wind bamboo must target an 85 second route")
	var pickup_count := 0
	var falling_count := 0
	for segment in LEVEL_DATA.segments:
		pickup_count += segment.pickups.size()
		for hazard in segment.hazards:
			if hazard.hazard_type == "falling_bamboo":
				falling_count += 1
				_check(hazard.exit_seconds > 0.0, "Falling bamboo must define an explicit exit phase")
	_check(pickup_count == 50, "Wind bamboo must author exactly fifty crystals")
	_check(falling_count == 5, "Each wind bamboo section must contain one falling bamboo threat")

func _test_falling_bamboo_pause() -> void:
	var main := PRACTICE_SCENE.instantiate()
	main.get_node("Level").data = LEVEL_DATA
	main.get_node("Level").boss_data = null
	root.add_child(main)
	await _frames(2)
	var player := main.get_node("Player") as PlayerController
	var bamboo: Hazard = null
	for hazard in main.get_node("Level").hazards:
		if hazard.hazard_type == "falling_bamboo":
			bamboo = hazard
			break
	_check(bamboo != null, "Built wind bamboo route must instantiate a falling bamboo hazard")
	if bamboo != null:
		player.position.x = bamboo.position.x - 360.0
		await _frames(2)
		var collision := bamboo.get_child(0) as CollisionPolygon2D
		_check(not collision == null and collision.disabled, "Falling bamboo must remain non-colliding during its warning")
		var paused_position := player.position
		var paused_elapsed: float = main._elapsed_time
		paused = true
		await _frames(70)
		_check(player.position == paused_position and is_equal_approx(main._elapsed_time, paused_elapsed), "Pausing must freeze the falling bamboo warning and route timer")
		paused = false
		await _frames(65)
		_check(not collision.disabled, "Falling bamboo must become collidable after its warning")
	main.free()

func _test_full_route() -> void:
	var main := PRACTICE_SCENE.instantiate()
	main.get_node("Level").data = LEVEL_DATA
	main.get_node("Level").boss_data = null
	root.add_child(main)
	await _frames(2)
	var player := main.get_node("Player") as PlayerController
	var world := main.get_node("Level") as RopeLevelController
	var events: Array[Dictionary] = []
	var segment_start := LEVEL_DATA.start_x
	for segment in LEVEL_DATA.segments:
		for hazard in segment.hazards:
			var safe_side := PlayerController.ROPE_BOTTOM if hazard.cable_side == "top" else PlayerController.ROPE_TOP
			# Leave time to collect the preceding crystal, then move before the
			# falling bamboo becomes collidable or the spike reaches the player.
			events.append({"x": segment_start + hazard.offset_x - 200.0, "side": safe_side})
		for pickup in segment.pickups:
			var side := PlayerController.ROPE_TOP if pickup.cable_side == "top" else PlayerController.ROPE_BOTTOM
			events.append({"x": segment_start + pickup.offset_x - 70.0, "side": side})
		segment_start += segment.length_px
	events.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.x < b.x)
	var index := 0
	for tick in range(6200):
		if main._finished:
			break
		if index < events.size() and player.position.x >= events[index].x:
			var event := events[index]
			index += 1
			var target: int = event.side
			if player.on_rope and player.rope_side != target:
				await _tap(&"drop" if target == PlayerController.ROPE_BOTTOM else &"jump")
		await _frames(1)
	_check(main._finished and main.result_title.text.contains("完成"), "Base double-jump route must finish wind bamboo")
	_check(player.damage_count == 0, "Base route must avoid falling bamboo and spikes")
	_check(player.crystals == 50 and world.pickup_positions.size() == 50, "Wind bamboo route must make all fifty crystals collectable")
	_check(main._elapsed_time >= 80.0 and main._elapsed_time <= 92.0, "Wind bamboo route must keep its authored 85 second pacing")
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
