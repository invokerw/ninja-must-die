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
	if failures == 0:
		print("ECONOMY_PASS (prices/caps, duplicate IDs, JSON reload, malformed/future data, atomic failures, runtime supply/health)")
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

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures += 1
		push_error(message)

func _write(path: String, document: Dictionary) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(document, "\t"))
	file.close()
