extends SceneTree

const PRACTICE := preload("res://scenes/practice.tscn")
const SANDBOX := preload("res://tools/run_sandbox.gd")
var _failures := 0

func _initialize() -> void:
	for action in [&"jump", &"drop", &"mobility", &"dash", &"skill"]:
		if not InputMap.has_action(action):
			InputMap.add_action(action)
	_run.call_deferred()

func _run() -> void:
	var scope := TestProfileScope.new("mobility")
	_test_data_and_snapshot()
	await _test_input_edges()
	await _test_third_jump()
	await _test_simultaneous_input()
	await _test_glide()
	await _test_glide_cancel_and_pause()
	await _test_burst()
	await _test_queued_input()
	await _test_burst_sweep()
	await _test_lifecycle()
	await _test_sandbox_entries()
	scope.close()
	if _failures == 0:
		print("MOBILITY_PASS (three validated resources, legacy migration, snapshots, third-jump edges, same-frame priority, bounded glide, burst cooldown/protection, queued flips, pause/focus/stop/retry, shared sandbox entries)")
	quit(0 if _failures == 0 else 1)

func _test_data_and_snapshot() -> void:
	for id in CharacterRegistry.CHARACTERS:
		var character := CharacterRegistry.get_character(id)
		_check(character.get_validation_errors(2).is_empty(), "Shipped character must validate: %s" % id)
		_check(character.get_max_jump_count(2) == 2, "All characters must have exactly two basic jumps")
		var bad := character.mobility.duplicate(true) as MobilityData
		bad.parameters.clear()
		_check(not bad.get_validation_errors().is_empty(), "Missing mobility parameters must be rejected")
		bad = character.mobility.duplicate(true)
		bad.cooldown_seconds = NAN
		_check(not bad.get_validation_errors().is_empty(), "Non-finite timing must be rejected")
	var legacy := CharacterRegistry.get_character(&"shadow_runner").duplicate(true) as CharacterData
	legacy.mobility = null
	_check(legacy.get_validation_errors(2).is_empty() and legacy.get_mobility_data().mobility_id == &"third_jump", "Legacy passive must migrate to the mobility action")
	legacy.passive = null
	_check(not legacy.get_validation_errors(2).is_empty(), "Missing mobility and missing legacy fallback must be rejected")
	var snapshot := RunLoadout.capture(CharacterRegistry.get_character(&"wind_scout"), PlayerProfile.WEAPONS[&"crescent_wheel"])
	snapshot.growth_snapshot = {"nested": {"value": 1}}
	snapshot.item_snapshot = {"items": ["charm"]}
	var retry := snapshot.copy()
	retry.mobility.parameters["air_duration"] = 2.0
	retry.growth_snapshot.nested.value = 9
	retry.item_snapshot.items.append("potion")
	_check(snapshot.mobility.parameters.air_duration == 1.2 and CharacterRegistry.get_character(&"wind_scout").mobility.parameters.air_duration == 1.2, "Retry mobility must be deeply isolated from the run and resource")
	_check(snapshot.growth_snapshot.nested.value == 1 and snapshot.item_snapshot.items.size() == 1, "Retry snapshots must deep-copy nested data")

func _test_input_edges() -> void:
	var bridge := RunInput.new()
	bridge.press_touch(&"dash")
	bridge.release_touch(&"mobility")
	await _frames(1)
	_check(bridge.mobility_just_pressed and bridge.mobility_just_released and not bridge.mobility_pressed, "A short legacy touch must preserve both edges through the canonical action")
	await _frames(1)
	_check(not bridge.mobility_just_pressed and not bridge.mobility_just_released, "Touch edges must last exactly one physics tick")

func _player(id: StringName = &"shadow_runner") -> PlayerController:
	var scene := PRACTICE.instantiate()
	var player := scene.get_node("Player") as PlayerController
	scene.remove_child(player)
	scene.free()
	player.run_loadout = RunLoadout.capture(CharacterRegistry.get_character(id), PlayerProfile.WEAPONS[&"crescent_wheel"])
	root.add_child(player)
	player.active = true
	return player

