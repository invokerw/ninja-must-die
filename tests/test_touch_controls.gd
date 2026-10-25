extends SceneTree

const PRACTICE := preload("res://scenes/practice.tscn")
const BOSS_PRACTICE := preload("res://scenes/boss_practice.tscn")
const SETUP := preload("res://scenes/ui/character_setup.tscn")
var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var scope := TestProfileScope.new("touch")
	TouchControls.preview_enabled = true
	await _test_movement_and_ownership()
	await _test_cooldown_and_short_tap()
	await _test_boss_combinations()
	await _test_boss_touch_replay()
	await _test_pause_focus_and_stop()
	await _test_layout()
	await _test_menu_flow()
	TouchControls.preview_enabled = false
	scope.close()
	if _failures == 0:
		print("TOUCH_PASS (real touch events, multiple fingers, ownership, short taps/holds, cooldowns, J/K/flips, keyboard coexistence, pause/focus/death/retry, safe layouts, touch-only menus)")
	quit(0 if _failures == 0 else 1)

func _spawn(boss: bool = false, parent: Node = null) -> Node2D:
	var main: Node2D = (BOSS_PRACTICE if boss else PRACTICE).instantiate()
	(parent if parent != null else root).add_child(main)
	await _frames(12 if boss else 3)
	return main

func _test_movement_and_ownership() -> void:
	var main := await _spawn()
	var controls := main.touch_controls as TouchControls
	_touch(0, controls.get_action_rect(&"drop").get_center(), true)
	_touch(1, controls.get_action_rect(&"skill").get_center(), true)
	await _frames(3)
	_check(main.player.rope_side == PlayerController.ROPE_BOTTOM and main.combat.skill_casts == 1, "Two fingers must flip and cast K together through the real gameplay tick")
	_check(controls.get_button_text(&"jump") == "上翻" and controls.get_button_text(&"drop") == "保持下侧", "Touch movement labels must follow the real rope state")
	_touch(2, controls.get_action_rect(&"drop").get_center(), true)
	_touch(0, Vector2.ZERO, false)
	await _frames(2)
	_check(main.player.run_input.is_action_pressed(&"drop"), "Releasing one of two fingers on a button must leave the other finger held")
	_touch(2, Vector2.ZERO, false)
	_check(not main.player.run_input.is_action_pressed(&"drop") and main.player.run_input.is_action_pressed(&"skill"), "The last finger must release only its own action")
	Input.action_press("drop")
	_touch(3, controls.get_action_rect(&"drop").get_center(), true)
	_touch(3, Vector2.ZERO, false)
	_check(Input.is_action_pressed("drop") and main.player.run_input.is_action_pressed(&"drop"), "Releasing touch must preserve a held keyboard action")
	_touch(4, controls.get_action_rect(&"drop").get_center(), true)
	Input.action_release("drop")
	_check(main.player.run_input.is_action_pressed(&"drop"), "Releasing keyboard must preserve a held touch action")
	var drag := InputEventScreenDrag.new()
	drag.index = 4
	drag.position = root.get_screen_transform() * Vector2(640, 400)
	Input.parse_input_event(drag)
	Input.flush_buffered_events()
	_check(not main.player.run_input.is_action_pressed(&"drop"), "Dragging outside a button must cancel that finger without pressing another action")
	_touch(4, Vector2.ZERO, false)
	_touch(1, Vector2.ZERO, false, true)
	_check(not main.player.run_input.is_action_pressed(&"skill"), "An OS-cancelled touch must release its action")
	await _frames(10)
	_touch(5, controls.get_action_rect(&"jump").get_center(), true)
	await _frames(2)
	_check(main.player.rope_side == PlayerController.ROPE_TOP and main.player.on_rope, "The upper button must flip back from below without consuming a jump")
	_touch(5, Vector2.ZERO, false)
	await _frames(8)
	_touch(6, controls.get_action_rect(&"jump").get_center(), true)
	await _frames(3)
	_check(not main.player.on_rope and main.player.velocity.y < 0.0, "The same upper button must jump away when already above the rope")
	_touch(6, Vector2.ZERO, false)
	main.free()

