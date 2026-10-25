extends SceneTree

const MAIN_SCENE := preload("res://scenes/main.tscn")
const BOSS_DATA := preload("res://data/enemies/bridge_kite.tres")

var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var profile_scope := TestProfileScope.new("boss")
	_test_data()
	await _test_entry_and_pause()
	await _test_practice_entry()
	await _test_sweeps()
	await _test_protection()
	await _test_volley()
	await _test_weak_point()
	await _test_enrage_threshold()
	await _test_enraged_volley()
	await _test_enraged_cancellation_and_retry()
	await _test_defeat_and_restart()
	await _test_death_cancels()
	await _test_long_chase()
	if _failures == 0:
		print("BOSS_PASS (entry, 3 readable attacks, half-health enrage, double volley, evasion, immunity, weak point, kill/results, pause/retry/death, 10 minute node stability)")
	profile_scope.close()
	quit(0 if _failures == 0 else 1)

func _test_data() -> void:
	_check(BOSS_DATA.get_validation_errors(320.0).is_empty(), "The shipped boss pattern must be valid")
	var bad := BOSS_DATA.duplicate(true) as BossEncounterData
	bad.windup_seconds = 0.2
	_check(not bad.get_validation_errors(320.0).is_empty(), "An unreadable boss warning must be rejected")
	bad = BOSS_DATA.duplicate(true)
	bad.beam_height = 100.0
	_check(not bad.get_validation_errors(320.0).is_empty(), "A sweep that seals both lanes must be rejected")
	bad = BOSS_DATA.duplicate(true)
	bad.volley.fire_direction = Vector2.ZERO
	_check(not bad.get_validation_errors(320.0).is_empty(), "Boss volleys must validate their fixed firing direction")
	bad = BOSS_DATA.duplicate(true)
	bad.recovery_seconds = 0.1
	_check(not bad.get_validation_errors(320.0).is_empty(), "The boss must leave time to attack its weak point")
	bad = BOSS_DATA.duplicate(true)
	bad.max_health = 0
	_check(not bad.get_validation_errors(320.0).is_empty(), "An already dead boss configuration must be rejected")
	for ratio in [0.0, 1.0, NAN]:
		bad = BOSS_DATA.duplicate(true)
		bad.enrage_health_ratio = ratio
		_check(not bad.get_validation_errors(320.0).is_empty(), "Invalid enrage health ratios must be rejected")
	for waves in [0, 4]:
		bad = BOSS_DATA.duplicate(true)
		bad.enraged_volley_waves = waves
		_check(not bad.get_validation_errors(320.0).is_empty(), "Enraged volleys must have a bounded wave count")

func _enter(health: int = 180, below: bool = false) -> Node2D:
	var main := MAIN_SCENE.instantiate()
	var level := main.get_node("Level") as RopeLevelController
	level.boss_data = BOSS_DATA.duplicate(true)
	level.boss_data.max_health = health
	level.boss_data.shuriken_balls_enabled = false
	root.add_child(main)
	if below:
		await _tap("drop")
	main.player.position.x = level.data.get_finish_x() - 65.0
	(main.player.get_node("Camera2D") as Camera2D).reset_smoothing()
	await _frames(12)
	_check(is_instance_valid(level.boss), "Crossing the route end must create a boss")
	return main

func _test_entry_and_pause() -> void:
	for below in [false, true]:
		var main := await _enter(180, below)
		var boss := main.level.boss as RopeBoss
		_check(not main._finished and main.player.active and main.boss_panel.visible, "Both rope sides must enter the boss fight without showing completion")
		_check(is_equal_approx(main.level.get_nominal_seconds(), 100.0) and boss.health == 180, "Default route must include the boss's forty second rating allowance")
		_check(main.progress_label.text.contains("75%") and main.segment_title.text.contains(boss.data.display_name), "HUD must distinguish route completion from boss completion")
		_check(boss.state == RopeBoss.State.ENTRANCE and boss.attacks_started == 0, "The boss must leave an entrance observation window")
		main.level._on_route_end()
		await _frames(1)
		_check(main.level.boss == boss and get_nodes_in_group("bosses").size() == 1, "Repeated gate notifications must not create duplicate bosses")
		var remaining := boss.remaining
		var position: Vector2 = main.player.position
		var time: float = main._elapsed_time
		paused = true
		await _frames(20)
		_check(boss.remaining == remaining and main.player.position == position and main._elapsed_time == time, "Pause must freeze the entrance, chase and run timer")
		paused = false
		main.free()

