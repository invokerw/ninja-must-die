class_name RunnerCombat
extends Node2D

signal changed

@onready var player: PlayerController = get_parent() as PlayerController

var kills := 0
var combo := 0
var max_combo := 0
var skill_casts := 0
var skill_cooldown_remaining := 0.0
var skill_flash_remaining := 0.0
var feedback := ""
var _skill_windup := 0.0
var _skill_pending := false
var _combo_remaining := 0.0
var _feedback_remaining := 0.0
var _hit_ids: Dictionary = {}
var _strike_origin := Vector2.ZERO
var weapon: WeaponRuntime
var boss: RopeBoss
var friendly_root: Node2D
var pickup_root: Node2D
var damage_by_source := {&"skill": 0, &"weapon": 0, &"pickup": 0}
var weapon_shots := 0
var dart_groups := 0
var _attack_sequence := 0
var _dart_remaining := 0
var _dart_delay := 0.0

const MAX_FRIENDLY_PROJECTILES := 32

func _ready() -> void:
	player.crystal_collected.connect(_on_crystal_collected)
	player.health_changed.connect(_on_health_changed)
	player.stopped.connect(_cancel_skill)
	player.physics_tick.connect(_physics_tick)
	weapon = WeaponRuntime.new(player.run_loadout.weapon)
	weapon.shot_requested.connect(_fire_weapon)
	friendly_root = Node2D.new()
	friendly_root.name = "PlayerProjectiles"
	friendly_root.top_level = true
	add_child(friendly_root)
	friendly_root.global_position = Vector2.ZERO
	pickup_root = Node2D.new()
	pickup_root.name = "BossPickups"
	pickup_root.top_level = true
	add_child(pickup_root)
	pickup_root.global_position = Vector2.ZERO

func _physics_tick(delta: float) -> void:
	weapon.tick(delta)
	if _dart_remaining > 0:
		_dart_delay -= delta
		while _dart_remaining > 0 and _dart_delay <= 0.00001:
			_dart_remaining -= 1
			_dart_delay += 0.08
			_spawn_projectile(_new_attack(&"pickup", &"shuriken_ball", 2), 1400.0, 8.0, 2.0, "dart")
	var was_cooling := skill_cooldown_remaining > 0.00001
	skill_cooldown_remaining = maxf(skill_cooldown_remaining - delta, 0.0)
	if was_cooling and skill_cooldown_remaining <= 0.00001:
		player.emit_feedback(&"ready")
	skill_flash_remaining = maxf(skill_flash_remaining - delta, 0.0)
	_combo_remaining = maxf(_combo_remaining - delta, 0.0)
	_feedback_remaining = maxf(_feedback_remaining - delta, 0.0)
	if _combo_remaining <= 0.00001:
		combo = 0
	if _feedback_remaining <= 0.0:
		feedback = ""
	if _skill_pending:
		_skill_windup = maxf(_skill_windup - delta, 0.0)
		if _skill_windup <= 0.00001:
			_skill_pending = false
			skill_flash_remaining = 0.30
			_strike()
	if Input.is_action_just_pressed("skill"):
		try_skill()
	if InputMap.has_action("weapon") and Input.is_action_just_pressed("weapon"):
		try_weapon()
	queue_redraw()

func is_skill_ready() -> bool:
	return player.active and player.configuration_errors.is_empty() and skill_cooldown_remaining <= 0.00001

func try_skill() -> bool:
	if not is_skill_ready() or get_tree().paused:
		return false
	var skill := player.character.active_skill
	skill_casts += 1
	skill_cooldown_remaining = skill.cooldown_seconds
	player.skill_immunity_remaining = skill.invulnerability_seconds
	_skill_windup = skill.cast_delay_seconds
	_skill_pending = true
	_hit_ids.clear()
	_set_feedback(skill.display_name)
	player.emit_feedback(&"skill")
	changed.emit()
	return true

func _strike() -> void:
	if not player.active:
		return
	var skill := player.character.active_skill
	_strike_origin = Vector2(player.global_position.x, player.rope_y if player.on_rope else player.global_position.y)
	player.emit_feedback(&"strike", _strike_origin)
	var shape := RectangleShape2D.new()
	shape.size = Vector2(skill.forward_range, skill.half_height * 2.0)
	var query := PhysicsShapeQueryParameters2D.new()
	query.shape = shape
	query.transform = Transform2D(0.0, _strike_origin + Vector2(skill.forward_range * 0.5, 0.0))
	query.collision_mask = 4
	query.collide_with_areas = true
	query.collide_with_bodies = false
	for result in get_world_2d().direct_space_state.intersect_shape(query, 64):
		var target := result.collider as Area2D
		if not (target is RopeSentry or target is RopeBoss) or _hit_ids.has(target.get_instance_id()):
			continue
		_hit_ids[target.get_instance_id()] = true
		if target is RopeBoss:
			resolve_boss_attack(target, _new_attack(&"skill", skill.skill_id, skill.boss_damage))
		elif target.take_hit(skill.damage):
			kills += 1
			_add_combo()
			_set_feedback("月蚀斩 · 击破哨兵")

func _cancel_skill() -> void:
	_skill_pending = false
	_skill_windup = 0.0
	skill_flash_remaining = 0.0
	_hit_ids.clear()
	if weapon != null:
		weapon.cancel()
	_dart_remaining = 0
	if is_instance_valid(friendly_root):
		for projectile in friendly_root.get_children():
			projectile.cancel()
	if is_instance_valid(pickup_root):
		for pickup in pickup_root.get_children():
			pickup.cancel()
	queue_redraw()

