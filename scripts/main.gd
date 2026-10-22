extends Node2D

@onready var player: PlayerController = $Player
@onready var status_text: Label = $UI/HUD/StatusText
@onready var result_overlay: ColorRect = $UI/HUD/ResultOverlay
@onready var result_title: Label = $UI/HUD/ResultOverlay/ResultTitle
@onready var result_body: Label = $UI/HUD/ResultOverlay/ResultBody
@onready var top_bar: ColorRect = $UI/HUD/TopBar

var _elapsed_time := 0.0
var _finished := false
var _platform_rects: Array[Rect2] = []
var _hazard_positions: Array[Vector2] = []
var _pickup_positions: Array[Vector2] = []
var _finish_position := Vector2(8500.0, 590.0)
var _hazard_scene := preload("res://scripts/hazard.gd")
var _pickup_scene := preload("res://scripts/pickup.gd")
var _finish_scene := preload("res://scripts/finish.gd")

func _ready() -> void:
	_ensure_input_map()
	_build_level()
	player.tuning = load("res://data/control_tuning.tres")
	player.health_changed.connect(_on_health_changed)
	player.crystal_collected.connect(_on_crystal_collected)
	player.run_failed.connect(_on_run_failed)
	player.active = true
	_update_status()
	queue_redraw()

func _process(delta: float) -> void:
	if not get_tree().paused and not _finished:
		_elapsed_time += delta
		_update_status()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("restart"):
		_restart_run()
		return
	if event.is_action_pressed("pause") and not _finished:
		get_tree().paused = not get_tree().paused
		if get_tree().paused:
			result_title.text = "已暂停"
			result_body.text = "按 Esc 继续
按 R 重新开始"
			result_overlay.visible = true
		else:
			result_overlay.visible = false

func _ensure_input_map() -> void:
	_add_key_action("jump", [KEY_SPACE, KEY_UP, KEY_W])
	_add_key_action("drop", [KEY_DOWN, KEY_S])
	_add_key_action("dash", [KEY_SHIFT])
	_add_key_action("attack", [KEY_J])
	_add_key_action("skill", [KEY_K])
	_add_key_action("pause", [KEY_ESCAPE])
	_add_key_action("restart", [KEY_R])

func _add_key_action(action_name: StringName, keycodes: Array) -> void:
	if not InputMap.has_action(action_name):
		InputMap.add_action(action_name)
	for keycode in keycodes:
		var event := InputEventKey.new()
		event.physical_keycode = keycode
		InputMap.action_add_event(action_name, event)

func _build_level() -> void:
	_add_rect_body(Rect2(-100.0, 620.0, 9000.0, 80.0), true)
	_add_platform(Rect2(760.0, 510.0, 340.0, 24.0))
	_add_platform(Rect2(1300.0, 460.0, 260.0, 24.0))
	_add_platform(Rect2(1900.0, 530.0, 260.0, 24.0))
	_add_platform(Rect2(2500.0, 430.0, 300.0, 24.0))
	_add_platform(Rect2(3300.0, 500.0, 380.0, 24.0))
	_add_platform(Rect2(4200.0, 450.0, 320.0, 24.0))
	_add_platform(Rect2(5200.0, 520.0, 420.0, 24.0))
	_add_platform(Rect2(6400.0, 450.0, 360.0, 24.0))
	for entry in [
		[900.0, 620.0, 48.0, 56.0], [1160.0, 620.0, 48.0, 56.0],
		[1500.0, 460.0, 44.0, 50.0], [2200.0, 620.0, 48.0, 56.0],
		[2750.0, 430.0, 44.0, 50.0], [3700.0, 620.0, 48.0, 56.0],
		[4620.0, 620.0, 48.0, 56.0], [5900.0, 620.0, 48.0, 56.0],
		[7100.0, 620.0, 48.0, 56.0]
	]:
		_add_hazard(Vector2(entry[0], entry[1]), Vector2(entry[2], entry[3]))
	for pickup_position in [
		Vector2(820.0, 450.0), Vector2(1420.0, 390.0), Vector2(2050.0, 470.0),
		Vector2(2650.0, 360.0), Vector2(3500.0, 440.0), Vector2(4350.0, 390.0),
		Vector2(5350.0, 460.0), Vector2(6550.0, 390.0)
	]:
		_add_pickup(pickup_position)
	var finish := _finish_scene.new()
	finish.position = _finish_position
	finish.reached.connect(_on_finish_reached)
	add_child(finish)

func _add_rect_body(rect: Rect2, is_ground := false) -> void:
	var body := StaticBody2D.new()
	body.position = rect.position + rect.size * 0.5
	body.collision_layer = 1 if is_ground else 513
	body.collision_mask = 0
	var shape_node := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = rect.size
	shape_node.shape = shape
	body.add_child(shape_node)
	add_child(body)
	_platform_rects.append(rect)

func _add_platform(rect: Rect2) -> void:
	_add_rect_body(rect)

func _add_hazard(base_position: Vector2, size: Vector2) -> void:
	var hazard := _hazard_scene.new()
	hazard.position = base_position
	hazard.hazard_size = size
	add_child(hazard)

func _add_pickup(pickup_position: Vector2) -> void:
	var pickup := _pickup_scene.new()
	pickup.position = pickup_position
	add_child(pickup)
	_pickup_positions.append(pickup_position)

func _on_health_changed(_current: int, _maximum: int) -> void:
	_update_status()

func _on_crystal_collected() -> void:
	_update_status()

func _on_run_failed(reason: String) -> void:
	_show_result("挑战失败", "%s
用时 %.1f 秒" % [reason, _elapsed_time])

func _on_finish_reached() -> void:
	if _finished:
		return
	_finished = true
	player.stop()
	var rank := _get_rank()
	_show_result("控制切片完成", "用时 %.1f 秒
评级 %s
影晶 %d / %d" % [_elapsed_time, rank, player.crystals, _pickup_positions.size()])

func _get_rank() -> String:
	if _elapsed_time <= 30.0 and player.damage_count == 0:
		return "S"
	if _elapsed_time <= 40.0 and player.damage_count <= 1:
		return "A"
	if _elapsed_time <= 55.0 and player.damage_count <= 2:
		return "B"
	return "C"

func _show_result(title: String, body: String) -> void:
	result_title.text = title
	result_body.text = body
	result_overlay.visible = true
	get_tree().paused = true

func _restart_run() -> void:
	get_tree().paused = false
	get_tree().reload_current_scene()

func _update_status() -> void:
	if not is_instance_valid(player) or player.tuning == null:
		return
	status_text.text = "生命 %d / %d    影晶 %d    时间 %.1fs" % [player.health, player.tuning.max_health, player.crystals, _elapsed_time]

func _draw() -> void:
	# Temporary code-drawn art keeps the control slice independent from final imagegen assets.
	draw_rect(Rect2(-500.0, -400.0, 10000.0, 1100.0), Color("111827"))
	draw_circle(Vector2(1800.0, 150.0), 78.0, Color("dde7e7"))
	draw_circle(Vector2(1770.0, 130.0), 78.0, Color("111827"))
	for index in range(10):
		var x := float(index * 1000 - 200)
		var hill_height := float(150 + (index % 3) * 55)
		draw_colored_polygon(PackedVector2Array([
			Vector2(x, 620.0), Vector2(x + 260.0, 620.0 - hill_height),
			Vector2(x + 560.0, 620.0)
		]), Color("233142"))
	for rect in _platform_rects:
		draw_rect(rect, Color("34495e"))
		draw_line(rect.position, Vector2(rect.end.x, rect.position.y), Color("d8b56a"), 3.0)