func _air(player: PlayerController, velocity_y: float = 100.0) -> void:
	player.on_rope = false
	player.position.y = -1000.0
	player.velocity.y = velocity_y

func _test_third_jump() -> void:
	var player := _player()
	await _tap(&"mobility")
	_check(player.on_rope and not player.is_invulnerable(), "Rope mobility must never give shadow runner a shared dash or protection")
	await _tap(&"drop")
	await _tap(&"mobility")
	_check(player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM, "Third jump must not bypass the lower-rope rule")
	await _frames(8)
	await _tap(&"jump")
	await _frames(8)
	await _tap(&"jump")
	await _tap(&"mobility")
	_check(player.mobility.air_uses == 0 and player.jumps_remaining == 1, "Early third-jump input must not be queued")
	await _tap(&"jump")
	var velocity_before := player.velocity.y
	await _tap(&"jump")
	_check(player.jumps_remaining == 0 and player.velocity.y > velocity_before, "A third jump-key press must be ineffective")
	await _tap(&"dash")
	_check(player.mobility.air_uses == 1 and player.velocity.y < -430 and not player.is_invulnerable(), "Legacy dash alias must invoke one unprotected third jump")
	velocity_before = player.velocity.y
	await _tap(&"mobility")
	_check(player.velocity.y > velocity_before, "Third jump must be limited to once per departure")
	await _frames(110)
	_check(player.on_rope and player.mobility.air_uses == 0 and player.jumps_remaining == 1, "Landing must restore both separate budgets")
	player.free()

func _test_simultaneous_input() -> void:
	var player := _player()
	await _tap(&"jump")
	Input.action_press("jump")
	Input.action_press("mobility")
	await _frames(1)
	_check(player.jumps_remaining == 0 and player.mobility.air_uses == 0 and player.velocity.y < -500, "Second jump and third-jump in one frame must consume only the basic jump")
	Input.action_release("jump")
	await _frames(5)
	_check(player.mobility.air_uses == 0, "Held rejected mobility must not fire later")
	Input.action_release("mobility")
	await _frames(1)
	await _tap(&"mobility")
	_check(player.mobility.air_uses == 1, "A fresh mobility edge after the second jump must work")
	player.free()
	player = _player(&"thunder_guard")
	Input.action_press("jump")
	Input.action_press("mobility")
	await _frames(1)
	Input.action_release("jump")
	Input.action_release("mobility")
	_check(not player.on_rope and player.jumps_remaining == 1 and player.is_mobility_bursting(), "Takeoff plus thunder burst must execute in one frame without spending the air jump")
	player.free()
	await _frames(1)

func _test_glide() -> void:
	var player := _player(&"wind_scout")
	_air(player, -300.0)
	Input.action_press("mobility")
	await _frames(5)
	_check(player.velocity.y < 0 and not player.mobility.gliding and is_equal_approx(player.mobility.air_time_remaining, 1.2), "Holding glide during ascent must not slow ascent or spend duration")
	for tick in range(20):
		await _frames(1)
		if player.mobility.gliding:
			break
	_check(player.mobility.gliding and player.velocity.y <= 120.0, "Held mobility must begin gliding on descent")
	await _frames(20)
	var remaining := player.mobility.air_time_remaining
	Input.action_release("mobility")
	await _frames(4)
	_check(not player.mobility.gliding and is_equal_approx(player.mobility.air_time_remaining, remaining), "Release must stop glide and preserve the remaining allowance")
	Input.action_press("mobility")
	await _frames(4)
	_check(player.mobility.gliding and player.mobility.air_time_remaining < remaining, "Re-press must continue the same allowance")
	await _frames(85)
	_check(player.mobility.air_time_remaining <= 0.00001 and not player.mobility.gliding and player.velocity.y > 120.0, "Holding beyond 1.2 seconds must exhaust glide without refreshing it")
	Input.action_release("mobility")
	await _frames(1)
	player._attach_to_rope(PlayerController.ROPE_TOP)
	_check(is_equal_approx(player.mobility.air_time_remaining, 1.2), "Rope attachment restores the glide allowance")
	player.free()