func _test_sweeps() -> void:
	for attack in [RopeBoss.Attack.UPPER_SWEEP, RopeBoss.Attack.LOWER_SWEEP]:
		for evade in [false, true]:
			var same_side := PlayerController.ROPE_TOP if attack == RopeBoss.Attack.UPPER_SWEEP else PlayerController.ROPE_BOTTOM
			var selected_side := -same_side if evade else same_side
			var main := await _enter(180, selected_side == PlayerController.ROPE_BOTTOM)
			var boss := main.level.boss as RopeBoss
			boss.attack = attack
			boss._begin_attack()
			await _frames(70)
			_check(main.player.damage_count == 0 and boss.state == RopeBoss.State.WINDUP, "Sweep warnings must remain harmless for the full readable windup")
			await _frames(7)
			_check(boss.state == RopeBoss.State.ACTIVE, "The warning must lead to an active sweep")
			_check(main.player.damage_count == (0 if evade else 1), "Only the advertised rope side must receive sweep damage")
			main.player.immunity_remaining = 0.0
			await _frames(18)
			_check(main.player.damage_count == (0 if evade else 1), "Each sweep must resolve contact at most once")
			main.free()
	var main := await _enter()
	var boss := main.level.boss as RopeBoss
	boss._begin_attack()
	await _frames(57)
	await _tap("jump")
	await _frames(30)
	_check(main.player.damage_count == 0, "A timely jump must also clear the upper sweep")
	main.free()

func _test_practice_entry() -> void:
	var main: Node2D = load("res://scenes/boss_practice.tscn").instantiate()
	root.add_child(main)
	await _frames(12)
	_check(main.start_at_boss and is_instance_valid(main.level.boss) and main.segment_title.text.contains("首领练习"), "Boss practice must enter the real encounter directly with distinct practice UI")
	main.free()

func _test_protection() -> void:
	for action in ["skill", "dash"]:
		var main := await _enter()
		var boss := main.level.boss as RopeBoss
		boss._begin_attack()
		await _frames(70)
		await _tap(action)
		await _frames(24)
		_check(main.player.damage_count == 0, "Same-frame protection from %s must apply to the boss sweep, including after short protection expires" % action)
		main.free()

func _test_volley() -> void:
	for evade in [false, true]:
		var main := await _enter(180, not evade)
		var boss := main.level.boss as RopeBoss
		boss.attack = RopeBoss.Attack.PARALLEL_VOLLEY
		boss._begin_attack()
		var velocities: Array[Vector2] = []
		var positions: Array[Vector2] = []
		boss._volley_source.projectile_fired.connect(func(shot: EnemyProjectile) -> void:
			velocities.append(shot.velocity)
			positions.append(shot.get_global_transform_with_canvas().origin)
		)
		await _frames(70)
		_check(boss.shots_fired == 0, "Boss volleys must honor the entire warning")
		await _frames(7)
		_check(boss.shots_fired == 3 and main.level.projectile_root.get_child_count() == 3, "Boss volleys must fire three parallel bullets")
		for index in range(velocities.size()):
			_check(velocities[index].is_equal_approx(Vector2(-720, 0)) and positions[index].x > root.get_visible_rect().end.x, "Boss bullets must use the configured fixed direction and originate offscreen")
		await _frames(65)
		_check(main.player.damage_count == (0 if evade else 1), "The parallel volley must leave a gap on the upper rope side")
		_check(main.level.projectile_root.get_child_count() > 0, "Boss bullets must continue through the whole screen after passing the player")
		await _frames(60)
		_check(main.level.projectile_root.get_child_count() == 0, "Completed boss volleys must be recycled")
		main.free()

