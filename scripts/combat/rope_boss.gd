class_name RopeBoss
extends Area2D

signal death_started
signal defeated
signal attack_started

enum State { ENTRANCE, WINDUP, ACTIVE, RECOVERY, DEFEATED, CANCELLED }
enum Attack { UPPER_SWEEP, LOWER_SWEEP, PARALLEL_VOLLEY }

var data: BossEncounterData
var player: PlayerController
var projectile_parent: Node2D
var source_parent: CanvasLayer
var health := 0
var alive := true
var state := State.ENTRANCE
var attack := Attack.UPPER_SWEEP
var remaining := 0.0
var attacks_started := 0
var shots_fired := 0
var _phase := 0.0
var _hit_flash := 0.0
var _beam_contact_resolved := false
var _target_shape: CollisionShape2D
var _beam_shape := RectangleShape2D.new()
var _volley_source: ScreenShooter
var hit_shape: CollisionShape2D
var previous_physics_position := Vector2.ZERO
var _completion_emitted := false

func _ready() -> void:
	process_physics_priority = 5
	collision_layer = 4
	collision_mask = 0
	monitoring = false
	health = data.max_health
	remaining = data.entrance_seconds
	var collision := CollisionShape2D.new()
	hit_shape = collision
	var shape := RectangleShape2D.new()
	shape.size = Vector2(104.0, 112.0)
	collision.shape = shape
	add_child(collision)
	add_to_group("bosses")
	_target_shape = player.get_node("CollisionShape2D") as CollisionShape2D
	player.stopped.connect(_cancel)
	_sync_position()
	previous_physics_position = global_position
	player.emit_feedback(&"boss_enter", global_position)

func _physics_process(delta: float) -> void:
	if state == State.CANCELLED or _completion_emitted:
		return
	if not is_instance_valid(player) or not player.active:
		_cancel()
		return
	previous_physics_position = global_position
	_sync_position()
	_phase += delta
	_hit_flash = maxf(_hit_flash - delta, 0.0)
	remaining = maxf(remaining - delta, 0.0)
	match state:
		State.ENTRANCE:
			if remaining <= 0.00001:
				_begin_attack()
		State.WINDUP:
			if remaining <= 0.00001:
				state = State.ACTIVE
				remaining = data.active_seconds
				if attack != Attack.PARALLEL_VOLLEY:
					player.emit_feedback(&"sweep", global_position)
		State.ACTIVE:
			if attack != Attack.PARALLEL_VOLLEY:
				_check_beam_contact()
			if not player.active:
				return
			if remaining <= 0.00001:
				state = State.RECOVERY
				remaining = data.recovery_seconds
				player.emit_feedback(&"weakpoint", global_position)
		State.RECOVERY:
			if remaining <= 0.00001:
				_clear_source()
				attack = (attack + 1) % Attack.size() as Attack
				_begin_attack()
		State.DEFEATED:
			if remaining <= 0.00001:
				_completion_emitted = true
				defeated.emit()
	queue_redraw()

func _sync_position() -> void:
	# Chase alongside the runner; the configured projectiles never aim at this position.
	global_position = Vector2(player.global_position.x + data.forward_offset, player.rope_y - 64.0)

func _begin_attack() -> void:
	state = State.WINDUP
	remaining = data.windup_seconds
	_beam_contact_resolved = false
	attacks_started += 1
	var lower_warning := attack == Attack.LOWER_SWEEP or (attack == Attack.PARALLEL_VOLLEY and data.volley.cable_side == "bottom")
	player.emit_feedback(&"warning_bottom" if lower_warning else &"warning_top", global_position)
	attack_started.emit()
	if attack != Attack.PARALLEL_VOLLEY:
		return
	var pattern := data.volley
	_volley_source = ScreenShooter.new()
	_volley_source.trigger_x = player.global_position.x
	_volley_source.cable_side = pattern.cable_side
	_volley_source.windup_seconds = pattern.windup_seconds
	_volley_source.projectile_speed = pattern.projectile_speed
	_volley_source.screen_edge_offset = pattern.screen_edge_offset
	_volley_source.screen_height_ratio = pattern.screen_height_ratio
	_volley_source.fire_direction = pattern.fire_direction
	_volley_source.volley_count = pattern.volley_count
	_volley_source.volley_spacing = pattern.volley_spacing
	_volley_source.warning_sound_enabled = false
	_volley_source.projectile_parent = projectile_parent
	_volley_source.bind_player(player)
	_volley_source.projectile_fired.connect(_on_projectile_fired)
	source_parent.add_child(_volley_source)

func _on_projectile_fired(_projectile: EnemyProjectile) -> void:
	shots_fired += 1

func is_vulnerable() -> bool:
	return alive and state == State.RECOVERY

func is_in_combat() -> bool:
	return alive and state in [State.WINDUP, State.ACTIVE, State.RECOVERY]

func receive_attack(attack_info: CombatAttack) -> int:
	var before := health
	take_hit(attack_info.damage)
	return before - health

