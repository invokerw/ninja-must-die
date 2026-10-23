extends SceneTree

const MAIN_SCENE := preload("res://scenes/main.tscn")
const LEVEL_DATA := preload("res://data/levels/fog_ridge_60s.tres")

var _failures := 0
var _sections: Array[int] = []

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	_test_data()
	await _test_full_route(false)
	await _test_full_route(true)
	await _test_full_route(false, true)
	await _test_full_route(true, true)
	await _test_pause_and_reload()
	await _test_finish_below_rope()
	if _failures == 0:
		print("LEVEL_ROUTE_PASS (data validation, 4 full runs, pause/reload, lower finish)")
	quit(0 if _failures == 0 else 1)

func _test_data() -> void:
	_check(LEVEL_DATA.get_validation_errors().is_empty(), "Shipped level must pass layout validation")
	_check(LEVEL_DATA.segments.size() == 4 and is_equal_approx(LEVEL_DATA.get_nominal_seconds(), 60.0), "Route must contain four sections covering 60 seconds")
	var bad := LEVEL_DATA.duplicate(true) as RopeLevelData
	bad.segments[0].hazards[1].offset_x = bad.segments[0].hazards[0].offset_x + 60.0
	_check(not bad.get_validation_errors().is_empty(), "Validation must reject overlapping alternating hazards")
	bad = LEVEL_DATA.duplicate(true) as RopeLevelData
	bad.segments[0].pickups[0].offset_x = bad.segments[0].hazards[0].offset_x
	_check(not bad.get_validation_errors().is_empty(), "Validation must reject crystals inside a hazard")
	bad = LEVEL_DATA.duplicate(true) as RopeLevelData
	bad.segments[1].hazards[0].offset_x = 0.0
	bad.segments[1].hazards[0].cable_side = "bottom"
	_check(not bad.get_validation_errors().is_empty(), "Flip clearance must also be checked across section boundaries")
	bad = LEVEL_DATA.duplicate(true) as RopeLevelData
	bad.segments[1].enemies[0].offset_x = 1760.0
	_check(not bad.get_validation_errors().is_empty(), "Mixed enemy/hazard layouts must leave a valid flip window")
	bad = LEVEL_DATA.duplicate(true) as RopeLevelData
	bad.segments[1].enemies[0].offset_x = -1.0
	_check(not bad.get_validation_errors().is_empty(), "Enemy placement outside a segment must be rejected")

