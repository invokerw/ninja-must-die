extends SceneTree

const MAIN_SCENE := preload("res://scenes/main.tscn")
const CHARACTER := preload("res://data/characters/shadow_runner.tres")

var _failures := 0

func _initialize() -> void:
	for action in ["jump", "drop", "dash", "skill"]:
		if not InputMap.has_action(action):
			InputMap.add_action(action)
	_run.call_deferred()

func _run() -> void:
	_test_character_data()
	await _test_skill_range_and_damage()
	await _test_lower_and_airborne_skill()
	await _test_cast_mobility()
	await _test_cooldown_and_protection()
	await _test_same_tick_contact()
	await _test_independent_protection()
	await _test_jump_budgets()
	await _test_pickups_combo_and_finish()
	await _test_pause_stop_and_death()
	await _test_authored_encounters()
	_test_results()
	if _failures == 0:
		print("COMBAT_PASS (character data, cooldown, same-tick immunity, range/damage, 2/3 jumps, pause/stop, encounters, results)")
	quit(0 if _failures == 0 else 1)

func _test_character_data() -> void:
	_check(CHARACTER.get_validation_errors(2).is_empty(), "Shipped character must pass validation")
	var bad := CHARACTER.duplicate(true) as CharacterData
	bad.active_skill = null
	_check(not bad.get_validation_errors(2).is_empty(), "Missing active must be rejected")
	bad = CHARACTER.duplicate(true)
	bad.passive = null
	_check(not bad.get_validation_errors(2).is_empty(), "Missing passive must be rejected")
	bad = CHARACTER.duplicate(true)
	bad.active_skill.cooldown_seconds = 1.0
	_check(not bad.get_validation_errors(2).is_empty(), "Cooldown shorter than protection must be rejected")
	bad.active_skill.cooldown_seconds = 12.0
	bad.active_skill.cast_delay_seconds = 2.0
	_check(not bad.get_validation_errors(2).is_empty(), "Windup outside protection must be rejected")
	bad.active_skill.cast_delay_seconds = 0.12
	bad.active_skill.forward_range = -10.0
	_check(not bad.get_validation_errors(2).is_empty(), "Invalid damage area must be rejected")
	_check(not CHARACTER.get_validation_errors(3).is_empty(), "Passive must not silently become a global fourth jump")

func _make_player(extra_jumps: int = 1) -> PlayerController:
	var scene := MAIN_SCENE.instantiate()
	var player := scene.get_node("Player") as PlayerController
	scene.remove_child(player)
	scene.free()
	player.character = CHARACTER.duplicate(true)
	player.character.passive.extra_air_jumps = extra_jumps
	root.add_child(player)
	player.active = true
	return player

func _enemy(position: Vector2, health: int = 1) -> RopeSentry:
	var enemy := RopeSentry.new()
	enemy.position = position
	enemy.max_health = health
	root.add_child(enemy)
	return enemy

func _test_skill_range_and_damage() -> void:
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	var top := _enemy(Vector2(player.position.x + 240.0, player.rope_y - 90.0))
	var bottom := _enemy(Vector2(player.position.x + 400.0, player.rope_y + 90.0))
	var armored := _enemy(player.position + Vector2(500, 0), 4)
	var far := _enemy(player.position + Vector2(1000, 0))
	var behind := _enemy(player.position + Vector2(-100, 0))
	var outside := _enemy(Vector2(player.position.x + 300.0, player.rope_y + 160.0))
	await _frames(2)
	var start_x := player.position.x
	await _tap("skill")
	_check(top.alive and bottom.alive, "Attack must wait for the visible windup")
	await _frames(4)
	_check(player.position.x - start_x >= 30.0, "Windup must keep forward movement at full speed")
	await _frames(4)
	_check(not top.alive and not bottom.alive, "Attached cast must center on rope and cover both sides")
	_check(armored.alive and armored.health == 1, "Each target must take exactly 3 damage once per cast")
	_check(far.alive and behind.alive and outside.alive, "Strike must leave distant, rear and vertically distant targets alive")
	_check(combat.kills == 2 and combat.combo == 2, "Kills must contribute combo exactly once")
	player.free()
	_free_nodes([top, bottom, armored, far, behind, outside])