func take_hit(amount: int) -> bool:
	if not is_in_combat() or amount <= 0 or not player.active:
		return false
	amount = amount if is_vulnerable() else floori(float(amount) * 0.5)
	if amount <= 0:
		return false
	health = maxi(health - amount, 0)
	_hit_flash = 0.18
	if health > 0:
		player.emit_feedback(&"weak_hit" if is_vulnerable() else &"armor_hit", global_position)
		return false
	alive = false
	state = State.DEFEATED
	remaining = data.death_seconds
	player.emit_feedback(&"boss_kill", global_position)
	set_deferred("monitorable", false)
	_clear_source()
	death_started.emit()
	return true

func _beam_rect() -> Rect2:
	var viewport := get_viewport()
	var inverse_canvas := viewport.get_canvas_transform().affine_inverse()
	var bounds := viewport.get_visible_rect()
	var left := inverse_canvas * Vector2(bounds.position.x - 96.0, 0.0)
	var right := inverse_canvas * Vector2(bounds.end.x + 96.0, 0.0)
	var lane_y := player.rope_y + (-player.rope_offset if attack == Attack.UPPER_SWEEP else player.rope_offset)
	return Rect2(left.x, lane_y - data.beam_height * 0.5, right.x - left.x, data.beam_height)

func _check_beam_contact() -> void:
	if _beam_contact_resolved:
		return
	var rect := _beam_rect()
	_beam_shape.size = rect.size
	var motion := player.global_position - player.previous_physics_position
	if player.on_rope:
		motion.y = 0.0
	var start := _target_shape.global_transform
	start.origin -= motion
	if _target_shape.shape.collide_with_motion(start, motion, _beam_shape, Transform2D(0.0, rect.get_center()), Vector2.ZERO):
		_beam_contact_resolved = true
		player.take_damage()

func get_attack_name() -> String:
	return ["断索横扫 · 上侧", "反刃掠绳 · 下侧", "三重平射 · 留意间隙"][attack]

func get_hint() -> String:
	match state:
		State.ENTRANCE:
			return "首领现身 · 飞镖球反击，J 武器 / K 忍术"
		State.WINDUP:
			return "%s · 蓄力 %.1fs · 护甲减伤" % [get_attack_name(), remaining]
		State.ACTIVE:
			return "%s · 躲避 / 护甲减伤" % get_attack_name()
		State.RECOVERY:
			return "弱点开放 %.1fs · J / K 爆发" % remaining
		State.DEFEATED:
			return "首领击破"
	return ""

func _clear_source() -> void:
	if is_instance_valid(_volley_source):
		_volley_source.cancel()
		_volley_source.queue_free()
	_volley_source = null

func _cancel() -> void:
	_clear_source()
	if state != State.DEFEATED:
		state = State.CANCELLED
		set_deferred("monitorable", false)
		hide()

func _draw() -> void:
	if state == State.CANCELLED:
		return
	if attack != Attack.PARALLEL_VOLLEY and state in [State.WINDUP, State.ACTIVE]:
		var rect := _beam_rect()
		rect.position = to_local(rect.position)
		var active := state == State.ACTIVE
		var tint := Color("b24b4b") if active else Color("d8b56a")
		draw_rect(rect, Color(tint, 0.55 if active else 0.10))
		draw_rect(rect, Color(tint, 0.95 if active else 0.65), false, 3.0)
		if active:
			draw_line(Vector2(rect.position.x, rect.get_center().y), Vector2(rect.end.x, rect.get_center().y), Color("f0c36d"), 6.0)
		else:
			var charge := 1.0 - remaining / data.windup_seconds
			for index in range(ceili(rect.size.x / 100.0)):
				var marker := Vector2(rect.position.x + float(index) * 100.0, rect.get_center().y)
				draw_line(marker + Vector2(8, -8), marker + Vector2(-8, 0), Color(tint, 0.4 + charge * 0.5), 3.0)
				draw_line(marker + Vector2(-8, 0), marker + Vector2(8, 8), Color(tint, 0.4 + charge * 0.5), 3.0)
	var fade := clampf(remaining / data.death_seconds, 0.0, 1.0) if state == State.DEFEATED else 1.0
	var tint := Color("dde7e7") if _hit_flash > 0.0 else Color("b24b4b")
	tint.a = fade
	var wing := sin(_phase * 4.0) * 8.0
	draw_colored_polygon(PackedVector2Array([Vector2(-128, -34 + wing), Vector2(-48, -22), Vector2(0, -70), Vector2(48, -22), Vector2(128, -34 + wing), Vector2(74, 32), Vector2(0, 64), Vector2(-74, 32)]), tint)
	draw_colored_polygon(PackedVector2Array([Vector2(-40, -30), Vector2(0, -52), Vector2(40, -30), Vector2(34, 34), Vector2(0, 50), Vector2(-34, 34)]), Color(Color("233142"), fade))
	var core := Color("f0c36d") if is_vulnerable() else Color("91a1ad")
	core.a = fade
	draw_circle(Vector2.ZERO, 18.0 if is_vulnerable() else 12.0, core)
	draw_arc(Vector2.ZERO, 34.0 + sin(_phase * 8.0) * 3.0, 0.0, TAU, 40, core, 3.0)
	if not is_vulnerable() and alive:
		draw_line(Vector2(-22, -30), Vector2(22, 30), core, 5.0)
		draw_line(Vector2(22, -30), Vector2(-22, 30), core, 5.0)
