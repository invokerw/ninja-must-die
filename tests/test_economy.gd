extends SceneTree

var failures := 0

func _initialize() -> void:
	call_deferred("_run")

func _run() -> void:
	var state := EconomyService.initial_state({})
	_check(EconomyService.valid_state(state), "Default economy state must validate")
	var growth := EconomyService.upgrade_growth(state, 1000, &"weapon_training", "growth-1")
	_check(not growth.is_empty() and growth.coins == 820 and growth.state.growth.weapon_training == 1, "First weapon upgrade charges the configured price")
	_check(EconomyService.upgrade_growth(growth.state, growth.coins, &"weapon_training", "growth-1").is_empty(), "Duplicate transaction IDs must not repeat an upgrade")
	var scroll := EconomyService.purchase(growth.state, growth.coins, &"guard_scroll", "scroll-1")
	_check(not scroll.is_empty() and scroll.coins == 640 and "guard_scroll" in scroll.state.scroll_ids, "Scroll purchase unlocks once and charges wallet")
	_check(EconomyService.purchase(scroll.state, scroll.coins, &"guard_scroll", "scroll-2").is_empty(), "Owned scrolls cannot be purchased twice")
	var item := EconomyService.purchase(scroll.state, scroll.coins, &"guard_charm", "item-1")
	_check(not item.is_empty() and item.state.item_inventory.guard_charm == 1, "Consumable purchase adds one inventory item")
	var consumed := EconomyService.consume_item(item.state, &"guard_charm", "run-1")
	_check(not consumed.is_empty() and consumed.state.item_inventory.guard_charm == 0, "Starting a run consumes one selected item")
	_check(EconomyService.consume_item(consumed.state, &"guard_charm", "run-2").is_empty(), "Empty inventory cannot consume a second item")
	var scope := TestProfileScope.new("economy-migration")
	var profile := scope.profile
	profile.load_profile()
	profile.save_profile()
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
	document.growth = {"weapon_training": 1}
	document.item_inventory = {"guard_charm": 2}
	document.scroll_ids = ["guard_scroll"]
	document.selected_scroll_id = "guard_scroll"
	_write(profile.save_path, document)
	profile.load_profile()
	_check(profile.get_growth_level(&"weapon_training") == 1, "Growth level reloads from v3 saves")
	_check(profile.get_inventory(&"guard_charm") == 2, "Inventory reloads from v3 saves")
	_check(profile.economy_state().selected_scroll_id == "guard_scroll", "Selected scroll reloads from v3 saves")
	scope.close()
	_test_limits_and_validation()
	_test_failure_boundaries()
	_test_backup_recovery()
	await _test_runtime()
	await _test_start_lifecycle()
	await _test_shop_ui()
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-dir="):
			await _capture_shop(argument.trim_prefix("--capture-dir="))
	if failures == 0:
		print("ECONOMY_PASS (prices/caps, duplicate IDs, JSON reload, malformed/future data, atomic failures, runtime supply/health, standalone shop/touch/keyboard/confirmation)")
	quit(0 if failures == 0 else 1)