func _test_weak_point() -> void:
	var main := await _enter(180, true)
	var boss := main.level.boss as RopeBoss
	await _tap("skill")
	await _frames(10)
	_check(boss.health == 180, "The entrance observation window must not accept damage")
	_check(main.player.skill_immunity_remaining > 0.0 and main.combat.skill_cooldown_remaining > 11.0, "A guarded cast must still grant normal protection and consume cooldown")
	boss._begin_attack()
	main.combat.skill_cooldown_remaining = 0.0
	await _tap("skill")
	await _frames(10)
	_check(boss.health == 168 and main.combat.feedback.contains("护甲"), "Armor must accept half of the boss-specific skill damage")
	await _wait_for_recovery(boss)
	main.combat.skill_cooldown_remaining = 0.0
	await _tap("skill")
	await _frames(12)
	_check(boss.health == 144 and main.combat.kills == 0 and main.combat.feedback.contains("弱点"), "A real skill during recovery must deal twenty-four damage without a premature kill")
	_check(main.boss_name.text.contains("144 / 180") and main.boss_hint.text.contains("弱点"), "Boss HUD must show the real health and attack window")
	await _frames(12)
	_check(boss.health == 144, "One cast must not damage a boss more than once")
	main.free()

func _test_defeat_and_restart() -> void:
	var main := await _enter(24, true)
	current_scene = main
	var boss := main.level.boss as RopeBoss
	await _wait_for_recovery(boss)
	var shot := EnemyProjectile.new()
	shot.target = main.player
	shot.position = main.player.position + Vector2(800.0, -100.0)
	main.level.projectile_root.add_child(shot)
	await _tap("skill")
	await _frames(10)
	_check(boss.state == RopeBoss.State.DEFEATED and main.combat.kills == 1 and not main._finished, "A lethal skill must credit the kill before the short defeat animation")
	_check(not boss.enraged, "A lethal hit must skip enrage and go directly to defeat")
	_check(not is_instance_valid(shot), "Boss defeat must clear pending danger before the result delay")
	var remaining := boss.remaining
	paused = true
	await _frames(20)
	_check(boss.remaining == remaining and not main._finished, "Pause must also freeze the defeat animation")
	paused = false
	await _frames(45)
	_check(main._finished and paused and main.run_result.kills == 1 and main.result_body.text.contains("首领"), "Defeat must produce exactly one complete result with the boss kill included")
	main._restart_run()
	await _frames(3)
	main = current_scene
	_check(not is_instance_valid(boss) and main.level.boss == null and main.level.projectile_root.get_child_count() == 0, "Retry must discard the old boss and its projectiles")
	_check(main.combat.is_skill_ready() and main.player.health == 3 and not main.boss_panel.visible, "Retry must reset skill, health, boss UI and route progress")
	main.free()

func _test_death_cancels() -> void:
	var main := await _enter()
	var boss := main.level.boss as RopeBoss
	boss.attack = RopeBoss.Attack.PARALLEL_VOLLEY
	boss._begin_attack()
	main.player.take_damage(main.player.health)
	await _frames(2)
	_check(main._finished and boss.state == RopeBoss.State.CANCELLED and not boss.visible, "Player death must cancel the boss and its pending volley immediately")
	_check(main.level.projectile_root.get_child_count() == 0 and boss.shots_fired == 0, "A cancelled windup must never leave or emit live bullets")
	paused = false
	main.free()
	main = await _enter(180)
	boss = main.level.boss
	main.player.health = 1
	boss.data.active_seconds = 1.0 / 60.0
	boss._begin_attack()
	await _frames(75)
	_check(main._finished and boss.state == RopeBoss.State.CANCELLED and not boss.visible, "Fatal contact on the final sweep tick must not reopen recovery or leave the boss running")
	paused = false
	main.free()

