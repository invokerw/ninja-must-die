extends SceneTree

const MAIN_SCENE := preload("res://scenes/practice.tscn")
const CHARACTER := preload("res://data/characters/shadow_runner.tres")

var _failures := 0

func _initialize() -> void:
	for action in ["jump", "drop", "dash", "skill"]:
		if not InputMap.has_action(action):
			InputMap.add_action(action)
	_run.call_deferred()

func _run() -> void:
	var profile_scope := TestProfileScope.new("combat")
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
	await _test_character_ninjutsu()
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-skills-dir="):
			await _capture_skills(argument.trim_prefix("--capture-skills-dir="))
	_test_results()
	if _failures == 0:
		print("COMBAT_PASS (character data, cooldown, same-tick immunity, range/damage, feather flight and lightning pulses, per-hit armor, swept collision, 2/3 jumps, pause/stop, encounters, results)")
	profile_scope.close()
	quit(0 if _failures == 0 else 1)

func _test_character_data() -> void:
	_check(CHARACTER.get_validation_errors(2).is_empty(), "Shipped character must pass validation")
	var bad := CHARACTER.duplicate(true) as CharacterData
	bad.active_skill = null
	_check(not bad.get_validation_errors(2).is_empty(), "Missing active must be rejected")
	bad = CHARACTER.duplicate(true)
	bad.mobility = null
	bad.passive = null
	_check(not bad.get_validation_errors(2).is_empty(), "Missing mobility and legacy fallback must be rejected")
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

func _test_character_ninjutsu() -> void:
	for id in [&"wind_scout", &"thunder_guard"]:
		var data := CharacterRegistry.get_character(id)
		_check(data.get_validation_errors(2).is_empty() and data.active_skill.skill_id != &"moon_slash", "Character ninjutsu definitions must be distinct and valid")
		var bad := data.active_skill.duplicate(true) as ActiveSkillData
		bad.strike_interval_seconds = NAN
		_check(not bad.get_validation_errors().is_empty(), "Nonfinite ninjutsu intervals are invalid")
		bad = data.active_skill.duplicate(true)
		bad.strike_count = 0
		_check(not bad.get_validation_errors().is_empty(), "Zero attack counts are invalid")
		bad = data.active_skill.duplicate(true)
		bad.projectile_speed = INF
		_check(not bad.get_validation_errors().is_empty(), "Nonfinite projectile speeds are invalid")
		bad = data.active_skill.duplicate(true)
		bad.strike_interval_seconds = 5.0
		_check(not bad.get_validation_errors().is_empty(), "Attack sequences cannot extend beyond their protection window")
		var player := _make_player(id)
		var combat: RunnerCombat = player.get_node("Combat")
		var target := _enemy(Vector2(player.position.x + 450, player.rope_y), 20)
		var behind := _enemy(Vector2(player.position.x - 100, player.rope_y), 20)
		await _frames(2)
		var skill := player.character.active_skill
		_check(combat.try_skill() and not combat.try_skill(), "One cast starts cooldown and cannot queue a duplicate")
		_check(player.skill_immunity_remaining == 2.0 and combat.skill_cooldown_remaining == 12.0, "Distinct ninjutsu retain immediate protection and cooldown")
		await _frames(8)
		_check(combat.skill_emissions == 1, "Only the first attack is emitted after windup")
		if id == &"wind_scout":
			_check(target.health == 20 and combat.friendly_root.get_child_count() > 0, "Feathers must fly before impact rather than apply instant area damage")
		else:
			_check(target.health == 18, "First lightning strike applies only its own ordinary damage")
		var cooldown := combat.skill_cooldown_remaining
		var count := combat.skill_emissions
		paused = true
		await _frames(20)
		_check(combat.skill_emissions == count and combat.skill_cooldown_remaining == cooldown, "Pause freezes pending emissions and cooldown")
		paused = false
		await _frames(60)
		_check(combat.skill_emissions == skill.strike_count and target.health == 20 - skill.damage * skill.strike_count and behind.health == 20, "Each attack applies once to a forward target, leaving targets behind untouched")
		_check(combat.kills == 0 and combat.combo == 0, "Multi-hit damage cannot manufacture per-hit kill or combo rewards")
		target.free()
		behind.free()
		player.free()
		# Real boss collision: change armor after the first hit, preserving the remainder.
		var main = await _skill_boss(id)
		var boss: RopeBoss = main.level.boss
		combat = main.combat
		combat.try_skill()
		for tick in range(60):
			if boss.health < 180:
				break
			await _frames(1)
		_check(boss.health == 180 - skill.boss_damage, "First hit uses actual weak-point damage")
		boss.state = RopeBoss.State.WINDUP
		await _frames(70)
		var expected := skill.boss_damage + (skill.strike_count - 1) * int(skill.boss_damage / 2)
		_check(boss.health == 180 - expected and combat.damage_by_source[&"skill"] == expected, "Every later hit reads armor at impact and retains skill damage attribution")
		main.free()
		# Cancellation after the first attack must remove future attacks and existing feathers.
		main = await _skill_boss(id)
		combat = main.combat
		combat.try_skill()
		await _frames(8)
		main.player.stop()
		await _frames(45)
		_check(not combat._skill_pending and combat.skill_emissions == 1 and combat.friendly_root.get_child_count() == 0, "Stopping cancels the remaining sequence and in-flight feathers")
		main.free()
		main = await _skill_boss(id)
		combat = main.combat
		combat.try_skill()
		await _frames(8)
		main.player.skill_immunity_remaining = 0.0
		main.player.immunity_remaining = 0.0
		main.player.take_damage(100)
		await _frames(30)
		_check(not main.player.active and not combat._skill_pending and combat.skill_emissions == 1 and combat.friendly_root.get_child_count() == 0, "Fatal damage cancels both queued and flying ninjutsu attacks")
		paused = false
		main.free()
		# A lethal first pulse cancels the rest synchronously and counts one kill.
		main = await _skill_boss(id)
		combat = main.combat
		main.level.boss.health = skill.boss_damage
		combat.try_skill()
		await _frames(70)
		_check(combat.kills == 1 and not combat._skill_pending and combat.friendly_root.get_child_count() == 0, "Boss defeat cannot leak queued attacks or duplicate a kill")
		paused = false
		main.free()
	# Swept collision at extreme speed must not tunnel through a sentry.
	var player := _make_player(&"wind_scout")
	var target := _enemy(Vector2(player.position.x + 400, player.rope_y), 10)
	player.character.active_skill.projectile_speed = 60000.0
	await _frames(2)
	player.get_node("Combat").try_skill()
	await _frames(10)
	_check(target.health == 9, "A feather crossing an enemy in one physics step still hits exactly once")
	target.free()
	player.free()
	_check(CharacterRegistry.get_character(&"wind_scout").active_skill.projectile_speed == 1400.0, "Runtime tests cannot mutate shared static skill resources")

