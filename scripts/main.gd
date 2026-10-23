extends Node2D

const ROPE_Y := 520.0
const FINISH_X := 8500.0

@onready var player: PlayerController = $Player
@onready var status_text: Label = $UI/HUD/StatusText
@onready var hint_text: Label = $UI/HUD/HintText
@onready var result_overlay: ColorRect = $UI/HUD/ResultOverlay
@onready var result_title: Label = $UI/HUD/ResultOverlay/ResultTitle
@onready var result_body: Label = $UI/HUD/ResultOverlay/ResultBody
@onready var threat_text: Label = $UI/HUD/ThreatText
@onready var progress_fill: ColorRect = $UI/HUD/ProgressBack/ProgressFill
@onready var progress_label: Label = $UI/HUD/ProgressLabel

var _elapsed_time := 0.0
var _finished := false
var _pickup_positions: Array[Vector2] = []
var _hazards: Array[Hazard] = []
var _finish_scene := preload("res://scripts/finish.gd")
var _hazard_scene := preload("res://scripts/hazard.gd")
var _pickup_scene := preload("res://scripts/pickup.gd")

func _ready() -> void:
	_ensure_input_map()
	player.rope_y = ROPE_Y
	player.global_position = Vector2(160.0, ROPE_Y - player.rope_offset)
	_build_level()
	player.health_changed.connect(_on_health_changed)
	player.crystal_collected.connect(_on_crystal_collected)
	player.rope_side_changed.connect(_on_rope_side_changed)
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
			result_body.text = "按 Esc 继续\n按 R / Enter 重新开始"
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
	_add_key_action("restart", [KEY_R, KEY_ENTER, KEY_KP_ENTER])

func _add_key_action(action_name: StringName, keycodes: Array) -> void:
	if not InputMap.has_action(action_name):
		InputMap.add_action(action_name)
	for keycode in keycodes:
		var already_bound := false
		for existing in InputMap.action_get_events(action_name):
			if existing is InputEventKey and existing.physical_keycode == keycode:
				already_bound = true
				break
		if already_bound:
			continue
		var event := InputEventKey.new()
		event.physical_keycode = keycode
		InputMap.action_add_event(action_name, event)

func _build_level() -> void:
	# A single horizontal cable is the control slice. Each hazard explicitly targets its side.
	for entry in [
		[900.0, "top", 72.0], [1240.0, "bottom", 72.0],
		[1640.0, "top", 84.0], [2020.0, "bottom", 84.0],
		[2440.0, "top", 72.0], [2820.0, "bottom", 72.0],
		[3400.0, "top", 92.0], [3820.0, "bottom", 92.0],
		[4300.0, "top", 76.0], [4680.0, "bottom", 76.0],
		[5300.0, "top", 96.0], [5700.0, "bottom", 96.0],
		[6300.0, "top", 72.0], [6700.0, "bottom", 72.0],
		[7300.0, "top", 90.0], [7700.0, "bottom", 90.0]
	]:
		_add_hazard(float(entry[0]), String(entry[1]), float(entry[2]))
	for entry in [
		[1060.0, "bottom"], [1450.0, "top"], [1840.0, "bottom"],
		[2250.0, "top"], [3030.0, "bottom"], [3600.0, "top"],
		[4100.0, "bottom"], [5100.0, "top"], [6100.0, "bottom"],
		[7100.0, "top"]
	]:
		_add_pickup(float(entry[0]), String(entry[1]))

	var finish := _finish_scene.new()
	finish.process_mode = Node.PROCESS_MODE_PAUSABLE
	finish.position = Vector2(FINISH_X, ROPE_Y)
	finish.reached.connect(_on_finish_reached)
	add_child(finish)

func _add_hazard(x_position: float, cable_side: String, height: float) -> void:
	var hazard := _hazard_scene.new()
	hazard.position = Vector2(x_position, ROPE_Y)
	hazard.process_mode = Node.PROCESS_MODE_PAUSABLE
	hazard.cable_side = cable_side
	hazard.hazard_size = Vector2(54.0, height)
	add_child(hazard)
	_hazards.append(hazard)

