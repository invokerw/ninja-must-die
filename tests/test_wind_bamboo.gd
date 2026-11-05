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
	for character_id in CharacterRegistry.CHARACTERS:
		for weapon_id in PlayerProfile.WEAPONS:
			await _test_full_route(character_id, weapon_id, false)
			await _test_full_route(character_id, weapon_id, true)
	await _test_retry()
	if _failures == 0:
		print("WIND_BAMBOO_PASS (3 characters x 2 weapons x base/mobility routes, bamboo phases/pause, selected-level retry)")
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
		player.position.x = bamboo.position.x - 280.0
		await _frames(2)
		var collision := bamboo.get_child(0) as CollisionPolygon2D
		_check(not collision == null and collision.disabled, "Falling bamboo must remain non-colliding during its warning")
		_check(bamboo._triggered and not bamboo._active and not bamboo._exiting, "Warning must be a distinct non-colliding phase")
		var warning_elapsed := bamboo._elapsed
		var paused_position := player.position
		var paused_elapsed: float = main._elapsed_time
		paused = true
		await _frames(70)
		_check(player.position == paused_position and is_equal_approx(main._elapsed_time, paused_elapsed), "Pausing must freeze the falling bamboo warning and route timer")
		_check(bamboo._elapsed == warning_elapsed and collision.disabled, "Pause must freeze warning state and collision")
		paused = false
		await _frames(60)
		_check(not collision.disabled, "Falling bamboo must become collidable after its warning")
		await _assert_phase_freezes(bamboo)
		await _frames(70)
		_check(bamboo._exiting and not bamboo._active and collision.disabled, "Exit must disable collision")
		await _assert_phase_freezes(bamboo)
		await _frames(30)
		_check(not bamboo._active and not bamboo._exiting and not bamboo._warning_active and collision.disabled, "Retired bamboo must remain non-colliding")
	main.free()

func _assert_phase_freezes(bamboo: Hazard) -> void:
	var elapsed := bamboo._elapsed
	var active := bamboo._active
	var exiting := bamboo._exiting
	var disabled := bamboo._collision.disabled
	paused = true
	await _frames(90)
	_check(bamboo._elapsed == elapsed and bamboo._active == active and bamboo._exiting == exiting and bamboo._collision.disabled == disabled, "Pause must freeze active/exit timer and collision")
	paused = false

func _test_full_route(character_id: StringName, weapon_id: StringName, alternative: bool) -> void:
	paused = false
	var loadout := RunLoadout.capture(CharacterRegistry.get_character(character_id), PlayerProfile.WEAPONS[weapon_id])
	_check(RunNavigation.launch_level(self, "res://scenes/main.tscn", loadout, LevelCatalog.WIND_BAMBOO_ID) == OK, "Formal wind bamboo route must launch")
	await _frames(2)
	var main := current_scene
	_check(main.get_run_mode() == &"full", "Boss-free second level must retain formal mode")
	var player := main.get_node("Player") as PlayerController
	var world := main.get_node("Level") as RopeLevelController
	var events: Array[Dictionary] = []
	var segment_start := LEVEL_DATA.start_x
	for segment in LEVEL_DATA.segments:
		for hazard in segment.hazards:
			if alternative and segment == LEVEL_DATA.segments[0] and hazard.hazard_type == "falling_bamboo":
				continue
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
	var stage := 0
	var mobility_used := false
	var bamboo_x := LEVEL_DATA.start_x + LEVEL_DATA.segments[0].hazards[0].offset_x
	for tick in range(6200):
		if main._finished:
			break
		if alternative:
			if character_id == &"thunder_guard":
				if stage == 0 and player.position.x >= bamboo_x - 65.0:
					await _tap(&"mobility")
					mobility_used = player.mobility.cooldown_remaining > 0.0
					stage = 3
			else:
				if stage == 0 and player.position.x >= bamboo_x - 280.0:
					await _tap(&"jump")
					stage = 1
				elif stage == 1 and player.position.x >= bamboo_x - 140.0:
					await _tap(&"jump")
					stage = 2
				elif stage == 2:
					if character_id == &"shadow_runner" and player.position.x >= bamboo_x - 30.0:
						await _tap(&"mobility")
						mobility_used = player.mobility.air_uses == 1
						stage = 3
					elif character_id == &"wind_scout" and player.velocity.y > 0.0:
						Input.action_press(&"mobility")
						await _frames(2)
						mobility_used = player.mobility.gliding
						stage = 3
				if stage == 3 and player.position.x > bamboo_x + 120.0:
					Input.action_release(&"mobility")
		if index < events.size() and player.position.x >= events[index].x:
			var event := events[index]
			index += 1
			var target: int = event.side
			if player.on_rope and player.rope_side != target:
				await _tap(&"drop" if target == PlayerController.ROPE_BOTTOM else &"jump")
		await _frames(1)
	Input.action_release(&"mobility")
	var label := "%s/%s/%s" % [character_id, weapon_id, "mobility" if alternative else "base"]
	_check(main._finished and main.result_title.text.contains("完成"), "Route must finish wind bamboo: " + label)
	_check(player.damage_count == 0, "Base route must avoid falling bamboo and spikes")
	_check(player.crystals >= (44 if alternative else 50) and world.pickup_positions.size() == 50, "Route must reach its collection target: " + label)
	_check(not alternative or mobility_used, "Alternative route must actually activate its mobility: " + label)
	_check(main.run_loadout.growth_snapshot.is_empty() and main.run_loadout.item_snapshot.is_empty(), "Routes must use zero growth and no consumables")
	_check(main._elapsed_time >= 80.0 and main._elapsed_time <= 92.0, "Wind bamboo route must keep its authored 85 second pacing")
	print("WIND_ROUTE %s: %.2fs, %d/50 crystals, %d hits" % [label, main._elapsed_time, player.crystals, player.damage_count])
	main.free()

func _test_retry() -> void:
	var loadout := RunLoadout.capture(CharacterRegistry.get_character(&"thunder_guard"), PlayerProfile.WEAPONS[&"star_lance"])
	for path in ["res://scenes/main.tscn", "res://scenes/practice.tscn"]:
		_check(RunNavigation.launch_level(self, path, loadout, LevelCatalog.WIND_BAMBOO_ID) == OK, "Selected second level must launch")
		await _frames(4)
		var main := current_scene
		await _tap(&"mobility")
		main._toggle_pause()
		main._restart_run()
		await _frames(4)
		main = current_scene
		_check(main.level.data.level_id == LevelCatalog.WIND_BAMBOO_ID and main.level.boss_data == null, "Retry must preserve second level and its boss-free route")
		_check(main.run_loadout.character.character_id == &"thunder_guard" and main.run_loadout.weapon.weapon_id == &"star_lance", "Retry must preserve character and weapon")
		_check(not paused and main.player.active and main.player.mobility.cooldown_remaining == 0.0 and main.player.crystals == 0, "Retry must reset runtime and resume play")
		_check(main.get_run_mode() == (&"full" if path.ends_with("main.tscn") else &"parkour_practice"), "Retry must preserve formal/practice mode")
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