func _skill_boss(id: StringName) -> Node2D:
	var main: Node2D = load("res://scenes/boss_practice.tscn").instantiate()
	main.run_loadout = RunLoadout.capture(CharacterRegistry.get_character(id), PlayerProfile.WEAPONS[&"crescent_wheel"])
	root.add_child(main)
	await _frames(12)
	var boss: RopeBoss = main.level.boss
	boss.state = RopeBoss.State.RECOVERY
	boss.remaining = 30.0
	boss.set_physics_process(false)
	boss.global_position = Vector2(main.player.global_position.x + 450, main.player.rope_y)
	boss.previous_physics_position = boss.global_position
	return main

func _capture_skills(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "Skill capture requires a graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Skill capture directory is writable")
	for id in [&"wind_scout", &"thunder_guard"]:
		for state in ["cast", "pause"]:
			var main = await _skill_boss(id)
			main.combat.try_skill()
			await _frames(10)
			if state == "pause":
				main._toggle_pause()
			await RenderingServer.frame_post_draw
			_check(root.get_texture().get_image().save_png(output.path_join("%s_%s.png" % [id, state])) == OK, "Real skill screenshot saves")
			paused = false
			main.free()

func _make_player(character_id: StringName = &"shadow_runner") -> PlayerController:
	var scene := MAIN_SCENE.instantiate()
	var player := scene.get_node("Player") as PlayerController
	scene.remove_child(player)
	scene.free()
	player.character = CharacterRegistry.get_character(character_id).duplicate(true)
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
	await _tap("mobility")
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
	_check(player.jumps_remaining == 0 and player.mobility.air_uses == 1 and combat._skill_pending, "Basic jump and character mobility must remain responsive during windup")
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
	var player := _make_player(&"thunder_guard")
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
	player = _make_player(&"thunder_guard")
	combat = player.get_node("Combat") as RunnerCombat
	combat.try_skill()
	await _frames(115)
	await _tap("dash")
	await _frames(5)
	_check(player.skill_immunity_remaining < 0.00001 and player.dash_remaining > 0.0 and player.is_invulnerable(), "Late dash protection must survive skill expiration")
	player.free()

func _test_jump_budgets() -> void:
	for id in CharacterRegistry.CHARACTERS:
		var player := _make_player(id)
		var combat := player.get_node("Combat") as RunnerCombat
		await _tap("drop")
		await _frames(8)
		await _tap("jump")
		_check(player.on_rope and player.jumps_remaining == 1, "Bottom-to-top flip must preserve the shared two-jump budget")
		await _frames(8)
		await _tap("jump")
		await _frames(10)
		await _tap("jump")
		_check(player.jumps_remaining == 0, "Second jump must exhaust the basic air jump")
		await _frames(10)
		await _tap("mobility")
		if id == &"shadow_runner":
			_check(player.velocity.y < -430.0, "Third jump must use the separate mobility input")
		await _frames(6)
		combat.try_skill()
		player.collect_crystal()
		var velocity_before := player.velocity.y
		await _tap("jump")
		_check(player.jumps_remaining == 0 and player.velocity.y > velocity_before, "Skill, mobility and pickups must not refresh exhausted jumps")
		for tick in range(150):
			if player.on_rope:
				break
			await _frames(1)
		_check(player.on_rope and player.jumps_remaining == 1, "Landing must restore the shared basic jump budget")
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
	_check(combat.is_skill_ready() and combat.skill_casts == 0 and player.skill_immunity_remaining == 0.0 and player.jumps_remaining == 1, "Fresh run must not inherit runtime timers or jump budget")
	_check(CHARACTER.active_skill.cooldown_seconds == 12.0 and CHARACTER.passive.extra_air_jumps == 1, "Runtime state must never mutate character resources")
	player.free()

func _test_authored_encounters() -> void:
	for index in range(5):
		var main := MAIN_SCENE.instantiate()
		root.add_child(main)
		var target: RopeSentry = main.level.enemies[index]
		main.player.position.x = target.position.x - 200.0
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