func _test_limits_and_validation() -> void:
	var state := EconomyService.initial_state({})
	for level in range(3):
		var tx := EconomyService.upgrade_growth(state, 2000, &"weapon_training", "growth-%d" % level)
		_check(not tx.is_empty() and tx.coins == 2000 - EconomyService.GROWTH_COSTS[&"weapon_training"][level], "Every growth tier uses its own configured price")
		state = tx.state
	_check(EconomyService.upgrade_growth(state, 2000, &"weapon_training", "max").is_empty(), "Growth stops at its cap")
	_check(EconomyService.purchase(state, 39, &"guard_charm", "poor").is_empty(), "Insufficient funds cannot grant inventory")
	_check(EconomyService.purchase(state, 2000, &"unknown", "unknown").is_empty(), "Unknown products cannot spend coins")
	for index in range(9):
		state = EconomyService.purchase(state, 2000, &"guard_charm", "item-%d" % index).state
	_check(EconomyService.purchase(state, 2000, &"guard_charm", "overflow").is_empty(), "Inventory stops at nine")
	state = EconomyService.consume_item(state, &"guard_charm", "same-run").state
	_check(EconomyService.consume_item(state, &"guard_charm", "same-run").is_empty() and state.item_inventory.guard_charm == 8, "Repeated run IDs cannot consume another item even with stock remaining")
	_check(EconomyService.valid_state(EconomyService.initial_state(JSON.parse_string(JSON.stringify(state)))), "JSON integer-valued floats must round-trip without backup recovery")
	for bad in [-1, true, 1.5, "1", NAN, INF, 10]:
		var malformed := EconomyService.initial_state({})
		malformed.item_inventory["guard_charm"] = bad
		_check(not EconomyService.valid_state(malformed), "Invalid inventory value rejected: %s" % str(bad))
	for bad in [-1, true, 1.5, "1", NAN, INF, 4]:
		var malformed := EconomyService.initial_state({"growth": {"weapon_training": bad}})
		_check(not EconomyService.valid_state(malformed), "Invalid growth must not be silently clamped: %s" % str(bad))
	for field in ["growth", "item_inventory", "scroll_ids", "economy_ledger", "selected_scroll_id", "selected_item_id"]:
		_check(not EconomyService.valid_state(EconomyService.initial_state({field: null})), "Present malformed field must not migrate to empty: " + field)
	state.growth.future_growth = {"keep": 7}
	state.item_inventory["future_supply"] = 2
	state.economy_ledger.future_receipt = {"keep": true}
	var next := EconomyService.purchase(state, 2000, &"spring_potion", "extensions")
	_check(not next.is_empty() and next.state.growth.future_growth.keep == 7 and next.state.item_inventory.future_supply == 2 and next.state.economy_ledger.future_receipt.keep, "Transactions preserve unknown extension fields")

func _test_failure_boundaries() -> void:
	for stage in ["temporary", "backup", "replace"]:
		var scope := TestProfileScope.new("economy-failure-" + stage)
		var profile := scope.profile
		_check(profile.save_profile(), "Establish initial persisted generation")
		var original := FileAccess.get_file_as_string(profile.save_path)
		ProfileStore.write_guard = func(boundary: String) -> bool: return boundary != stage
		_check(not profile.purchase(&"guard_charm"), "Purchase must report write failure at " + stage)
		var pending := profile.pending_transaction
		_check(profile.coins == 80 and profile.get_inventory(&"guard_charm") == 1 and pending.kind == "economy", "Failed purchase retains the complete wallet/inventory draft")
		_check(not profile.purchase(&"spring_potion") and not profile.select_item(&"guard_charm") and profile.pending_transaction == pending and profile.coins == 80, "Another purchase or selection cannot overwrite a pending transaction")
		_check(FileAccess.get_file_as_string(profile.save_path) == original, "Failed write keeps committed primary intact")
		var reloaded := PlayerProfile.new(profile.save_path)
		reloaded.load_profile()
		_check(reloaded.coins == 120 and reloaded.get_inventory(&"guard_charm") == 0, "Restart after failed purchase sees the entire old generation")
		ProfileStore.write_guard = Callable()
		_check(profile.save_profile(), "Retry persists purchase without charging again")
		reloaded.load_profile()
		_check(reloaded.coins == 80 and reloaded.get_inventory(&"guard_charm") == 1 and reloaded.load_notice.is_empty(), "Purchased inventory survives JSON reload")
		_check(profile.select_item(&"guard_charm"), "Owned supply can be selected")
		ProfileStore.write_guard = func(boundary: String) -> bool: return boundary != stage
		_check(not profile.consume_selected_item("failed-run"), "Failed consumption must not start play")
		pending = profile.pending_transaction
		_check(pending.get("kind") == "consumption" and not profile.can_start_formal_run() and not profile.purchase(&"spring_potion"), "Failed consumption blocks another formal run and purchase")
		reloaded.load_profile()
		_check(reloaded.get_inventory(&"guard_charm") == 1, "Restart before consumption commit retains the saved inventory")
		ProfileStore.write_guard = Callable()
		_check(profile.save_profile() and profile.consume_selected_item("failed-run"), "Retry and duplicate run consumption do not deduct again")
		reloaded.load_profile()
		_check(reloaded.get_inventory(&"guard_charm") == 0 and reloaded.economy_state().selected_item_id.is_empty(), "Consumption clears next-run selection and persists atomically")
		var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
		document.version = ProfileStore.VERSION + 1
		_write(profile.save_path, document)
		profile.load_profile()
		_check(not profile.purchase(&"guard_charm") and not profile.upgrade_growth(&"weapon_training") and not profile.select_scroll(&""), "Future saves refuse all economy mutations")
		scope.close()

