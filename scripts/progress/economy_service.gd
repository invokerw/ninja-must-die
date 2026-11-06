class_name EconomyService
extends RefCounted

const GROWTH_COSTS := {&"weapon_training": [180, 360, 600], &"body_training": [420]}
const ITEMS := {
	&"light_scroll": {"kind": "scroll", "price": 180, "name": "拾光卷"},
	&"guard_scroll": {"kind": "scroll", "price": 180, "name": "护行卷"},
	&"guard_charm": {"kind": "item", "price": 40, "name": "护身符", "max": 9},
	&"spring_potion": {"kind": "item", "price": 30, "name": "回春药", "max": 9},
}

# Missing fields in pre-shop v3 saves migrate to empty values. Present fields
# remain unmodified until validated so corrupt values cannot be clamped away.
static func initial_state(document: Dictionary) -> Dictionary:
	var state := {
		"growth": {"weapon_training": 0, "body_training": 0},
		"scroll_ids": [], "selected_scroll_id": "", "selected_item_id": "",
		"item_inventory": {}, "economy_ledger": {},
	}
	for field in state:
		if document.has(field):
			var value: Variant = document[field]
			state[field] = value.duplicate(true) if value is Dictionary or value is Array else value
	return state

static func valid_state(state: Dictionary) -> bool:
	if not state.get("growth") is Dictionary or not state.get("scroll_ids") is Array or not state.get("item_inventory") is Dictionary or not state.get("economy_ledger") is Dictionary:
		return false
	for id in GROWTH_COSTS:
		var level: Variant = state.growth.get(String(id), 0)
		if not LevelProgress.integer(level) or level > GROWTH_COSTS[id].size():
			return false
	var seen := {}
	for id in state.scroll_ids:
		if not id is String or id.is_empty() or seen.has(id):
			return false
		seen[id] = true
	for id in state.item_inventory:
		var count: Variant = state.item_inventory[id]
		if not id is String or id.is_empty() or not LevelProgress.integer(count):
			return false
		if ITEMS.has(StringName(id)) and (ITEMS[StringName(id)].kind != "item" or count > ITEMS[StringName(id)].max):
			return false
	if not state.get("selected_scroll_id") is String or not state.get("selected_item_id") is String:
		return false
	var selected: String = state.selected_scroll_id
	var item: String = state.selected_item_id
	if not selected.is_empty() and selected not in state.scroll_ids:
		return false
	if not item.is_empty() and (not ITEMS.has(StringName(item)) or ITEMS[StringName(item)].kind != "item" or int(state.item_inventory.get(item, 0)) <= 0):
		return false
	for section in ["purchases", "consumptions"]:
		var entries: Variant = state.economy_ledger.get(section, {})
		if not entries is Dictionary:
			return false
		for id in entries:
			if not id is String or id.is_empty():
				return false
			if section == "purchases":
				if not entries[id] is Dictionary or not LevelProgress.integer(entries[id].get("price")):
					return false
			elif not entries[id] is String or entries[id].is_empty():
				return false
	return true

static func purchase(state: Dictionary, coins: int, item_id: StringName, transaction_id: String) -> Dictionary:
	if not valid_state(state) or not ITEMS.has(item_id) or transaction_id.is_empty():
		return {}
	var item: Dictionary = ITEMS[item_id]
	var key := String(item_id)
	var purchases: Dictionary = state.economy_ledger.get("purchases", {})
	if coins < 0 or coins > RewardService.MAX_COINS or purchases.has(transaction_id) or coins < int(item.price):
		return {}
	if item.kind == "scroll" and key in state.scroll_ids:
		return {}
	if item.kind == "item" and int(state.item_inventory.get(key, 0)) >= int(item.max):
		return {}
	var next := state.duplicate(true)
	if item.kind == "scroll":
		next.scroll_ids.append(key)
	else:
		next.item_inventory[key] = int(next.item_inventory.get(key, 0)) + 1
	if not next.economy_ledger.has("purchases"):
		next.economy_ledger.purchases = {}
	next.economy_ledger.purchases[transaction_id] = {"item_id": key, "price": item.price}
	return {"state": next, "coins": coins - int(item.price), "item_id": key}

static func upgrade_growth(state: Dictionary, coins: int, growth_id: StringName, transaction_id: String) -> Dictionary:
	if not valid_state(state) or not GROWTH_COSTS.has(growth_id) or transaction_id.is_empty():
		return {}
	var purchases: Dictionary = state.economy_ledger.get("purchases", {})
	var level := int(state.growth.get(String(growth_id), 0))
	var costs: Array = GROWTH_COSTS[growth_id]
	if coins < 0 or coins > RewardService.MAX_COINS or purchases.has(transaction_id) or level >= costs.size() or coins < int(costs[level]):
		return {}
	var next := state.duplicate(true)
	next.growth[String(growth_id)] = level + 1
	if not next.economy_ledger.has("purchases"):
		next.economy_ledger.purchases = {}
	next.economy_ledger.purchases[transaction_id] = {"growth_id": String(growth_id), "price": costs[level]}
	return {"state": next, "coins": coins - int(costs[level]), "growth_id": String(growth_id), "level": level + 1}

static func consume_item(state: Dictionary, item_id: StringName, run_id: String) -> Dictionary:
	if not valid_state(state) or not ITEMS.has(item_id) or ITEMS[item_id].kind != "item" or run_id.is_empty() or int(state.item_inventory.get(String(item_id), 0)) <= 0:
		return {}
	if state.economy_ledger.get("consumptions", {}).has(run_id):
		return {}
	var next := state.duplicate(true)
	next.item_inventory[String(item_id)] = int(next.item_inventory[String(item_id)]) - 1
	if next.selected_item_id == String(item_id):
		next.selected_item_id = ""
	if not next.economy_ledger.has("consumptions"):
		next.economy_ledger.consumptions = {}
	next.economy_ledger.consumptions[run_id] = String(item_id)
	return {"state": next, "item_id": String(item_id)}