func _test_full_route(with_actions: bool, with_combat: bool = false) -> void:
	var main := MAIN_SCENE.instantiate()
	if not with_combat:
		var baseline := load("res://data/characters/shadow_runner.tres").duplicate(true) as CharacterData
		baseline.passive.extra_air_jumps = 0
		main.get_node("Player").character = baseline
	root.add_child(main)
	var player := main.get_node("Player") as PlayerController
	var world := main.get_node("Level") as RopeLevelController
	var combat := player.get_node("Combat") as RunnerCombat
	_check(world.enemies.size() == 7, "The authored route must spawn exactly seven sentries")
	var events: Array[Dictionary] = []
	var start := LEVEL_DATA.start_x
	for segment in LEVEL_DATA.segments:
		for hazard in segment.hazards:
			if with_actions and ((segment.segment_id == &"combinations" and hazard.offset_x <= 640.0) or (segment.segment_id == &"sprint" and hazard.offset_x == 480.0)):
				continue
			var side := PlayerController.ROPE_BOTTOM if hazard.cable_side == "top" else PlayerController.ROPE_TOP
			events.append({"x": start + hazard.offset_x - 100.0, "side": side})
		for pickup in segment.pickups:
			var side := PlayerController.ROPE_TOP if pickup.cable_side == "top" else PlayerController.ROPE_BOTTOM
			events.append({"x": start + pickup.offset_x - 60.0, "side": side})
		if with_actions and segment.segment_id == &"combinations":
			events.append({"x": start + 140.0, "side": PlayerController.ROPE_TOP})
			events.append({"x": start + 390.0, "action": &"jump"})
			events.append({"x": start + 490.0, "action": &"jump"})
			if with_combat:
				events.append({"x": start + 590.0, "action": &"jump"})
				events.append({"x": start + 700.0, "action": &"drop"})
		if with_actions and segment.segment_id == &"sprint":
			events.append({"x": start + 140.0, "side": PlayerController.ROPE_TOP})
			events.append({"x": start + 430.0, "action": &"dash"})
		start += segment.length_px
	events.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.x < b.x)
	_sections = [0]
	world.segment_changed.connect(_on_section_changed)
	var index := 0
	for tick in range(4000):
		if main._finished:
			break
		if with_combat and combat.is_skill_ready():
			for enemy in world.enemies:
				if not is_instance_valid(enemy) or not enemy.alive:
					continue
				var distance := enemy.position.x - player.position.x
				if distance > 36.0 and distance < 600.0:
					await _tap(&"skill")
					break
		if index < events.size() and player.position.x >= events[index].x:
			var event := events[index]
			index += 1
			if event.has("action"):
				await _tap(event.action)
			elif player.rope_side != event.side:
				_check(player.on_rope, "Scheduled flip must happen while attached")
				await _tap(&"drop" if event.side == PlayerController.ROPE_BOTTOM else &"jump")
		await _frames(1)
	_check(main._finished and main.result_title.text.contains("完成"), "Route replay must finish successfully")
	_check(player.damage_count == 0, "Route must be traversable without taking damage")
	_check(player.crystals == world.pickup_positions.size(), "A legal route must collect all crystals without releasing the rope")
	_check(_sections == [0, 1, 2, 3], "Section notifications must occur in order exactly once")
	_check(main.progress_label.text.contains("100%"), "Finish HUD must reach 100%")
	_check(main._get_rank() == "S", "A clean 60 second run must qualify for S")
	if not with_actions and not with_combat:
		_check(absf(main._elapsed_time - 60.0) < 0.5, "Normal-speed route must last approximately 60 seconds")
	if with_combat:
		_check(combat.skill_casts >= 2 and combat.kills >= 2, "Full route must support repeated cooldown-based skill casts and kills")
		_check(main.run_result != null and main.run_result.kills == combat.kills and main.run_result.max_combo == combat.max_combo, "Results must preserve the run's real combat statistics")
	var route_name := ("triple jump/dash/skills" if with_actions else "cooldown/skills") if with_combat else ("base double jump/dash" if with_actions else "base flips")
	print("ROUTE_REPLAY %s: %.2fs, %d/%d crystals, %d hits, %d kills" % [route_name, main._elapsed_time, player.crystals, world.pickup_positions.size(), player.damage_count, combat.kills])
	paused = false
	main.free()

func _test_pause_and_reload() -> void:
	var main := MAIN_SCENE.instantiate()
	root.add_child(main)
	current_scene = main
	await _frames(10)
	var position: Vector2 = main.player.position
	var time: float = main._elapsed_time
	paused = true
	await _frames(12)
	_check(main.player.position == position and main._elapsed_time == time, "Pause must freeze movement and timer")
	paused = false
	await _tap(&"skill")
	main.player.collect_crystal()
	main.player.position.x = 10000.0
	await _frames(1)
	var old_nodes: int = main.get_child_count() + main.level.get_child_count()
	main._restart_run()
	await _frames(2)
	main = current_scene
	_check(main.player.crystals == 0 and main.level.active_segment == 0, "Reload must clear crystals and reset the section")
	_check(main.level.hazards.size() == 29 and main.level.pickup_positions.size() == 50, "Reload must rebuild the exact authored layout")
	_check(main.level.enemies.size() == 7 and main.combat.is_skill_ready() and main.combat.skill_casts == 0 and main.combat.kills == 0 and main.combat.combo == 0, "Reload must reset all combat state and rebuild enemies")
	_check(main.get_child_count() + main.level.get_child_count() == old_nodes, "Reload must not duplicate level nodes")
	main.free()

func _test_finish_below_rope() -> void:
	var main := MAIN_SCENE.instantiate()
	root.add_child(main)
	main.player.rope_side = PlayerController.ROPE_BOTTOM
	main.player.position = Vector2(LEVEL_DATA.get_finish_x() - 120.0, LEVEL_DATA.rope_y + main.player.rope_offset)
	await _frames(30)
	_check(main._finished and main.result_title.text.contains("完成"), "Finish must accept the lower rope route")
	var body: String = main.result_body.text
	var escape := InputEventAction.new()
	escape.action = &"pause"
	escape.pressed = true
	main._unhandled_input(escape)
	_check(paused and main.result_body.text == body, "Escape must not dismiss completed results")
	paused = false
	main.free()

func _on_section_changed(index: int, _segment: RopeSegmentData) -> void:
	_sections.append(index)

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
