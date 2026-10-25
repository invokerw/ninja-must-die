extends SceneTree

const BOSS_SCENE := preload("res://scenes/boss_practice.tscn")
const CHARACTER := preload("res://data/characters/shadow_runner.tres")
const PROFILE_PATH := "res://.godot/test-weapon-profile.json"
var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var profile_scope := TestProfileScope.new("weapons")
	PlayerProfile._shared = PlayerProfile.new(PROFILE_PATH)
	_test_data_and_profile()
	await _test_setup_and_retry()
	await _test_weapon_damage()
	await _test_impact_time()
	await _test_balls()
	await _test_pause_and_cancel()
	await _test_lethal_sources()
	for weapon_id in PlayerProfile.STARTER_WEAPONS:
		await _replay(weapon_id, true, true)
	await _replay(&"crescent_wheel", true, false, false)
	await _replay(&"crescent_wheel", false, true, false)
	await _replay(&"crescent_wheel", true, false, true)
	profile_scope.close()
	for suffix in ["", ".bak", ".tmp", ".bak.tmp", ".corrupt"]:
		if FileAccess.file_exists(PROFILE_PATH + suffix):
			DirAccess.remove_absolute(ProjectSettings.globalize_path(PROFILE_PATH + suffix))
	if _failures == 0:
		print("WEAPONS_PASS (character equipment, save/reload, setup/retry, 2 weapons, real flight/impact, pickups, pause/cancel, 3 kill sources, loadout replays)")
	quit(0 if _failures == 0 else 1)

func _test_data_and_profile() -> void:
	for id in PlayerProfile.STARTER_WEAPONS:
		var data := PlayerProfile.WEAPONS[id] as WeaponData
		_check(data.get_validation_errors().is_empty(), "Both weapon resources must be valid")
	var bad := (PlayerProfile.WEAPONS[&"crescent_wheel"] as WeaponData).duplicate(true) as WeaponData
	bad.skill.cooldown_seconds = NAN
	_check(not bad.get_validation_errors().is_empty(), "Invalid weapon timing must be rejected")
	var file := FileAccess.open(PROFILE_PATH, FileAccess.WRITE)
	file.store_string(JSON.stringify({"version": 1, "best_times": {"level_01": 93.4}, "settings": {"sound": false}, "character_loadouts": {"shadow_runner": {"weapon_id": "removed"}}}))
	file.close()
	var profile := PlayerProfile.current()
	profile.load_profile()
	_check(profile.get_equipped_weapon(CHARACTER).weapon_id == &"crescent_wheel", "Unknown saved equipment must recover a playable default")
	_check(profile.try_equip(CHARACTER, &"star_lance"), "Unlocked weapon must be equipable before a run")
	var captured := profile.resolve(CHARACTER)
	_check(profile.save_profile(), "Equipment must save to disk")
	_check(profile.try_equip(CHARACTER, &"crescent_wheel") and profile.save_profile(), "A second save must atomically replace the existing file")
	var restored := PlayerProfile.new(PROFILE_PATH)
	restored.load_profile()
	_check(restored.get_equipped_weapon(CHARACTER).weapon_id == &"crescent_wheel", "A new profile instance must restore the last saved choice")
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(PROFILE_PATH))
	_check(document.best_times.level_01 == 93.4 and document.settings.sound == false, "Equipment saves must preserve unrelated scores and settings")
	_check(captured.weapon.weapon_id == &"star_lance", "Equipping another weapon must not mutate the already captured loadout")
	var copied := captured.copy()
	copied.weapon.skill.boss_damage = 100
	copied.character.passive.extra_air_jumps = 0
	_check(captured.weapon.skill.boss_damage == 16 and CHARACTER.passive.extra_air_jumps == 1, "Snapshots must deep-copy weapon and character configuration")
	profile.owned_weapon_ids = [&"crescent_wheel"]
	_check(not profile.try_equip(CHARACTER, &"star_lance"), "An unowned weapon must not be equipable")
	profile.owned_weapon_ids = PlayerProfile.STARTER_WEAPONS.duplicate()
	_check(not profile.try_equip(CHARACTER, &"missing"), "An unknown weapon must not replace valid equipment")
	profile.owned_weapon_ids = [&"star_lance"]
	profile.character_loadouts["shadow_runner"] = {"weapon_id": "missing"}
	_check(profile.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance" and profile.owned_weapon_ids.size() == 1, "Invalid equipment must prefer an already owned compatible weapon")
	profile.owned_weapon_ids = PlayerProfile.STARTER_WEAPONS.duplicate()
	profile.try_equip(CHARACTER, &"crescent_wheel")
	profile.save_profile()
	var broken := PlayerProfile.new("res://.godot/missing-profile-dir/save.json")
	_check(broken.try_equip(CHARACTER, &"star_lance") and not broken.save_profile() and broken.get_equipped_weapon(CHARACTER).weapon_id == &"star_lance", "A failed save must keep the in-memory choice and report failure")
	var future_path := "res://.godot/test-future-profile.json"
	var future_text := JSON.stringify({"version": 2, "future_field": [1, 2, 3]})
	file = FileAccess.open(future_path, FileAccess.WRITE)
	file.store_string(future_text)
	file.close()
	var future := PlayerProfile.new(future_path)
	future.load_profile()
	_check(future.try_equip(CHARACTER, &"star_lance") and not future.save_profile() and FileAccess.get_file_as_string(future_path) == future_text, "An unsupported newer save must remain intact while equipment still works in memory")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(future_path))

