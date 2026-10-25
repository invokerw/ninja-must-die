class_name RopeLevelController
extends Node2D

signal segment_changed(index: int, segment: RopeSegmentData)
signal finish_reached
signal boss_started(boss: RopeBoss)

@export var data: RopeLevelData = preload("res://data/levels/fog_ridge_60s.tres")
@export var boss_data: BossEncounterData

var hazards: Array[Hazard] = []
var enemies: Array[RopeSentry] = []
var shooters: Array[ScreenShooter] = []
var pickup_positions: Array[Vector2] = []
var active_segment := -1
var projectile_root: Node2D
var source_root: CanvasLayer
var boss: RopeBoss
var _player: PlayerController
var _background_end := 0.0

func build(player: PlayerController) -> bool:
	if data == null:
		push_error("缺少关卡资源")
		return false
	var errors := data.get_validation_errors()
	if boss_data != null:
		errors.append_array(boss_data.get_validation_errors(player.tuning.run_speed))
	if not errors.is_empty():
		push_error("\n".join(errors))
		return false
	_player = player
	projectile_root = Node2D.new()
	projectile_root.name = "Projectiles"
	add_child(projectile_root)
	source_root = CanvasLayer.new()
	source_root.name = "RangedSources"
	source_root.layer = 1
	add_child(source_root)
	player.rope_y = data.rope_y
	player.global_position = Vector2(data.start_x, data.rope_y - player.rope_offset)
	var camera := player.get_node("Camera2D") as Camera2D
	camera.limit_right = ceili(data.get_finish_x() + 640.0)
	camera.reset_smoothing()
	var segment_start := data.start_x
	for segment in data.segments:
		for entry in segment.hazards:
			var hazard := Hazard.new()
			hazard.position = Vector2(segment_start + entry.offset_x, data.rope_y)
			hazard.cable_side = entry.cable_side
			hazard.hazard_size = entry.size
			hazard.warning_distance = data.recommended_speed * data.warning_seconds
			add_child(hazard)
			hazards.append(hazard)
		for entry in segment.pickups:
			var side := PlayerController.ROPE_TOP if entry.cable_side == "top" else PlayerController.ROPE_BOTTOM
			var pickup := CrystalPickup.new()
			# Crystal height follows the attached body; level data cannot place it out of reach.
			pickup.position = Vector2(segment_start + entry.offset_x, data.rope_y - float(side) * player.rope_offset)
			add_child(pickup)
			pickup_positions.append(pickup.position)
		for entry in segment.enemies:
			if entry.enemy_type == "shooter":
				var shooter := ScreenShooter.new()
				shooter.trigger_x = segment_start + entry.offset_x
				shooter.cable_side = entry.cable_side
				shooter.windup_seconds = entry.windup_seconds
				shooter.projectile_speed = entry.projectile_speed
				shooter.screen_edge_offset = entry.screen_edge_offset
				shooter.screen_height_ratio = entry.screen_height_ratio
				shooter.fire_direction = entry.fire_direction
				shooter.volley_count = entry.volley_count
				shooter.volley_spacing = entry.volley_spacing
				shooter.projectile_parent = projectile_root
				shooter.bind_player(player)
				source_root.add_child(shooter)
				shooters.append(shooter)
				continue
			var side := PlayerController.ROPE_TOP if entry.cable_side == "top" else PlayerController.ROPE_BOTTOM
			var enemy := RopeSentry.new()
			enemy.position = Vector2(segment_start + entry.offset_x, data.rope_y - float(side) * player.rope_offset)
			enemy.cable_side = entry.cable_side
			enemy.max_health = entry.health
			enemy.warning_distance = data.recommended_speed * data.warning_seconds
			enemy.bind_player(player)
			add_child(enemy)
			enemies.append(enemy)
		segment_start += segment.length_px
	var finish := FinishGate.new()
	finish.position = Vector2(data.get_finish_x(), data.rope_y)
	finish.is_boss_entrance = boss_data != null
	finish.reached.connect(_on_route_end)
	add_child(finish)
	_background_end = data.get_finish_x() + 1000.0
	_update_segment()
	queue_redraw()
	return true

func _process(_delta: float) -> void:
	if is_instance_valid(_player) and _player.active:
		_update_segment()
		if is_instance_valid(boss) and _player.global_position.x + 1800.0 > _background_end:
			_background_end = _player.global_position.x + 4000.0
			queue_redraw()

func get_nominal_seconds() -> float:
	return data.get_nominal_seconds() + (boss_data.nominal_seconds if boss_data != null else 0.0)

func _on_route_end() -> void:
	if boss_data == null:
		finish_reached.emit()
		return
	_begin_boss.call_deferred()

func _begin_boss() -> void:
	if is_instance_valid(boss) or not _player.active:
		return
	clear_projectiles()
	for shooter in shooters:
		shooter.cancel()
	# The chase continues past the authored route, without pinning the runner to a wall.
	(_player.get_node("Camera2D") as Camera2D).limit_right = 2000000000
	boss = RopeBoss.new()
	boss.data = boss_data
	boss.player = _player
	boss.projectile_parent = projectile_root
	boss.source_parent = source_root
	boss.death_started.connect(clear_projectiles)
	boss.defeated.connect(func() -> void: finish_reached.emit())
	add_child(boss)
	boss_started.emit(boss)

func clear_projectiles() -> void:
	for projectile: EnemyProjectile in projectile_root.get_children():
		projectile.cancel()

func _update_segment() -> void:
	var index := data.get_segment_index(_player.global_position.x)
	if index != active_segment:
		active_segment = index
		segment_changed.emit(index, data.segments[index])

func _draw() -> void:
	if data == null:
		return
	# Control placeholders; final image assets follow the shared imagegen art direction.
	var end_x := maxf(_background_end, data.get_finish_x() + 1000.0)
	draw_rect(Rect2(-500.0, -400.0, end_x + 500.0, 1500.0), Color("111827"))
	draw_circle(Vector2(1800.0, 150.0), 78.0, Color("dde7e7"))
	draw_circle(Vector2(1770.0, 130.0), 78.0, Color("111827"))
	for index in range(ceili(end_x / 1000.0) + 1):
		var x := float(index * 1000 - 200)
		var hill_height := float(150 + (index % 3) * 55)
		draw_colored_polygon(PackedVector2Array([
			Vector2(x, 680.0), Vector2(x + 260.0, 680.0 - hill_height),
			Vector2(x + 560.0, 680.0)
		]), Color("233142"))
	draw_line(Vector2(-100.0, data.rope_y), Vector2(end_x, data.rope_y), Color("d8b56a"), 6.0)
	draw_line(Vector2(-100.0, data.rope_y + 7.0), Vector2(end_x, data.rope_y + 7.0), Color(0.22, 0.29, 0.36, 0.65), 2.0)
	for x in range(0, ceili(end_x), 600):
		draw_line(Vector2(x, data.rope_y - 24.0), Vector2(x, data.rope_y + 24.0), Color("34495e"), 3.0)
	var boundary := data.start_x
	for segment in data.segments:
		if boundary > data.start_x:
			draw_line(Vector2(boundary, 250.0), Vector2(boundary, 640.0), Color(0.85, 0.71, 0.42, 0.14), 2.0)
		boundary += segment.length_px