func _test_glide_cancel_and_pause() -> void:
	var player := _player(&"wind_scout")
	_air(player)
	Input.action_press("mobility")
	await _frames(3)
	var remaining := player.mobility.air_time_remaining
	paused = true
	await _frames(6)
	_check(not player.mobility.gliding and is_equal_approx(player.mobility.air_time_remaining, remaining), "Pause clears glide while freezing the duration")
	paused = false
	await _frames(3)
	_check(not player.mobility.gliding, "Resuming with a stale held keyboard key must require a fresh press")
	Input.action_release("mobility")
	await _frames(1)
	Input.action_press("mobility")
	await _frames(2)
	_check(player.mobility.gliding, "Fresh hold after pause must resume the remaining duration")
	player.take_damage()
	await _frames(2)
	_check(not player.mobility.gliding, "A hit must cancel held glide until release")
	Input.action_release("mobility")
	await _frames(1)
	Input.action_press("mobility")
	await _frames(2)
	Input.action_press("drop")
	await _frames(1)
	_check(not player.mobility.gliding and player.velocity.y >= 1000, "Fast fall must cancel glide immediately")
	Input.action_release("drop")
	await _frames(2)
	_check(not player.mobility.gliding, "A fast-fall descent must not restart glide while held")
	Input.action_release("mobility")
	player.free()
	await _frames(1)

func _test_burst() -> void:
	var player := _player(&"thunder_guard")
	await _tap(&"mobility")
	_check(player.is_mobility_bursting() and player.is_invulnerable() and player.dash_cooldown > 5.9, "Burst must establish speed, cooldown and protection immediately")
	player.take_damage()
	_check(player.damage_count == 0, "Burst input-frame protection must block contact")
	await _frames(7)
	_check(player.is_mobility_bursting() and not player.is_invulnerable(), "Protection must expire before movement ends")
	player.take_damage()
	_check(player.damage_count == 1, "Contact after 0.12 seconds must deal damage even during the burst")
	Input.action_press("mobility")
	await _frames(365)
	_check(player.mobility.cooldown_remaining <= 0.00001 and not player.is_mobility_bursting(), "A cooldown-blocked hold must never automatically recast")
	Input.action_release("mobility")
	await _frames(1)
	await _tap(&"mobility")
	_check(player.is_mobility_bursting(), "A new edge after six seconds must burst again")
	var cooldown := player.mobility.cooldown_remaining
	player._attach_to_rope(PlayerController.ROPE_TOP)
	_check(is_equal_approx(player.mobility.cooldown_remaining, cooldown), "Landing must preserve burst cooldown")
	player.free()
	player = _player(&"thunder_guard")
	_air(player)
	player.jumps_remaining = 0
	await _tap(&"mobility")
	_check(player.jumps_remaining == 0 and player.mobility.air_uses == 1, "Burst must not refresh exhausted jumps")
	player.mobility.tick(6.0)
	_check(not player.mobility.can_use({"on_rope": false}), "Airborne burst eligibility must not refresh with cooldown")
	player.free()

func _test_queued_input() -> void:
	var player := _player(&"thunder_guard")
	await _tap(&"mobility")
	await _tap(&"drop")
	_check(player.rope_side == PlayerController.ROPE_TOP, "Flip during burst must wait for the end")
	await _frames(12)
	_check(player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM, "Queued flip must execute after burst")
	player.free()
	player = _player(&"thunder_guard")
	_air(player, -100.0)
	await _tap(&"mobility")
	player.run_input.press_touch(&"rope_flip")
	player.run_input.release_touch(&"rope_flip")
	await _frames(1)
	_check(player.velocity.y < 1000, "Fast fall during burst must queue")
	await _frames(12)
	_check(player.velocity.y >= 1000, "Queued fast fall must survive a short touch and execute after burst")
	player.free()