func _test_setup_and_retry() -> void:
	var setup: Control = load("res://scenes/ui/character_setup.tscn").instantiate()
	root.add_child(setup)
	current_scene = setup
	setup._select_weapon(PlayerProfile.WEAPONS[&"star_lance"])
	_check(PlayerProfile.current().get_equipped_weapon(CHARACTER).weapon_id == &"crescent_wheel" and setup.preview_title.text == "贯星矛", "Previewing a card must not equip it")
	setup._equip_selected()
	_check(setup.equip_button.disabled and setup.status.text.contains("贯星矛"), "Equip action must update the active character slot and UI")
	setup.profile.save_path = "res://.godot/missing-profile-dir/save.json"
	setup._select_weapon(PlayerProfile.WEAPONS[&"crescent_wheel"])
	setup._equip_selected()
	_check(not setup.equip_button.disabled and setup.equip_button.text == "重试保存" and setup.profile.save_pending, "A failed save must leave a usable retry action")
	setup.profile.save_path = PROFILE_PATH
	setup._equip_selected()
	_check(setup.equip_button.disabled and not setup.profile.save_pending, "Retrying save must persist the already equipped choice")
	setup._select_weapon(PlayerProfile.WEAPONS[&"star_lance"])
	setup._equip_selected()
	setup._launch("res://scenes/boss_practice.tscn")
	await _frames(15)
	var main := current_scene
	_check(main.run_loadout.weapon.weapon_id == &"star_lance" and main.player.run_loadout == main.run_loadout, "Launch must pass the selected weapon to the actual character")
	_check(main.weapon_text.text.contains("贯星矛") and main.combat.weapon.data.skill.cooldown_seconds == 8.0, "Weapon HUD and runtime must read the equipped data")
	_check(not PlayerProfile.current().try_equip(CHARACTER, &"crescent_wheel"), "The role module must reject live equipment changes")
	main._toggle_character_details()
	var position: Vector2 = main.player.position
	await _frames(10)
	_check(paused and main.player.position == position and not PlayerProfile.current().try_equip(CHARACTER, &"crescent_wheel"), "Character inspection must pause and remain read-only")
	main._toggle_character_details()
	# Even an external profile edit must not change the current run or its retry.
	PlayerProfile.current().character_loadouts["shadow_runner"] = {"weapon_id": "crescent_wheel"}
	main._restart_run()
	await _frames(15)
	main = current_scene
	_check(main.run_loadout.weapon.weapon_id == &"star_lance" and main.combat.weapon.cooldown_remaining == 0.0 and main.combat.friendly_root.get_child_count() == 0, "Retry must preserve the original loadout and rebuild empty runtime state")
	main._return_to_setup()
	await _frames(4)
	setup = current_scene
	_check(setup.selected_weapon.weapon_id == &"crescent_wheel" and get_nodes_in_group("run_sessions").is_empty(), "Returning to preparation must unlock equipment and resolve the next choice")
	setup.free()