func _test_cooldown_and_short_tap() -> void:
	var main := await _spawn()
	var point: Vector2 = main.touch_controls.get_action_rect(&"skill").get_center()
	_touch(0, point, true)
	_touch(0, point, false)
	await _frames(2)
	_check(main.combat.skill_casts == 1, "A touch press/release between physics ticks must still cast exactly once")
	main.combat.skill_cooldown_remaining = 0.1
	_touch(1, point, true)
	await _frames(20)
	_check(main.combat.skill_casts == 1 and main.combat.is_skill_ready(), "Holding a cooldown-blocked button must not auto-cast when it becomes ready")
	_touch(1, point, false)
	_touch(2, point, true)
	await _frames(8)
	main.combat.skill_cooldown_remaining = 0.05
	await _frames(12)
	_check(main.combat.skill_casts == 2, "Holding an accepted cast through a ready boundary must not repeat it")
	_check(main.touch_controls.get_button_text(&"skill").contains("就绪"), "Touch skill text must reflect the actual cooldown")
	_touch(2, point, false)
	_touch(3, main.touch_controls.get_action_rect(&"dash").get_center(), true)
	await _frames(2)
	_check(main.player.dash_remaining > 0.0 and main.touch_controls.get_button_text(&"dash").contains("s"), "Touch dash must use the normal dash protection and cooldown")
	main.free()

func _test_boss_combinations() -> void:
	var main := await _spawn(true)
	var boss := main.level.boss as RopeBoss
	boss.state = RopeBoss.State.RECOVERY
	boss.remaining = 10.0
	for index in range(3):
		var action: StringName = [&"drop", &"weapon", &"skill"][index]
		_touch(index, main.touch_controls.get_action_rect(action).get_center(), true)
	await _frames(70)
	_check(main.player.rope_side == PlayerController.ROPE_BOTTOM and main.combat.weapon_shots == 3 and main.combat.skill_casts == 1, "Three fingers must combine a rope flip, J and K without losing inputs")
	_check(boss.health == 144 and main.combat.damage_by_source[&"weapon"] == 12 and main.combat.damage_by_source[&"skill"] == 24, "Touch attacks must retain real projectile flight, cooldowns and damage attribution")
	_check(main.touch_controls.get_button_text(&"weapon").contains(main.run_loadout.weapon.display_name), "The touch weapon button must read the current loadout")
	main.free()

func _test_pause_focus_and_stop() -> void:
	var main := await _spawn()
	var controls := main.touch_controls as TouchControls
	_touch(0, controls.get_action_rect(&"drop").get_center(), true)
	await _frames(2)
	_touch(1, controls.get_action_rect(&"pause").get_center(), true)
	var position: Vector2 = main.player.position
	await _frames(10)
	_check(paused and main.player.position == position and not main.player.run_input.is_action_pressed(&"drop"), "Touch pause must freeze gameplay and release held fingers")
	_touch(1, Vector2.ZERO, false)
	_touch(2, controls.get_action_rect(&"pause").get_center(), true)
	_touch(2, Vector2.ZERO, false)
	await _frames(2)
	_check(not paused and not main.player.run_input.is_action_pressed(&"drop"), "Resume must not restore a stale held finger")
	_touch(0, Vector2.ZERO, false)
	_touch(3, controls.get_action_rect(&"jump").get_center(), true)
	main.notification(Node.NOTIFICATION_APPLICATION_FOCUS_OUT)
	_check(paused and not main.player.run_input.is_action_pressed(&"jump"), "Losing focus in touch mode must pause and clear pending inputs")
	main._toggle_pause()
	_touch(4, controls.get_action_rect(&"skill").get_center(), true)
	main.player.take_damage(main.player.health)
	await _frames(2)
	_check(main._finished and not main.player.run_input.is_action_pressed(&"skill") and not controls._can_play(), "Death must clear even a touch queued before the next physics tick")
	paused = false
	main.free()