func _test_lower_and_airborne_skill() -> void:
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	await _tap("drop")
	var target := _enemy(Vector2(player.position.x + 220.0, player.rope_y - player.rope_offset))
	await _tap("skill")
	await _frames(10)
	_check(not target.alive and player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM, "Bottom-side cast must hit across rope without detaching")
	player.free()
	_free_nodes([target])
	player = _make_player()
	combat = player.get_node("Combat") as RunnerCombat
	await _tap("jump")
	await _frames(10)
	await _tap("jump")
	await _frames(10)
	await _tap("jump")
	var vertical_speed := player.velocity.y
	var remaining := player.jumps_remaining
	_check(combat.try_skill(), "Airborne cast must be accepted")
	_check(player.velocity.y == vertical_speed and player.jumps_remaining == remaining and not player.on_rope, "Skill must not modify air velocity, attachment or jump budget")
	target = _enemy(player.position + Vector2(250, -50))
	var rope_target := _enemy(Vector2(player.position.x + 250.0, player.rope_y))
	await _frames(10)
	_check(not target.alive and rope_target.alive, "Airborne strike must use current body height instead of rope height")
	await _tap("jump")
	_check(player.jumps_remaining == 0 and player.velocity.y > -400.0, "Skill must not grant a fourth jump")
	player.free()
	_free_nodes([target, rope_target])

func _test_cast_mobility() -> void:
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	Input.action_press("skill")
	Input.action_press("drop")
	await _frames(1)
	Input.action_release("skill")
	Input.action_release("drop")
	_check(player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM and combat._skill_pending, "Cast windup must accept a simultaneous rope flip")
	player.free()
	await _frames(1)
	player = _make_player()
	combat = player.get_node("Combat") as RunnerCombat
	Input.action_press("skill")
	Input.action_press("jump")
	await _frames(1)
	Input.action_release("skill")
	Input.action_release("jump")
	_check(not player.on_rope and player.velocity.y < 0.0 and combat._skill_pending, "Cast windup must accept a simultaneous takeoff")
	await _frames(1)
	await _tap("jump")
	await _tap("dash")
	_check(player.jumps_remaining == 1 and player.dash_remaining > 0.0 and combat._skill_pending, "Air jump and dash must remain responsive during windup")
	player.free()

func _test_cooldown_and_protection() -> void:
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	_check(combat.is_skill_ready() and combat.try_skill(), "Empty cast must be ready at start without pickups")
	_check(combat.skill_cooldown_remaining == 12.0 and player.skill_immunity_remaining == 2.0, "Accepted input must immediately establish full cooldown and protection")
	player.take_damage()
	_check(player.damage_count == 0, "Input-frame damage must be blocked")
	await _frames(119)
	player.take_damage()
	_check(player.damage_count == 0 and player.is_invulnerable(), "Protection must remain active just before two seconds")
	await _frames(1)
	player.take_damage()
	_check(player.damage_count == 1 and player.skill_immunity_remaining < 0.00001, "Protection must expire at two seconds and restore normal damage")
	Input.action_press("skill")
	await _frames(600)
	_check(combat.skill_casts == 1 and combat.is_skill_ready(), "Cooldown presses and holding K past twelve seconds must not auto-cast")
	Input.action_release("skill")
	await _frames(1)
	await _tap("skill")
	_check(combat.skill_casts == 2, "A fresh press after twelve seconds must cast again")
	player.free()

func _test_same_tick_contact() -> void:
	# Add the hazard before the player and establish a real overlap while inactive.
	var hazard := Hazard.new()
	hazard.position = Vector2(160, 520)
	root.add_child(hazard)
	var player := _make_player()
	player.active = false
	await _frames(3)
	_check(hazard.overlaps_body(player), "Contact fixture must actually overlap the player")
	player.active = true
	Input.action_press("skill")
	await _frames(1)
	Input.action_release("skill")
	_check(player.damage_count == 0 and player.skill_immunity_remaining > 1.9, "Skill input must establish immunity before same-tick hazard contact")
	await _frames(10)
	_check(is_instance_valid(hazard), "Moon slash must not destroy spikes")
	player.free()
	hazard.free()
	# Repeat for sentry contact, including the 0.12 second attack delay.
	player = _make_player()
	player.active = false
	var target := _enemy(player.position)
	await _frames(3)
	player.active = true
	await _tap("skill")
	_check(target.alive and player.damage_count == 0, "Sentry contact before strike must be blocked immediately")
	player.free()
	target.free()