func _spawn(id: StringName = &"crescent_wheel", balls: bool = false) -> Node2D:
	var main := BOSS_SCENE.instantiate()
	main.run_loadout = RunLoadout.capture(CHARACTER, PlayerProfile.WEAPONS[id])
	main.get_node("Level").boss_data = main.get_node("Level").boss_data.duplicate(true)
	main.get_node("Level").boss_data.shuriken_balls_enabled = balls
	root.add_child(main)
	await _frames(12)
	return main

func _test_weapon_damage() -> void:
	for id in PlayerProfile.STARTER_WEAPONS:
		for weak in [false, true]:
			var main := await _spawn(id)
			var boss := main.level.boss as RopeBoss
			_check(not main.combat.try_weapon() and main.combat.weapon.casts == 0, "Entrance must not consume a weapon cast")
			boss.state = RopeBoss.State.RECOVERY if weak else RopeBoss.State.WINDUP
			boss.remaining = 10.0
			var position: Vector2 = main.player.position
			await _tap("weapon")
			_check(not main.combat.try_weapon(), "A cooldown cannot accept a second weapon cast")
			await _frames(55)
			var data := main.run_loadout.weapon as WeaponData
			var damage: int = data.skill.boss_damage * data.skill.projectile_count
			if not weak:
				damage /= 2
			_check(boss.health == 180 - damage and main.combat.weapon_shots == data.skill.projectile_count, "Each real weapon projectile must hit once using the advertised armor multiplier")
			_check(main.combat.damage_by_source[&"weapon"] == damage and main.combat.combo == 0, "Per-source damage must not create combo or kill credit for every small hit")
			_check(main.player.position.x > position.x + 250.0 and not main.player.is_invulnerable(), "Weapons must allow running without granting protection")
			main.free()
	var main := await _spawn()
	main.level.boss.state = RopeBoss.State.RECOVERY
	main.level.boss.remaining = 10.0
	Input.action_press("weapon")
	Input.action_press("skill")
	await _frames(1)
	Input.action_release("weapon")
	Input.action_release("skill")
	_check(main.player.skill_immunity_remaining > 1.9 and main.combat.weapon.cooldown_remaining > 5.9 and main.combat.skill_cooldown_remaining > 11.9, "Same-frame J/K must start independent cooldowns and immediate K protection")
	await _frames(55)
	_check(main.level.boss.health == 144 and main.combat.damage_by_source[&"skill"] == 24 and main.combat.damage_by_source[&"weapon"] == 12, "J and K must independently damage the same weak point")
	main.free()

func _test_impact_time() -> void:
	for into_weak in [true, false]:
		var main := await _spawn()
		var boss := main.level.boss as RopeBoss
		boss.state = RopeBoss.State.ACTIVE if into_weak else RopeBoss.State.RECOVERY
		boss.remaining = 1.0 / 60.0
		main.combat._spawn_projectile(main.combat._new_attack(&"weapon", &"crescent_wheel", 4), 1300, 6, 2, "volley")
		var shot := main.combat.friendly_root.get_child(0) as PlayerProjectile
		shot.global_position = boss.global_position - Vector2(60, 0)
		await _frames(2)
		_check(boss.health == (176 if into_weak else 178), "A projectile crossing a state boundary must use armor at impact, not at launch")
		main.free()

func _test_balls() -> void:
	for collect in [true, false]:
		var main := await _spawn(&"crescent_wheel", true)
		main.player.skill_immunity_remaining = 1000.0
		if collect:
			await _tap("drop")
		await _frames(290)
		_check(main.player.crystals == 0 and main.combat.combo == 0 and main.combat.kills == 0, "Shuriken pickups must not inflate crystals, combo or kills")
		_check(main.combat.dart_groups == (1 if collect else 0) and main.combat.damage_by_source[&"pickup"] == (6 if collect else 0), "Only contact on the correct rope side must fire a real three-dart counterattack")
		_check(main.combat.pickup_root.get_child_count() == 0, "Collected or missed balls must be recycled")
		main.free()