func bind_boss(target: RopeBoss) -> void:
	boss = target
	boss.death_started.connect(_cancel_skill)
	boss.attack_started.connect(_spawn_ball)

func is_weapon_ready() -> bool:
	return player.active and player.configuration_errors.is_empty() and is_instance_valid(boss) and boss.is_in_combat() and weapon.cooldown_remaining <= 0.00001 and weapon.shots_remaining == 0

func try_weapon() -> bool:
	if not is_weapon_ready() or get_tree().paused:
		return false
	if not weapon.try_cast():
		return false
	player.emit_feedback(&"weapon_cast")
	_set_feedback("%s · 出手" % weapon.data.display_name)
	changed.emit()
	return true

func _fire_weapon() -> void:
	var skill := weapon.data.skill
	if _spawn_projectile(_new_attack(&"weapon", weapon.data.weapon_id, skill.boss_damage), skill.projectile_speed, skill.turn_speed, skill.projectile_lifetime, skill.effect_id):
		weapon_shots += 1

func _new_attack(kind: StringName, source: StringName, amount: int) -> CombatAttack:
	_attack_sequence += 1
	return CombatAttack.new(kind, source, player.character.character_id, amount, _attack_sequence)

func _spawn_projectile(attack_info: CombatAttack, speed: float, turn: float, lifetime: float, visual: String) -> bool:
	if not player.active or not is_instance_valid(boss) or not boss.is_in_combat() or friendly_root.get_child_count() >= MAX_FRIENDLY_PROJECTILES:
		return false
	var projectile := PlayerProjectile.new()
	projectile.player = player
	projectile.target = boss
	projectile.attack = attack_info
	projectile.speed = speed
	projectile.turn_speed = turn
	projectile.lifetime_remaining = lifetime
	projectile.visual_kind = visual
	projectile.position = player.global_position + Vector2(22.0, 0.0)
	projectile.hit.connect(resolve_boss_attack)
	friendly_root.add_child(projectile)
	return true

func resolve_boss_attack(target: RopeBoss, attack_info: CombatAttack) -> void:
	if not player.active or not is_instance_valid(target) or not target.is_in_combat():
		return
	var was_weak := target.is_vulnerable()
	var dealt := target.receive_attack(attack_info)
	if dealt <= 0:
		return
	damage_by_source[attack_info.source_kind] = int(damage_by_source.get(attack_info.source_kind, 0)) + dealt
	if not target.alive:
		kills += 1
		_add_combo()
		_set_feedback("首领击破 · %s" % weapon.data.display_name if attack_info.source_kind == &"weapon" else "首领击破")
	elif attack_info.source_kind == &"skill":
		_set_feedback("月蚀斩 · 命中弱点" if was_weak else "月蚀斩 · 护甲减伤")
	changed.emit()

func _spawn_ball() -> void:
	if not is_instance_valid(boss) or not boss.is_in_combat() or not boss.data.shuriken_balls_enabled:
		return
	var side := PlayerController.ROPE_BOTTOM if boss.attack == RopeBoss.Attack.UPPER_SWEEP else PlayerController.ROPE_TOP
	var ball := BossShurikenPickup.new()
	ball.player = player
	ball.boss = boss
	ball.position = Vector2(player.global_position.x + player.tuning.run_speed * (boss.data.windup_seconds + boss.data.active_seconds + 0.35), player.rope_y - float(side) * player.rope_offset)
	ball.collected.connect(_collect_ball)
	pickup_root.add_child(ball)

func _collect_ball() -> void:
	if not player.active or not is_instance_valid(boss) or not boss.is_in_combat():
		return
	dart_groups += 1
	_dart_remaining += 3
	_dart_delay = 0.0
	player.emit_feedback(&"dart_pickup")

func _on_crystal_collected() -> void:
	_add_combo()

func _on_health_changed(_current: int, _maximum: int) -> void:
	combo = 0
	_combo_remaining = 0.0
	_set_feedback("受击，连击中断")
	changed.emit()

func _add_combo() -> void:
	combo += 1
	max_combo = maxi(combo, max_combo)
	_combo_remaining = player.tuning.combo_timeout
	changed.emit()

func _set_feedback(message: String) -> void:
	feedback = message
	_feedback_remaining = 1.2

func _draw() -> void:
	# Temporary geometry follows the prototype's shared moonlight/gold palette.
	if _skill_pending:
		draw_arc(Vector2.ZERO, 48.0, 0.0, TAU, 32, Color("d8b56a"), 4.0)
	if skill_flash_remaining > 0.0:
		var alpha := skill_flash_remaining / 0.30
		var origin := to_local(_strike_origin)
		var reach := player.character.active_skill.forward_range
		draw_line(origin, origin + Vector2(reach, 0.0), Color(0.85, 0.71, 0.42, alpha * 0.4), 72.0)
		draw_line(origin, origin + Vector2(reach, 0.0), Color(0.87, 0.91, 0.91, alpha), 5.0)
		draw_arc(origin + Vector2(180.0, 0.0), 100.0, -1.35, 1.35, 32, Color(0.85, 0.71, 0.42, alpha), 9.0)