func _test_independent_protection() -> void:
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	player.take_damage()
	var hurt_time := player.immunity_remaining
	combat.try_skill()
	_check(player.immunity_remaining == hurt_time, "Skill must preserve the independent hurt timer")
	await _frames(60)
	await _tap("dash")
	await _frames(20)
	player.take_damage()
	_check(player.damage_count == 1 and player.skill_immunity_remaining > 0.5, "Short dash must not overwrite longer skill protection")
	await _frames(42)
	player.take_damage()
	_check(player.damage_count == 2, "Overlapping protections must not add their durations")
	player.free()
	player = _make_player()
	combat = player.get_node("Combat") as RunnerCombat
	combat.try_skill()
	await _frames(115)
	await _tap("dash")
	await _frames(5)
	_check(player.skill_immunity_remaining < 0.00001 and player.dash_remaining > 0.0 and player.is_invulnerable(), "Late dash protection must survive skill expiration")
	player.free()

func _test_jump_budgets() -> void:
	for bonus in [0, 1]:
		var player := _make_player(bonus)
		var combat := player.get_node("Combat") as RunnerCombat
		await _tap("drop")
		await _frames(8)
		await _tap("jump")
		_check(player.on_rope and player.jumps_remaining == 1 + bonus, "Bottom-to-top flip must preserve jump budget")
		await _frames(8)
		await _tap("jump")
		await _frames(10)
		await _tap("jump")
		_check(player.jumps_remaining == bonus, "Second jump must consume one air jump")
		if bonus == 1:
			await _frames(10)
			await _tap("jump")
			_check(player.jumps_remaining == 0 and player.velocity.y < -430.0, "Passive third jump must use its configured impulse")
		await _frames(6)
		combat.try_skill()
		await _tap("dash")
		player.collect_crystal()
		var velocity_before := player.velocity.y
		await _tap("jump")
		_check(player.jumps_remaining == 0 and player.velocity.y > velocity_before, "Skill, dash and crystal pickup must not refresh exhausted jumps")
		for tick in range(150):
			if player.on_rope:
				break
			await _frames(1)
		_check(player.on_rope and player.jumps_remaining == 1 + bonus, "Actual landing must restore character-specific jump budget")
		Input.action_press("jump")
		await _frames(100)
		_check(player.on_rope, "Held jump must land once without chaining")
		Input.action_release("jump")
		await _frames(1)
		player.free()

func _test_pickups_combo_and_finish() -> void:
	var main := MAIN_SCENE.instantiate()
	root.add_child(main)
	_check(not InputMap.has_action("attack"), "Removed J action must not remain bound")
	main.free()
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	combat.try_skill()
	for index in range(12):
		player.collect_crystal()
	_check(player.crystals == 12 and combat.combo == 12 and combat.skill_cooldown_remaining == 12.0, "Crystals must count and build combo without altering cooldown")
	var pickup := CrystalPickup.new()
	pickup.position = player.position + Vector2(50, 0)
	root.add_child(pickup)
	await _frames(15)
	_check(player.crystals == 13 and not is_instance_valid(pickup), "Invulnerability must keep crystal collision enabled")
	await _frames(120)
	_check(combat.combo == 0 and combat.max_combo == 13, "Combo must expire while preserving the best")
	player.collect_crystal()
	player.take_damage()
	_check(combat.combo == 0 and combat.max_combo == 13, "Damage must break combo")
	player.free()
	main = MAIN_SCENE.instantiate()
	root.add_child(main)
	main.player.position.x = main.level.data.get_finish_x() - 70.0
	await _tap("skill")
	await _frames(15)
	_check(main._finished and main.result_title.text.contains("完成"), "Invulnerable player must still trigger finish")
	_check(not main.combat._skill_pending and not main.player.active, "Finish must synchronously cancel a pending attack")
	var final_kills: int = main.combat.kills
	await _frames(15)
	_check(main.combat.kills == final_kills and main.run_result.kills == final_kills, "No kills may be added after result locks")
	paused = false
	main.free()