func _test_runtime() -> void:
	var scope := TestProfileScope.new("economy-runtime")
	var packed := load("res://scenes/practice.tscn") as PackedScene
	var main := packed.instantiate()
	main.run_loadout = scope.profile.resolve()
	main.run_loadout.growth_snapshot.body_training = 1
	main.run_loadout.item_snapshot.consumed_item_id = "guard_charm"
	root.add_child(main)
	await process_frame
	var player: PlayerController = main.player
	_check(player.health == 4 and player.tuning.max_health == 4 and (load("res://data/control_tuning.tres") as PlayerTuning).max_health == 3, "Body training increases local health without mutating shared tuning")
	_check(not scope.profile.purchase(&"guard_charm"), "Running and paused sessions freeze economy configuration")
	player.immunity_remaining = 0.0
	player.take_damage()
	_check(player.health == 4 and player.damage_count == 1, "Guard charm prevents health loss but counts the hit")
	player.take_damage()
	_check(player.damage_count == 1, "Protected repeat contact does not consume another hit")
	player.immunity_remaining = 0.0
	player.take_damage()
	_check(player.health == 3 and player.damage_count == 2, "Guard charm only works once")
	player.run_loadout.item_snapshot.consumed_item_id = "spring_potion"
	player.health = 2
	player.immunity_remaining = 0.0
	player.take_damage()
	_check(player.health == 2 and player.damage_count == 3, "Potion heals one at one HP without erasing damage count")
	player.immunity_remaining = 0.0
	player.take_damage()
	_check(player.health == 1, "Potion only triggers once")
	player.immunity_remaining = 0.0
	player.take_damage()
	_check(player.health == 0 and not player.active, "Potion cannot resurrect lethal damage")
	main.queue_free()
	await process_frame
	scope.close()

func _test_backup_recovery() -> void:
	var scope := TestProfileScope.new("economy-backup")
	var profile := scope.profile
	_check(profile.purchase(&"guard_charm") and profile.save_profile(), "Save a complete economy generation in both primary and backup")
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(profile.save_path))
	document.item_inventory["guard_charm"] = 1.5
	_check(not ProfileStore.write(profile.save_path, document), "Writer rejects malformed economy data before touching saved generations")
	_write(profile.save_path, document)
	profile.load_profile()
	_check(profile.coins == 80 and profile.get_inventory(&"guard_charm") == 1 and not profile.load_notice.is_empty(), "Malformed inventory restores wallet, stock and ledger from one backup generation")
	_check(profile.select_item(&"guard_charm") and profile.select_item(&""), "Supply selection can be explicitly cleared without consuming stock")
	_check(profile.get_inventory(&"guard_charm") == 1, "Selecting or clearing a supply never consumes it")
	var loadout := profile.resolve()
	loadout.growth_snapshot.weapon_training = 3
	_check(profile.get_growth_level(&"weapon_training") == 0, "Run growth snapshot cannot mutate the profile")
	scope.close()