func _test_burst_sweep() -> void:
	var player := _player(&"thunder_guard")
	player.set_physics_process(false)
	var from := player.global_position
	var crystal := CrystalPickup.new()
	crystal.position = from + Vector2(80, 0)
	root.add_child(crystal)
	var spike := Hazard.new()
	spike.position = Vector2(from.x + 120, player.rope_y)
	root.add_child(spike)
	await _frames(2)
	player.mobility.try_start({"on_rope": true})
	player.mobility.invulnerability_remaining = 0.0
	player.global_position += Vector2(180, 0)
	player._sweep_burst_contacts(from)
	_check(player.crystals == 1 and player.damage_count == 1, "Burst sweep must collect and hit objects between endpoints after protection expires (crystals=%d, hits=%d, contacts=%d)" % [player.crystals, player.damage_count, player._motion_sweep.get_collision_count()])
	player._sweep_burst_contacts(from)
	_check(player.crystals == 1 and player.damage_count == 1, "Repeated overlap callbacks must not duplicate pickup or same-frame damage")
	await _frames(1)
	player.free()
	spike.free()

func _test_lifecycle() -> void:
	for id in CharacterRegistry.CHARACTERS:
		var player := _player(id)
		_air(player)
		player.jumps_remaining = 0
		Input.action_press("mobility")
		await _frames(2)
		var cooldown := player.mobility.cooldown_remaining
		player._notification(Node.NOTIFICATION_APPLICATION_FOCUS_OUT)
		_check(not player.run_input.mobility_pressed and not player.mobility.gliding, "Focus loss must clear keyboard/touch holds for %s" % id)
		_check(is_equal_approx(player.mobility.cooldown_remaining, cooldown), "Focus loss must not reset cooldown")
		player.stop()
		_check(not player.mobility.is_active() and player.mobility.cooldown_remaining == 0 and player.mobility.invulnerability_remaining == 0, "Stop must clear runtime timers and protection")
		Input.action_release("mobility")
		player.free()
		await _frames(1)

func _test_sandbox_entries() -> void:
	var previous_touch := TouchControls.preview_enabled
	TouchControls.preview_enabled = true
	_check(SANDBOX.create_run(&"unknown") == null and SANDBOX.create_run(&"shadow_runner", "unknown") == null, "Sandbox must reject unknown configurations")
	for character_id in CharacterRegistry.CHARACTERS:
		for mode in SANDBOX.MODES:
			var scene := SANDBOX.create_run(character_id, mode)
			root.add_child(scene)
			current_scene = scene
			await _frames(3)
			var expected_mode: StringName = {"parkour": &"parkour_practice", "boss": &"boss_practice", "full": &"full"}[mode]
			_check(scene.player.active and scene.run_loadout.character.character_id == character_id and scene.get_run_mode() == expected_mode, "Shared sandbox must resolve character and mode: %s/%s" % [character_id, mode])
			scene._toggle_pause()
			await _frames(2)
			_check(scene.result_overlay.body_scroll.get_global_rect().end.y <= scene.save_status.get_global_rect().position.y, "Each mobility description must scroll above the fixed pause footer")
			scene._restart_run()
			await _frames(3)
			scene = current_scene
			_check(scene.run_loadout.character.character_id == character_id and scene.player.mobility.cooldown_remaining == 0 and scene.get_run_mode() == expected_mode, "Retry must keep sandbox character and mode with a fresh runtime")
			_check(scene.touch_controls.visible, "Touch preview must survive sandbox retry")
			scene.free()
	TouchControls.preview_enabled = previous_touch

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