func _add_pickup(x_position: float, cable_side: String) -> void:
	var side := PlayerController.ROPE_TOP if cable_side == "top" else PlayerController.ROPE_BOTTOM
	var pickup := _pickup_scene.new()
	pickup.process_mode = Node.PROCESS_MODE_PAUSABLE
	# Ordinary crystals follow the attached player's body on either side of the rope.
	pickup.position = Vector2(x_position, player.rope_y - float(side) * player.rope_offset)
	add_child(pickup)
	_pickup_positions.append(pickup.position)

func _on_health_changed(_current: int, _maximum: int) -> void:
	_update_status()

func _on_crystal_collected() -> void:
	_update_status()

func _on_rope_side_changed(_side: int) -> void:
	_update_status()

func _on_run_failed(reason: String) -> void:
	_show_result("挑战失败", "%s\n用时 %.1f 秒" % [reason, _elapsed_time])

func _on_finish_reached() -> void:
	if _finished:
		return
	_finished = true
	player.stop()
	var rank := _get_rank()
	_show_result("钢索切片完成", "用时 %.1f 秒\n评级 %s\n影晶 %d / %d" % [_elapsed_time, rank, player.crystals, _pickup_positions.size()])

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
	var progress := clampf(inverse_lerp(160.0, FINISH_X, player.global_position.x), 0.0, 1.0)
	progress_fill.size.x = 320.0 * progress
	progress_label.text = "终点进度  %d%%" % roundi(progress * 100.0)
	status_text.text = "生命 %d / %d    影晶 %d    时间 %.1fs    位置：%s" % [
		player.health, player.tuning.max_health, player.crystals, _elapsed_time, player.get_rope_side_name()
	]
	hint_text.text = "↑ / Space：上翻或跳离钢索 · ↓：下翻/松绳 · Shift：影步 · R / Enter：重来"
	_update_threat_hint()

func _update_threat_hint() -> void:
	var nearest: Hazard
	var nearest_distance := INF
	for hazard in _hazards:
		if not is_instance_valid(hazard):
			continue
		var distance := hazard.global_position.x - player.global_position.x
		if distance >= -48.0 and distance < nearest_distance:
			nearest = hazard
			nearest_distance = distance
	if nearest == null:
		threat_text.text = "前方：安全段"
		threat_text.modulate = Color("91a1ad")
		return
	var seconds := maxf(nearest_distance, 0.0) / maxf(player.tuning.run_speed, 1.0)
	var side_text := "上侧" if nearest.cable_side == "top" else "下侧"
	threat_text.text = "前方预警  %s机关 · %.1fs" % [side_text, seconds]
	threat_text.modulate = Color("f08b68") if seconds <= 0.8 else Color("f0c36d")

func _draw() -> void:
	# Temporary code-drawn art keeps the control slice independent from final imagegen assets.
	draw_rect(Rect2(-500.0, -400.0, 10000.0, 1100.0), Color("111827"))
	draw_circle(Vector2(1800.0, 150.0), 78.0, Color("dde7e7"))
	draw_circle(Vector2(1770.0, 130.0), 78.0, Color("111827"))
	for index in range(10):
		var x := float(index * 1000 - 200)
		var hill_height := float(150 + (index % 3) * 55)
		draw_colored_polygon(PackedVector2Array([
			Vector2(x, 680.0), Vector2(x + 260.0, 680.0 - hill_height),
			Vector2(x + 560.0, 680.0)
		]), Color("233142"))
	# The cable is the central play surface: obstacles are drawn from it upward or downward.
	draw_line(Vector2(-100.0, ROPE_Y), Vector2(9000.0, ROPE_Y), Color("d8b56a"), 6.0)
	draw_line(Vector2(-100.0, ROPE_Y + 7.0), Vector2(9000.0, ROPE_Y + 7.0), Color(0.22, 0.29, 0.36, 0.65), 2.0)
	for x in range(0, 9000, 600):
		draw_line(Vector2(x, ROPE_Y - 24.0), Vector2(x, ROPE_Y + 24.0), Color("34495e"), 3.0)