func _test_start_lifecycle() -> void:
	var scope := TestProfileScope.new("economy-start")
	var profile := scope.profile
	_check(profile.purchase(&"guard_charm") and profile.purchase(&"guard_charm") and profile.select_item(&"guard_charm"), "Prepare two supplies and select one")
	var packed := load("res://scenes/main.tscn") as PackedScene
	var main := packed.instantiate()
	main.run_loadout = profile.resolve()
	root.add_child(main)
	await process_frame
	_check(main.player.active and profile.get_inventory(&"guard_charm") == 1 and main.run_loadout.item_snapshot.get("consumed_item_id") == "guard_charm", "Real formal scene spends one supply before play and captures it")
	var retry_loadout: RunLoadout = main.run_loadout.copy()
	main.queue_free()
	await process_frame
	main = packed.instantiate()
	main.run_loadout = retry_loadout
	root.add_child(main)
	await process_frame
	_check(main.player.active and profile.get_inventory(&"guard_charm") == 1 and not main.run_loadout.item_snapshot.has("consumed_item_id"), "Retry keeps growth/equipment and clears the old supply effect without spending again")
	main.queue_free()
	await process_frame
	_check(profile.select_item(&"guard_charm"), "Select remaining supply for next formal run")
	main = (load("res://scenes/practice.tscn") as PackedScene).instantiate()
	main.run_loadout = profile.resolve()
	root.add_child(main)
	await process_frame
	_check(main.player.active and profile.get_inventory(&"guard_charm") == 1 and not main.run_loadout.item_snapshot.has("consumed_item_id"), "Free practice does not consume or activate the selected formal supply")
	main.queue_free()
	await process_frame
	scope.close()


