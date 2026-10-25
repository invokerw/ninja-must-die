extends SceneTree

const LEVEL_SCENE := preload("res://scenes/practice.tscn")

var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var level := LEVEL_SCENE.instantiate()
	root.add_child(level)
	var player := level.get_node("Player") as PlayerController
	var world := level.get_node("Level") as RopeLevelController
	# Isolate pickup reachability: an intentionally wrong-side pass may touch a sentry.
	# Full-route tests separately verify safe paths with the authored enemies present.
	for enemy in world.enemies:
		enemy.free()
	world.enemies.clear()
	for shooter in world.shooters:
		shooter.free()
	world.shooters.clear()
	var pickups: Array[CrystalPickup] = []
	for child in world.get_children():
		if child is CrystalPickup:
			pickups.append(child)
	_check(not pickups.is_empty(), "The actual level must contain crystals")
	var tested_top := 0
	var tested_bottom := 0
	for pickup in pickups:
		var target_position := pickup.global_position
		var side := PlayerController.ROPE_TOP if target_position.y < player.rope_y else PlayerController.ROPE_BOTTOM
		var before := player.crystals
		# Pass on the opposite side first to check that collection requires the right route.
		await _set_side(player, -side)
		player.global_position.x = target_position.x - 50.0
		await _frames(20)
		_check(player.crystals == before and is_instance_valid(pickup), "Opposite side must not collect crystal at x=%.0f" % target_position.x)
		# Flip using the actual input and run through the crystal without jumping or releasing.
		await _set_side(player, side)
		player.global_position.x = target_position.x - 50.0
		await _frames(20)
		_check(player.active and player.on_rope and player.rope_side == side, "Collecting must keep the player attached at x=%.0f" % target_position.x)
		_check(player.crystals == before + 1 and not is_instance_valid(pickup), "Attached player must collect crystal at x=%.0f" % target_position.x)
		if side == PlayerController.ROPE_TOP:
			tested_top += 1
		else:
			tested_bottom += 1
	_check(tested_top > 0 and tested_bottom > 0, "Test must cover crystals on both sides")
	_check(player.damage_count == 0, "Both passes must avoid overlapping hazards")
	level.free()
	if _failures == 0:
		print("ROPE_PICKUPS_PASS (%d top, %d bottom; correct and opposite sides)" % [tested_top, tested_bottom])
	quit(0 if _failures == 0 else 1)

func _set_side(player: PlayerController, side: int) -> void:
	if player.rope_side == side:
		return
	var action := &"drop" if side == PlayerController.ROPE_BOTTOM else &"jump"
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