func _test_long_chase() -> void:
	var main := await _enter(100000)
	var boss := main.level.boss as RopeBoss
	boss.data.shuriken_balls_enabled = true
	boss._begin_attack()
	boss.take_hit(100000)
	_check(boss.enraged and boss.health == 50000, "The stability replay must exercise the enhanced half-health patterns")
	var initial_nodes: int = main.level.get_child_count()
	for tick in range(36000):
		if main._finished:
			break
		await _dodge(boss)
		await _frames(1)
	_check(not main._finished and main.player.damage_count == 0 and boss.attacks_started >= 120, "Ten minutes of repeated enhanced patterns must remain avoidable with basic rope flips")
	_check(main.level.get_child_count() == initial_nodes and main.level.source_root.get_child_count() <= 3 and main.level.projectile_root.get_child_count() <= 6, "Repeated enhanced patterns must not accumulate bosses, emitters or bullets")
	_check(main.combat.friendly_root.get_child_count() <= 32 and main.combat.pickup_root.get_child_count() <= 1, "Long-running counterattacks and pickups must also remain bounded")
	_check(main.player.position.x > 200000.0 and boss.position.x > main.player.position.x, "A long chase must keep moving beyond the original camera boundary")
	main.free()

func _test_enrage_threshold() -> void:
	for hit_state in [RopeBoss.State.WINDUP, RopeBoss.State.ACTIVE, RopeBoss.State.RECOVERY]:
		var main := await _enter(181)
		var boss := main.level.boss as RopeBoss
		var events: Array[StringName] = []
		main.feedback.cue_played.connect(func(cue: StringName) -> void: events.append(cue))
		boss.take_hit(500)
		_check(boss.health == 181 and not boss.enraged, "Entrance immunity must also prevent premature enrage")
		boss.attack = RopeBoss.Attack.PARALLEL_VOLLEY
		boss._begin_attack()
		await _wait_for_state(boss, hit_state)
		var armored := not boss.is_vulnerable()
		boss.take_hit(180 if armored else 90)
		_check(boss.health == 91 and not boss.enraged, "Odd maximum health must not round the half-health trigger upwards")
		var remaining := boss.remaining
		boss.take_hit(2 if armored else 1)
		_check(boss.health == 90 and boss.enraged and events.count(&"boss_enrage") == 1, "Crossing half health must emit enrage exactly once in every combat state")
		_check(boss.state == hit_state and boss.remaining == remaining and boss.volley_waves == 1, "Enrage must preserve the current warning, active duration, recovery and snapshotted volley")
		boss.take_hit(2)
		_check(events.count(&"boss_enrage") == 1, "Further damage below half health must not retrigger enrage")
		await _wait_for_recovery(boss)
		await _frames(2)
		_check(boss.shots_fired == 3 and boss.is_vulnerable(), "A normal volley that crosses half health must still finish after one wave")
		_check(main.boss_name.text.contains("半血强化") and main.boss_hint.text.contains("弱点"), "HUD must show enrage while preserving the current weak-point hint")
		main.free()