func _test_shop_ui() -> void:
	paused = false
	var scope := TestProfileScope.new("shop-ui")
	var profile := scope.profile
	_check(profile.save_profile(), "Shop scope establishes starter balance without a formal save")
	var setup := (load("res://scenes/ui/character_setup.tscn") as PackedScene).instantiate()
	root.add_child(setup)
	current_scene = setup
	await _ui_frames(2)
	var entry := _shop_button(setup, "山路行商")
	_check(entry != null, "Preparation exposes the standalone shop entry")
	_check(profile.try_equip(PlayerProfile.CHARACTERS[&"shadow_runner"], &"star_lance") and profile.save_profile(), "Set equipment before visiting the shop")
	await _shop_tap(entry)
	await _ui_frames(3)
	var shop := current_scene as Control
	_check(shop != null and shop.scene_file_path == RunNavigation.SHOP_SCENE, "Shop entry opens an independent formal scene")
	if shop == null or shop.scene_file_path != RunNavigation.SHOP_SCENE:
		if current_scene != null:
			current_scene.free()
		scope.close()
		return
	_check(shop.primary_action.disabled and shop.detail_status.text.contains("雾岭断桥"), "Locked growth shows its concrete prerequisite")
	for button: Button in shop.product_buttons.values():
		for icon in button.get_parent().find_children("*", "TextureRect", true, false):
			_check(button.get_parent().get_global_rect().encloses(icon.get_global_rect()), "Product icons must fit their cards after texture minimum-size calculation")
	profile._reward_state.coins = 2000
	profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60.0, 60.0, 0, 50, 50, 0, 0))
	profile.history.record_completion(LevelCatalog.WIND_BAMBOO_ID, &"full", RunResult.calculate(85.0, 85.0, 0, 50, 50, 0, 0))
	shop._refresh_profile()
	await _shop_tap(shop.primary_action)
	_check(shop.confirmation != null and profile.coins == 2000, "Touching upgrade opens confirmation without spending")
	await _shop_key(KEY_TAB)
	_check(root.gui_get_focus_owner() != null and root.gui_get_focus_owner().text == "取消", "Keyboard focus stays within the purchase confirmation")
	await _shop_key(KEY_ENTER)
	_check(shop.confirmation == null and profile.coins == 2000, "Keyboard accept can cancel without spending")
	await _shop_tap(shop.primary_action)
	await _shop_tap(_shop_button(shop.confirmation, "取消"))
	_check(shop.confirmation == null and profile.coins == 2000, "Cancelling preserves wallet and growth")
	await _shop_tap(shop.primary_action)
	await _shop_tap(shop.confirm_button)
	shop._confirm_purchase()
	_check(profile.coins == 1820 and profile.get_growth_level(&"weapon_training") == 1, "Confirming twice charges exactly once")
	_check(shop.detail_price.text.contains("360") and shop.detail_body.text.contains("+8%") and shop.detail_body.text.contains("+12%"), "Growth refreshes next price, next effect and cap")
	shop._primary_action()
	profile._economy_state.growth.weapon_training = 2
	shop._confirm_purchase()
	_check(profile.coins == 1820 and shop.status.text.contains("状态已更新"), "Stale tier confirmation cannot apply to another tier")
	shop._primary_action()
	profile._reward_state.coins += 1
	shop._confirm_purchase()
	_check(profile.coins == 1821 and profile.get_growth_level(&"weapon_training") == 2, "Changed wallet requires a fresh confirmation of the remaining balance")
	profile._reward_state.coins -= 1
	profile._economy_state.growth.weapon_training = 3
	shop._refresh_profile()
	_check(shop.primary_action.disabled and shop.primary_action.text == "已满级", "Capped growth disables further spending")
	await _shop_tap(shop.tab_buttons[&"scrolls"])
	await _shop_tap(shop.primary_action)
	await _shop_tap(shop.confirm_button)
	_check("light_scroll" in profile.economy_state().scroll_ids and profile.coins == 1640, "Scroll purchase unlocks once without silently equipping")
	await _shop_tap(shop.primary_action)
	_check(profile.economy_state().selected_scroll_id == "light_scroll" and profile.coins == 1640, "Owned scroll equips free of charge")
	await _shop_tap(shop.primary_action)
	_check(profile.economy_state().selected_scroll_id.is_empty(), "Equipped scroll can be removed")
	await _shop_tap(shop.tab_buttons[&"supplies"])
	await _shop_tap(shop.primary_action)
	ProfileStore.write_guard = func(stage: String) -> bool: return stage != "replace"
	await _shop_tap(shop.confirm_button)
	_check(profile.coins == 1600 and profile.get_inventory(&"guard_charm") == 1 and profile.save_pending, "Failed shop save retains one complete transaction draft")
	_check(shop.save_retry.visible and shop.primary_action.disabled and shop.secondary_action.disabled, "Failed transaction exposes retry and freezes further mutations")
	await _shop_tap(shop.primary_action)
	_check(profile.coins == 1600 and profile.get_inventory(&"guard_charm") == 1, "Disabled touch cannot repeat a failed purchase")
	ProfileStore.write_guard = Callable()
	await _shop_tap(shop.save_retry)
	_check(not profile.save_pending and profile.coins == 1600 and profile.get_inventory(&"guard_charm") == 1, "Save retry persists the draft without another charge")
	await _shop_tap(shop.secondary_action)
	_check(profile.economy_state().selected_item_id == "guard_charm" and profile.get_inventory(&"guard_charm") == 1, "Choosing supply does not consume inventory")
	await _shop_tap(shop.secondary_action)
	_check(profile.economy_state().selected_item_id.is_empty(), "Supply can be explicitly cleared")
	profile._economy_state.item_inventory.guard_charm = 9
	shop._refresh_profile()
	_check(shop.primary_action.disabled and shop.primary_action.text == "库存已满", "Full stock cannot be purchased")
	profile._reward_state.coins = 0
	await _shop_tap(shop.product_buttons[&"spring_potion"])
	_check(shop.primary_action.disabled and shop.detail_status.text.contains("还差 30"), "Insufficient funds show the exact shortage")
	await _shop_tap(shop.tab_buttons[&"cosmetics"])
	_check(not shop.detail.visible and shop.product_buttons.is_empty(), "Unavailable cosmetics show an empty state without fake products")
	await _shop_tap(shop.tab_buttons[&"supplies"])
	profile._reward_state.coins = 2000
	shop._select_product(&"spring_potion")
	shop._primary_action()
	var escape := InputEventKey.new()
	escape.keycode = KEY_ESCAPE
	escape.pressed = true
	shop._unhandled_key_input(escape)
	_check(shop.confirmation == null and current_scene == shop, "Escape cancels confirmation before leaving the shop")
	profile._document.version = ProfileStore.VERSION + 1
	shop._refresh_profile()
	_check(shop.primary_action.disabled and shop.status.text.contains("较新"), "Future saves keep shop read-only")
	shop._unhandled_key_input(escape)
	await _ui_frames(4)
	_check(current_scene != null and current_scene.scene_file_path == RunNavigation.SETUP_SCENE, "Escape returns to the preparation page")
	_check(profile.get_equipped_weapon(PlayerProfile.CHARACTERS[&"shadow_runner"]).weapon_id == &"star_lance", "Shop navigation preserves the equipped weapon")
	if current_scene != null:
		current_scene.free()
	scope.close()