func _test_boss_touch_replay() -> void:
	var main := await _spawn(true)
	var boss := main.level.boss as RopeBoss
	for tick in range(4200):
		if main._finished:
			break
		var safe := PlayerController.ROPE_BOTTOM if boss.attack == RopeBoss.Attack.UPPER_SWEEP else PlayerController.ROPE_TOP
		if boss.state == RopeBoss.State.WINDUP and main.player.rope_side != safe:
			_short_tap(main.touch_controls, 0, &"drop" if safe == PlayerController.ROPE_BOTTOM else &"jump")
		if boss.is_vulnerable():
			if boss.remaining > 0.9 and main.combat.is_weapon_ready():
				_short_tap(main.touch_controls, 1, &"weapon")
			if boss.remaining > 0.3 and main.combat.is_skill_ready():
				_short_tap(main.touch_controls, 2, &"skill")
		await _frames(1)
	_check(main._finished and boss.enraged and boss.health == 0 and main.player.damage_count == 0, "Touch-only rope flips, J and K must clear the real half-health boss without damage")
	print("TOUCH_BOSS_REPLAY %.2fs, %d hits, %s" % [main._elapsed_time, main.player.damage_count, main.combat.damage_by_source])
	paused = false
	main.free()

func _test_layout() -> void:
	for dimensions in [Vector2i(1280, 720), Vector2i(1600, 720), Vector2i(1920, 864)]:
		var viewport := SubViewport.new()
		viewport.size = dimensions
		viewport.world_2d = World2D.new()
		root.add_child(viewport)
		var main := await _spawn(false, viewport)
		var controls := main.touch_controls as TouchControls
		controls.safe_area_override = Rect2(48, 24, dimensions.x - 96, dimensions.y - 44)
		controls.sync_state()
		var safe := controls.safe_area_override
		for action in TouchControls.ACTIONS:
			var rect := controls.get_action_rect(action)
			_check(safe.encloses(rect) and rect.size.x >= 84.0, "Every touch target must remain inside the safe area at each landscape size")
			for other in TouchControls.ACTIONS:
				if action != other:
					_check(not rect.intersects(controls.get_action_rect(other)), "Touch targets must never overlap")
		var lower_body := viewport.get_canvas_transform() * Vector2(main.player.position.x, main.player.rope_y + main.player.rope_offset + 30.0)
		_check(controls.get_action_rect(&"drop").position.y > lower_body.y, "Touch controls must sit below both rope body positions")
		_touch_for_viewport(viewport, 0, controls.get_action_rect(&"skill").get_center(), true)
		await _frames(2)
		_check(main.combat.skill_casts == 1, "Resized touch hit targets must still match their visual rectangles")
		controls.safe_area_override = Rect2(60, 24, dimensions.x - 120, dimensions.y - 44)
		controls.sync_state()
		_check(not main.player.run_input.is_action_pressed(&"skill"), "A layout change must release fingers bound to the old screen coordinates")
		controls.safe_area_override = Rect2(48, 24, dimensions.x - 96, dimensions.y - 72)
		controls.sync_state()
		_check(controls.safe_area_override.encloses(controls.get_action_rect(&"drop")) and controls.get_action_rect(&"drop").position.y > lower_body.y, "A taller bottom system inset must preserve both the safe area and the lower rope body")
		viewport.free()