func _test_pause_and_cancel() -> void:
	var main := await _spawn(&"star_lance")
	main.level.boss.state = RopeBoss.State.RECOVERY
	main.level.boss.remaining = 10.0
	await _tap("weapon")
	var cooldown: float = main.combat.weapon.cooldown_remaining
	var pending: float = main.combat.weapon.next_shot_remaining
	paused = true
	await _frames(30)
	_check(main.combat.weapon.cooldown_remaining == cooldown and main.combat.weapon.next_shot_remaining == pending and main.combat.weapon_shots == 0, "Pause must freeze both cooldown and the delayed lance")
	paused = false
	await _frames(45)
	_check(main.combat.weapon_shots == 1 and main.level.boss.health == 164, "A paused lance must resume and hit exactly once")
	main.combat.weapon.cooldown_remaining = 0.0
	await _tap("weapon")
	main.player.take_damage(main.player.health)
	await _frames(2)
	_check(main.combat.weapon.shots_remaining == 0 and main.combat.friendly_root.get_child_count() == 0 and main.combat.pickup_root.get_child_count() == 0, "Death must cancel pending shots, friendly projectiles and balls")
	paused = false
	main.free()

func _test_lethal_sources() -> void:
	for source in [&"weapon", &"skill", &"pickup"]:
		var main := await _spawn()
		var boss := main.level.boss as RopeBoss
		boss.state = RopeBoss.State.RECOVERY
		boss.remaining = 10.0
		boss.health = 2
		if source == &"pickup":
			main.combat._collect_ball()
		else:
			await _tap(String(source))
		await _frames(100)
		_check(main._finished and main.run_result.kills == 1 and main.combat.kills == 1, "Each attack source must produce exactly one real boss kill before results")
		_check(main.combat.friendly_root.get_child_count() == 0 and main.combat.weapon.shots_remaining == 0 and main.combat._dart_remaining == 0, "Defeat must clear remaining shots and automatic bursts")
		var kills: int = main.combat.kills
		main.combat.resolve_boss_attack(boss, main.combat._new_attack(source, source, 24))
		_check(main.combat.kills == kills, "Late hits cannot add a second kill after death")
		paused = false
		main.free()

func _replay(id: StringName, use_weapon: bool, use_skill: bool, balls: bool = true) -> void:
	var main := await _spawn(id, balls)
	var boss := main.level.boss as RopeBoss
	for tick in range(10000):
		if main._finished:
			break
		var safe := PlayerController.ROPE_BOTTOM if boss.attack == RopeBoss.Attack.UPPER_SWEEP else PlayerController.ROPE_TOP
		if boss.state == RopeBoss.State.WINDUP and main.player.rope_side != safe:
			await _tap("drop" if safe == PlayerController.ROPE_BOTTOM else "jump")
		if boss.is_vulnerable():
			if use_weapon and boss.remaining > 0.9 and main.combat.is_weapon_ready():
				await _tap("weapon")
			if use_skill and boss.remaining > 0.3 and main.combat.is_skill_ready():
				await _tap("skill")
		await _frames(1)
	_check(main._finished and boss.health == 0 and main.player.damage_count == 0, "Both loadouts and conservative attack combinations must complete a real no-damage chase")
	_check(int(main.combat.damage_by_source[&"weapon"]) + int(main.combat.damage_by_source[&"skill"]) + int(main.combat.damage_by_source[&"pickup"]) == 180, "Damage attribution must equal the actual boss health removed")
	if use_weapon and use_skill and balls:
		_check(main._elapsed_time >= 25.0 and main._elapsed_time <= 45.0, "Three-channel combat must meet the initial boss duration target")
	print("WEAPON_REPLAY %s J=%s K=%s balls=%s: %.2fs, damage %s" % [id, use_weapon, use_skill, balls, main._elapsed_time, main.combat.damage_by_source])
	paused = false
	main.free()

func _tap(action: String) -> void:
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
