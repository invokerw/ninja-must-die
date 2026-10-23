extends SceneTree

const PLAYER_SCENE := preload("res://scenes/main.tscn")

var _failures := 0

func _initialize() -> void:
	for action in ["jump", "drop", "dash"]:
		if not InputMap.has_action(action):
			InputMap.add_action(action)
	_run.call_deferred()

func _run() -> void:
	await _test_jump_lands()
	await _test_double_jump_lands()
	await _test_held_jump_lands_once()
	await _test_fast_fall_lands()
	await _test_fast_crossing_lands()
	await _test_ascent_stays_airborne()
	await _test_manual_regrab()
	await _test_flip_and_deliberate_drop()
	if _failures == 0:
		print("ROPE_LANDING_PASS (8 scenarios)")
	quit(0 if _failures == 0 else 1)

func _make_player() -> PlayerController:
	# Use the actual player node and collision shape from the game scene.
	var scene := PLAYER_SCENE.instantiate()
	var player := scene.get_node("Player") as PlayerController
	scene.remove_child(player)
	scene.free()
	root.add_child(player)
	player.active = true
	return player

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _tap(action: StringName) -> void:
	Input.action_press(action)
	await _frames(1)
	Input.action_release(action)
	await _frames(1)

func _wait_for_landing(player: PlayerController) -> void:
	for index in range(180):
		if player.on_rope or not player.active:
			break
		await _frames(1)

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)

func _check_landed(player: PlayerController, context: String) -> void:
	_check(player.active and player.on_rope, context + ": must land without another jump press")
	_check(player.rope_side == PlayerController.ROPE_TOP, context + ": must land above the rope")
	_check(is_equal_approx(player.position.y, player.rope_y - player.rope_offset), context + ": feet must return to the rope")
	_check(is_zero_approx(player.velocity.y), context + ": landing must stop downward velocity")

func _test_jump_lands() -> void:
	var player := _make_player()
	await _tap("jump")
	_check(not player.on_rope and player.velocity.y < 0.0, "Single jump must take off")
	await _wait_for_landing(player)
	_check_landed(player, "Single jump")
	await _frames(12)
	_check(player.on_rope, "Single jump must stay attached after landing")
	player.free()

func _test_double_jump_lands() -> void:
	var player := _make_player()
	await _tap("jump")
	await _frames(12)
	await _tap("jump")
	_check(not player.on_rope and player.velocity.y < 0.0 and player.jumps_remaining == 0, "Double jump must launch once")
	await _wait_for_landing(player)
	_check_landed(player, "Double jump")
	await _tap("jump")
	_check(not player.on_rope and player.velocity.y < 0.0, "Landing must allow another jump")
	player.free()

func _test_held_jump_lands_once() -> void:
	var player := _make_player()
	Input.action_press("jump")
	await _frames(90)
	_check_landed(player, "Held jump")
	Input.action_release("jump")
	await _frames(1)
	player.free()

func _test_fast_fall_lands() -> void:
	var player := _make_player()
	await _tap("jump")
	await _frames(12)
	await _tap("drop")
	await _wait_for_landing(player)
	_check_landed(player, "Fast fall")
	player.free()

func _test_fast_crossing_lands() -> void:
	var player := _make_player()
	player.on_rope = false
	player.position.y = player.rope_y - player.rope_offset - 8.0
	player.velocity.y = 4000.0
	await _frames(2)
	_check_landed(player, "Crossing the rope within one physics tick")
	player.free()

func _test_ascent_stays_airborne() -> void:
	var player := _make_player()
	player.on_rope = false
	player.position.y = player.rope_y - player.rope_offset + 4.0
	player.velocity.y = -400.0
	await _frames(2)
	_check(not player.on_rope and player.velocity.y < 0.0, "Ascending through the rope must not attach")
	player.free()

func _test_manual_regrab() -> void:
	var player := _make_player()
	player.on_rope = false
	player.position.y = player.rope_y + 10.0
	player.velocity.y = 100.0
	await _tap("jump")
	_check_landed(player, "Manual regrab near the rope")
	await _frames(12)
	_check(player.on_rope, "Regrab must consume the buffered jump")
	player.free()

func _test_flip_and_deliberate_drop() -> void:
	var player := _make_player()
	await _tap("drop")
	_check(player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM, "Down must flip underneath the rope")
	await _frames(8)
	await _tap("jump")
	_check_landed(player, "Flip back above the rope")
	await _frames(8)
	await _tap("drop")
	await _frames(8)
	await _tap("drop")
	_check(not player.on_rope and player.velocity.y > 0.0, "Down beneath the rope must deliberately release it")
	await _frames(60)
	_check(not player.on_rope and not player.active, "Deliberate release must not teleport back to the rope")
	player.free()
