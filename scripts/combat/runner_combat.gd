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

func _ready() -> void:
	player.crystal_collected.connect(_on_crystal_collected)
	player.health_changed.connect(_on_health_changed)
	player.stopped.connect(_cancel_skill)
	player.physics_tick.connect(_physics_tick)

func _physics_tick(delta: float) -> void:
	skill_cooldown_remaining = maxf(skill_cooldown_remaining - delta, 0.0)
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
	changed.emit()
	return true

func _strike() -> void:
	if not player.active:
		return
	var skill := player.character.active_skill
	_strike_origin = Vector2(player.global_position.x, player.rope_y if player.on_rope else player.global_position.y)
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
		var health_before: int = target.health
		if target.take_hit(skill.damage):
			kills += 1
			_add_combo()
			_set_feedback("月蚀斩 · 首领击破" if target is RopeBoss else "月蚀斩 · 击破哨兵")
		elif target is RopeBoss:
			_set_feedback("月蚀斩 · 命中弱点" if target.health < health_before else "护甲未破 · 收招时再用 K")

func _cancel_skill() -> void:
	_skill_pending = false
	_skill_windup = 0.0
	skill_flash_remaining = 0.0
	_hit_ids.clear()
	queue_redraw()

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