func _test_pause_stop_and_death() -> void:
	var player := _make_player()
	var combat := player.get_node("Combat") as RunnerCombat
	combat.try_skill()
	var cooldown := combat.skill_cooldown_remaining
	var immunity := player.skill_immunity_remaining
	var position := player.position
	paused = true
	await _tap("skill")
	await _frames(30)
	_check(combat.skill_cooldown_remaining == cooldown and player.skill_immunity_remaining == immunity and player.position == position, "Pause must freeze cooldown, immunity, pending strike and movement")
	_check(not combat.try_skill(), "Paused casts must be rejected")
	paused = false
	var target := _enemy(player.position + Vector2(200, 0))
	player.stop()
	await _frames(15)
	_check(target.alive and not combat._skill_pending and combat.kills == 0 and not combat.try_skill(), "Stop must cancel pending damage and reject casts")
	player.free()
	target.free()
	player = _make_player()
	combat = player.get_node("Combat") as RunnerCombat
	combat.try_skill()
	target = _enemy(player.position + Vector2(200, 0))
	player.on_rope = false
	player.position.y = 910.0
	await _frames(12)
	_check(not player.active and not combat._skill_pending and target.alive, "Skill protection must not prevent fall failure or leave pending attacks")
	player.free()
	target.free()
	player = _make_player()
	combat = player.get_node("Combat") as RunnerCombat
	combat.try_skill()
	target = _enemy(player.position + Vector2(200, 0))
	# A fatal scripted hit shares the same stop/cancellation path as ordinary damage.
	player.skill_immunity_remaining = 0.0
	player.take_damage(player.health)
	await _frames(12)
	_check(player.health == 0 and not player.active and not combat._skill_pending and target.alive, "Fatal damage must cancel pending skill damage synchronously")
	player.free()
	target.free()
	player = _make_player()
	combat = player.get_node("Combat") as RunnerCombat
	_check(combat.is_skill_ready() and combat.skill_casts == 0 and player.skill_immunity_remaining == 0.0 and player.jumps_remaining == 2, "Fresh run must not inherit runtime timers or jump budget")
	_check(CHARACTER.active_skill.cooldown_seconds == 12.0 and CHARACTER.passive.extra_air_jumps == 1, "Runtime state must never mutate character resources")
	player.free()

func _test_authored_encounters() -> void:
	for index in range(5):
		var main := MAIN_SCENE.instantiate()
		root.add_child(main)
		var target: RopeSentry = main.level.enemies[index]
		main.player.position.x = target.position.x - 260.0
		await _frames(2)
		await _tap("skill")
		await _frames(10)
		_check(not target.alive and main.combat.kills >= 1, "Authored sentry %d must be inside the skill's forward range" % (index + 1))
		_check(main.player.damage_count == 0 and main.player.on_rope, "Authored sentry %d must allow a safe skill approach" % (index + 1))
		main.free()

func _test_results() -> void:
	var clean := RunResult.calculate(60.0, 60.0, 0, 50, 50, 2, 10)
	_check(clean.rank == "S" and clean.score == 3900, "Result must combine clear, time, crystals, kills, combo and clean bonuses")
	_check(RunResult.calculate(60, 60, 0, 0, 50, 7, 7).rank == "C", "No-crystal runs must not earn a high collection rank")
	_check(RunResult.calculate(65, 60, 1, 35, 50, 1, 4).rank == "A", "A rank must allow one hit with sufficient collection")
	_check(RunResult.calculate(75, 60, 2, 20, 50, 0, 2).rank == "B", "B rank must allow two hits with sufficient collection")
	_check(RunResult.calculate(60, 60, 0, 50, 50, 0, 10).rank == "S", "Enemy kills must remain optional for S rank")

func _free_nodes(nodes: Array) -> void:
	for node in nodes:
		if is_instance_valid(node):
			node.free()

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