func _test_enraged_volley() -> void:
	var main := await _enter()
	var boss := main.level.boss as RopeBoss
	boss._begin_attack()
	boss.take_hit(180)
	boss.data.shuriken_balls_enabled = true
	var events: Array[StringName] = []
	main.feedback.cue_played.connect(func(cue: StringName) -> void: events.append(cue))
	boss.attack = RopeBoss.Attack.PARALLEL_VOLLEY
	boss._begin_attack()
	var attack_count := boss.attacks_started
	var shots: Array[Dictionary] = []
	var record_shot := func(shot: EnemyProjectile) -> void:
		shots.append({"velocity": shot.velocity, "screen": shot.get_global_transform_with_canvas().origin})
	boss._volley_source.projectile_fired.connect(record_shot)
	_check(boss.volley_wave == 1 and boss.volley_waves == 2 and boss.get_hint().contains("1/2"), "Enhanced volley must announce the first of two waves")
	var ball := main.combat.pickup_root.get_child(0) as BossShurikenPickup
	var arrival: float = (ball.position.x - main.player.position.x) / main.player.tuning.run_speed
	_check(is_equal_approx(arrival, 3.65), "A double volley's single pickup must arrive after both waves, during recovery")
	await _frames(70)
	_check(boss.shots_fired == 0, "The first enhanced wave must preserve the full windup")
	await _wait_for_state(boss, RopeBoss.State.ACTIVE)
	await _wait_for_state(boss, RopeBoss.State.WINDUP)
	_check(boss.shots_fired == 3 and boss.volley_wave == 2 and not boss.is_vulnerable(), "The first wave must lead to a separately warned second wave without opening the weak point")
	_check(boss.attacks_started == attack_count and main.combat.pickup_root.get_child_count() == 1, "A follow-up wave must not create another action or pickup")
	_check(boss.get_hint().contains("2/2") and events.count(&"warning_bottom") == 2, "Each wave must show its own numbered warning and sound")
	boss._volley_source.projectile_fired.connect(record_shot)
	var remaining := boss.remaining
	var player_position: Vector2 = main.player.position
	paused = true
	await _frames(30)
	_check(boss.remaining == remaining and boss.shots_fired == 3 and main.player.position == player_position, "Pause must freeze the second warning and existing bullets")
	paused = false
	await _frames(68)
	_check(boss.shots_fired == 3 and boss.state == RopeBoss.State.WINDUP, "The second wave must also retain the full 1.2 second warning")
	await _wait_for_recovery(boss)
	_check(boss.shots_fired == 6 and shots.size() == 6 and boss.remaining > 2.5, "Both enhanced waves must fire three bullets before a complete recovery window")
	for shot in shots:
		_check(shot.velocity == Vector2(-720, 0) and shot.screen.x > root.get_visible_rect().end.x, "Every enhanced bullet must keep the configured direction, speed and offscreen origin")
	await _frames(40)
	_check(main.player.damage_count == 0 and main.combat.dart_groups == 1 and main.player.crystals == 0, "Basic rope positioning must dodge both waves and collect exactly one counterattack ball")
	main.free()

func _test_enraged_cancellation_and_retry() -> void:
	for stop in ["player_death", "boss_death", "retry"]:
		var main := await _enter()
		current_scene = main
		var boss := main.level.boss as RopeBoss
		boss._begin_attack()
		boss.take_hit(180)
		boss.attack = RopeBoss.Attack.PARALLEL_VOLLEY
		boss._begin_attack()
		await _wait_for_state(boss, RopeBoss.State.ACTIVE)
		await _wait_for_state(boss, RopeBoss.State.WINDUP)
		if stop == "player_death":
			main.player.take_damage(main.player.health)
		elif stop == "boss_death":
			boss.take_hit(1000)
		else:
			main._restart_run()
			await _frames(3)
			main = current_scene
			main.player.position.x = main.level.data.get_finish_x() - 65.0
			await _frames(12)
			var fresh := main.level.boss as RopeBoss
			_check(not is_instance_valid(boss) and fresh.health == 180 and not fresh.enraged and fresh.shots_fired == 0, "Retry after enrage must restore a fresh normal boss without pending waves")
			main.free()
			continue
		await _frames(90)
		_check(boss.shots_fired == 3 and boss._volley_source == null and main.level.source_root.get_child_count() == main.level.shooters.size() and main.level.projectile_root.get_child_count() == 0, "Death during the second warning must cancel the follow-up and clear all danger")
		paused = false
		main.free()

func _wait_for_state(boss: RopeBoss, target_state: RopeBoss.State) -> void:
	for tick in range(500):
		if boss.state == target_state:
			return
		await _dodge(boss)
		await _frames(1)
	_check(false, "The boss must reach state %s" % target_state)

func _wait_for_recovery(boss: RopeBoss) -> void:
	for tick in range(500):
		if boss.is_vulnerable():
			return
		await _dodge(boss)
		await _frames(1)
	_check(false, "The boss must open a recovery window")

func _dodge(boss: RopeBoss) -> void:
	var safe_side := PlayerController.ROPE_BOTTOM if boss.attack == RopeBoss.Attack.UPPER_SWEEP else PlayerController.ROPE_TOP
	if boss.state == RopeBoss.State.WINDUP and boss.player.on_rope and boss.player.rope_side != safe_side:
		await _tap("drop" if safe_side == PlayerController.ROPE_BOTTOM else "jump")

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