func _capture_shop(output: String) -> void:
	if DisplayServer.get_name() == "headless":
		_check(false, "Shop capture needs a graphical renderer")
		return
	_check(DirAccess.make_dir_recursive_absolute(output) == OK, "Shop screenshot directory is writable")
	for spec in [[1280, "initial"], [1280, "growth"], [1280, "scrolls"], [1600, "supplies"], [1600, "safe"], [1280, "confirm"], [1280, "save_failure"]]:
		var scope := TestProfileScope.new("shop-capture")
		var viewport := SubViewport.new()
		viewport.size = Vector2i(spec[0], 720)
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var shop := (load(RunNavigation.SHOP_SCENE) as PackedScene).instantiate()
		shop.profile = scope.profile
		viewport.add_child(shop)
		if spec[1] != "initial":
			scope.profile._reward_state.coins = 720
			scope.profile.history.record_completion(LevelCatalog.FOG_RIDGE_ID, &"full", RunResult.calculate(60.0, 60.0, 0, 50, 50, 0, 0))
			shop._refresh_profile()
		if spec[1] == "scrolls":
			shop._select_tab(&"scrolls")
		if spec[1] in ["supplies", "safe"]:
			scope.profile.purchase(&"guard_charm")
			shop._select_tab(&"supplies")
		if spec[1] in ["confirm", "save_failure"]:
			shop._primary_action()
		if spec[1] == "save_failure":
			ProfileStore.write_guard = func(stage: String) -> bool: return stage != "replace"
			shop._confirm_purchase()
			ProfileStore.write_guard = Callable()
		var safe := Rect2(60, 24, spec[0] - 120, 648) if spec[1] == "safe" else Rect2(Vector2.ZERO, viewport.size)
		ScreenLayout.fit_control(shop, safe)
		await _ui_frames(3)
		await RenderingServer.frame_post_draw
		for button in shop.find_children("*", "Button", true, false):
			if button.is_visible_in_tree():
				_check(safe.encloses(button.get_global_rect()), "Shop hit areas and confirmations fit the design safe frame")
		var target := output.path_join("shop_%s_%s.png" % spec)
		_check(viewport.get_texture().get_image().save_png(target) == OK, "Shop screenshot saves successfully")
		print("SHOP_CAPTURE ", target)
		viewport.free()
		scope.close()

func _shop_button(node: Node, text: String) -> Button:
	for button in node.find_children("*", "Button", true, false):
		if button.text == text:
			return button as Button
	return null

func _shop_tap(button: Button) -> void:
	if button == null:
		_check(false, "Shop touch target must exist")
		return
	var point := button.get_global_transform_with_canvas() * (button.size * 0.5)
	for pressed in [true, false]:
		var event := InputEventScreenTouch.new()
		event.index = 0
		event.position = root.get_screen_transform() * point
		event.pressed = pressed
		Input.parse_input_event(event)
		Input.flush_buffered_events()
		await _ui_frames(2)

func _shop_key(key: Key) -> void:
	for pressed in [true, false]:
		var event := InputEventKey.new()
		event.keycode = key
		event.physical_keycode = key
		event.pressed = pressed
		Input.parse_input_event(event)
		Input.flush_buffered_events()
		await _ui_frames(2)

func _ui_frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures += 1
		push_error(message)

func _write(path: String, document: Dictionary) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(document, "\t"))
	file.close()