func _test_menu_flow() -> void:
	var setup: Control = SETUP.instantiate()
	root.add_child(setup)
	current_scene = setup
	await _frames(2)
	await _tap_button(setup.weapon_buttons[&"star_lance"])
	await _tap_button(setup.equip_button)
	_check(setup.profile.get_equipped_weapon(setup.character).weapon_id == &"star_lance", "Touch must preview and equip a different weapon in preparation")
	await _tap_button(_find_button(setup, "设置 F2"))
	_check(setup.feedback_menu.visible, "Settings must open with a touch")
	var particles := FeedbackSettings.particles_enabled
	await _tap_button(setup.feedback_menu.checks["particles"])
	_check(FeedbackSettings.particles_enabled != particles, "A touch must operate a real settings toggle")
	await _tap_button(_find_button(setup.feedback_menu, "关闭"))
	_check(not setup.feedback_menu.visible, "Settings must close without a keyboard shortcut")
	await _tap_button(_find_button(setup, "首领练习"))
	await _frames(15)
	var main := current_scene as Node2D
	_check(is_instance_valid(main) and main.touch_controls.visible and main.run_loadout.weapon.weapon_id == &"star_lance", "A touch-only launch must enter the selected mode with the selected loadout")
	await _tap_button(_find_button(main, "设置 F2"))
	_check(paused and main.feedback_menu.visible, "In-run touch settings must pause the chase while gameplay controls are blocked")
	await _tap_button(_find_button(main.feedback_menu, "关闭"))
	_check(not paused and not main.feedback_menu.visible, "Closing touch settings must restore the previous running state")
	await _tap_button(_find_button(main, "设置 F2"))
	await _tap_button(_find_button(main, "角色 / 武器 C"))
	_check(paused and main.character_details.visible and not main.feedback_menu.visible, "Touch character details must replace settings and retain a single pause owner")
	await _tap_button(_find_button(main.character_details, "继续 / 关闭 C"))
	_check(not paused and not main.character_details.visible, "Character details must close and resume by touch")
	_touch(0, main.touch_controls.get_action_rect(&"pause").get_center(), true)
	_touch(0, Vector2.ZERO, false)
	await _tap_button(main.resume_button)
	_check(not paused, "The paused result panel must offer a touch resume button")
	_touch(1, main.touch_controls.get_action_rect(&"drop").get_center(), true)
	main._toggle_pause()
	await _tap_button(_find_button(main, "重试 R / Enter"))
	await _frames(15)
	main = current_scene
	_check(main.touch_controls.visible and main.player.rope_side == PlayerController.ROPE_TOP and not main.player.run_input.is_action_pressed(&"drop"), "Touch retry must retain the layout and loadout while clearing all input")
	_check(main.run_loadout.weapon.weapon_id == &"star_lance" and main.combat.weapon.cooldown_remaining == 0.0, "Retry must use the same loadout with fresh cooldowns")
	main._toggle_pause()
	await _tap_button(_find_button(main, "角色与武器"))
	await _frames(3)
	_check(not paused and current_scene is Control and get_nodes_in_group("run_sessions").is_empty(), "Touch return must restore preparation and discard the old run")
	current_scene.free()

func _find_button(node: Node, text: String) -> Button:
	for child in node.find_children("*", "Button", true, false):
		if child.text == text:
			return child as Button
	_check(false, "Missing button: %s" % text)
	return null

func _tap_button(button: BaseButton) -> void:
	if not is_instance_valid(button):
		return
	var point := button.get_global_transform_with_canvas() * (button.size * 0.5)
	_touch(0, point, true)
	await _frames(1)
	_touch(0, point, false)
	await _frames(2)

func _touch(index: int, point: Vector2, pressed: bool, canceled: bool = false) -> void:
	var event := InputEventScreenTouch.new()
	event.index = index
	event.position = root.get_screen_transform() * point
	event.pressed = pressed
	event.canceled = canceled
	Input.parse_input_event(event)
	Input.flush_buffered_events()

func _short_tap(controls: TouchControls, index: int, action: StringName) -> void:
	var point := controls.get_action_rect(action).get_center()
	_touch(index, point, true)
	_touch(index, point, false)

func _touch_for_viewport(viewport: Viewport, index: int, point: Vector2, pressed: bool) -> void:
	var event := InputEventScreenTouch.new()
	event.index = index
	event.position = point
	event.pressed = pressed
	viewport.push_input(event, true)

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
