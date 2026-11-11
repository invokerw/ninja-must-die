extends Control

# The approved concept stays outside runtime assets; captions and state remain native controls.
const ITEM_ICONS := preload("res://art/generated/ui/shop/v02/item_icons.png")
const ICON_CELLS := {&"weapon_training": 0, &"body_training": 1, &"light_scroll": 2, &"guard_scroll": 3, &"guard_charm": 4, &"spring_potion": 5}
const TABS := [&"growth", &"scrolls", &"supplies", &"cosmetics"]
const TAB_LABELS := ["共修", "秘卷", "补给", "外观"]
const TAB_NOTES := ["全角色共享的有限成长", "装备一本秘卷，改变一条规则", "为下一次正式出战准备", "外观与称号，后续开放"]
const PRODUCTS := {
	&"growth": [&"weapon_training", &"body_training"],
	&"scrolls": [&"light_scroll", &"guard_scroll"],
	&"supplies": [&"guard_charm", &"spring_potion"],
	&"cosmetics": [],
}

var profile: PlayerProfile
var active_tab: StringName = &"growth"
var selected_id: StringName = &"weapon_training"
var tab_buttons: Dictionary = {}
var product_buttons: Dictionary = {}
var _cards: Array[Control] = []
var content: Panel
var detail: Panel
var heading: Label
var subtitle: Label
var detail_icon: TextureRect
var detail_title: Label
var detail_kind: Label
var detail_body: Label
var detail_status: Label
var detail_price: Label
var detail_balance: Label
var primary_action: Button
var secondary_action: Button
var wallet: Label
var save_badge: UIStatusChip
var save_retry: Button
var status: Label
var supply_choice: Label
var confirmation: UIConfirmDialog
var confirm_button: Button
var _quote: Dictionary = {}
var _launching := false

func _ready() -> void:
	PaintedTheme.apply_font(self)
	if profile == null:
		profile = PlayerProfile.current()
	_build_shell()
	profile.save_status_changed.connect(_refresh_profile)
	_select_tab(active_tab)
	get_viewport().size_changed.connect(_layout_ui)
	_layout_ui()

func _build_shell() -> void:
	var backdrop := CanvasLayer.new()
	backdrop.layer = -10
	add_child(backdrop)
	backdrop.add_child(PaintedBackdrop.new())
	var veil := ColorRect.new()
	veil.color = Color(0.025, 0.045, 0.08, 0.24)
	veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	veil.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	backdrop.add_child(veil)
	_button(self, "‹  返回准备", Rect2(48, 32, 160, 52), _return_to_setup)
	_label(self, "山路行商", Rect2(242, 24, 400, 52), 34, Color("f0d39b"))
	_label(self, "行前添一分从容", Rect2(244, 78, 480, 28), 17, Color("b9c8d1"))
	wallet = _label(self, "", Rect2(868, 38, 350, 38), 24, Color("f0d39b"))
	wallet.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	save_badge = UIStatusChip.new()
	save_badge.position = Vector2(1052, 80)
	save_badge.size = Vector2(166, 32)
	add_child(save_badge)
	save_retry = _button(self, "重试保存", Rect2(692, 36, 152, 48), _retry_save)
	var nav := _panel(self, Rect2(32, 168, 160, 432))
	nav.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	for index in range(TABS.size()):
		var tab: StringName = TABS[index]
		var button := _button(nav, TAB_LABELS[index], Rect2(0, index * 80, 160, 60), _select_tab.bind(tab))
		button.toggle_mode = true
		button.add_theme_font_size_override("font_size", 22)
		button.add_theme_stylebox_override("pressed", PaintedTheme.button_style(&"primary", &"normal"))
		button.add_theme_color_override("font_pressed_color", UITokens.INK)
		tab_buttons[tab] = button
	content = _panel(self, Rect2(216, 104, 1016, 512))
	content.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	heading = _label(content, "", Rect2(4, 2, 554, 32), 19, Color("f0d39b"))
	subtitle = _label(content, "", Rect2(4, 36, 554, 26), 15, Color("b9c8d1"))
	detail = _panel(content, Rect2(632, 0, 384, 512), true)
	detail_icon = _icon(detail, selected_id, Rect2(256, 18, 102, 102))
	detail_title = _label(detail, "", Rect2(24, 22, 252, 38), 27, Color("f0d39b"))
	detail_kind = _label(detail, "", Rect2(24, 70, 248, 24), 15, Color("9caeb8"))
	detail_body = _label(detail, "", Rect2(24, 136, 336, 130), 18)
	detail_body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	detail_status = _label(detail, "", Rect2(24, 278, 336, 64), 16, Color("b9c8d1"))
	detail_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	detail_price = _label(detail, "", Rect2(24, 362, 336, 32), 24, Color("f0d39b"))
	detail_balance = _label(detail, "", Rect2(24, 402, 336, 26), 16, Color("b9c8d1"))
	primary_action = _button(detail, "", Rect2(24, 448, 336, 50), _primary_action, true)
	secondary_action = _button(content, "", Rect2(0, 416, 600, 52), _secondary_action)
	var supply := _panel(self, Rect2(48, 642, 1184, 54))
	supply_choice = _label(supply, "", Rect2(20, 12, 1144, 30), 17, Color("b9c8d1"))
	status = _label(self, "", Rect2(48, 604, 1184, 30), 16, Color("f0d39b"))

func _select_tab(tab: StringName) -> void:
	_close_confirmation()
	active_tab = tab if tab in TABS else &"growth"
	var ids: Array = PRODUCTS[active_tab]
	if selected_id not in ids:
		selected_id = ids[0] if not ids.is_empty() else &""
	_refresh_profile()

func _refresh_profile() -> void:
	wallet.text = "铜钱  %d" % profile.coins
	save_badge.visible = profile.save_pending or profile.is_read_only()
	save_badge.set_status(&"readonly" if profile.is_read_only() else &"pending")
	save_retry.visible = profile.save_pending and not profile.is_read_only()
	var blocked := profile.economy_block_reason()
	if not blocked.is_empty():
		status.text = blocked
	elif profile.save_pending and not profile.last_error.is_empty():
		status.text = profile.last_error
	elif not profile.load_notice.is_empty():
		status.text = profile.load_notice
	var index := TABS.find(active_tab)
	heading.text = TAB_LABELS[index]
	subtitle.text = TAB_NOTES[index]
	for tab: StringName in tab_buttons:
		tab_buttons[tab].set_pressed_no_signal(tab == active_tab)
	_render_cards()
	_render_detail()
	var supply := StringName(profile.economy_state().selected_item_id)
	supply_choice.text = "下次正式出战：%s    ·    免费练习不耗库存，重试默认不续带" % ("不携带补给" if supply.is_empty() else EconomyService.ITEMS[supply].name)

func _product(id: StringName) -> Dictionary:
	var data := {"id": id, "price": -1, "action": "", "enabled": false, "note": "", "footer": ""}
	if EconomyService.GROWTH_COSTS.has(id):
		var level := profile.get_growth_level(id)
		var costs: Array = EconomyService.GROWTH_COSTS[id]
		var capped := level >= costs.size()
		data.merge({"kind": "永久成长 · 全角色共享", "level": level, "owned": false})
		data.name = "共修·兵刃" if id == &"weapon_training" else "共修·护体"
		data.summary = "武器与忍术伤害，每级 +4%" if id == &"weapon_training" else "本局最大生命 +1"
		data.body = "当前伤害增幅  +%d%%\n升级后  +%d%%\n累计上限  +12%%" % [level * 4, mini(level + 1, 3) * 4] if id == &"weapon_training" else "当前额外生命  +%d\n升级后  +1\n累计上限  +1" % level
		data.price = -1 if capped else int(costs[level])
		data.note = "已达到成长上限" if capped else profile.growth_unlock_requirement(id)
		data.action = "已满级" if capped else "确认升级"
		data.enabled = not capped and data.note.is_empty() and profile.coins >= int(data.price)
		data.footer = "等级 %d / %d    ·    %s" % [level, costs.size(), "已满级" if capped else (data.note if not String(data.note).is_empty() else "%d 铜钱" % int(data.price))]
	elif EconomyService.ITEMS.has(id):
		var item: Dictionary = EconomyService.ITEMS[id]
		data.name = item.name
		if item.kind == "scroll":
			var state := profile.economy_state()
			var owned: bool = String(id) in state.scroll_ids
			var equipped: bool = state.selected_scroll_id == String(id)
			data.merge({"kind": "秘卷 · 同时装备一本", "owned": owned, "equipped": equipped})
			data.summary = "影晶吸取范围 +15%" if id == &"light_scroll" else "受击保护延长至 1.0 秒"
			data.body = "%s\n\n购买后永久解锁，可免费切换。" % data.summary
			data.price = -1 if owned else int(item.price)
			data.action = "卸下秘卷" if equipped else ("装备秘卷" if owned else "确认购买")
			data.enabled = owned or profile.coins >= int(item.price)
			data.footer = "已装备" if equipped else ("已解锁" if owned else "%d 铜钱" % int(item.price))
		else:
			var count := profile.get_inventory(id)
			var selected: bool = profile.economy_state().selected_item_id == String(id)
			data.merge({"kind": "一次性补给 · 单件购入", "inventory": count, "selected": selected, "owned": false})
			data.summary = "抵挡首次有效伤害，仍计受击" if id == &"guard_charm" else "存活且生命首次降至 1 时恢复 1 点"
			data.body = "挡住本局第一次有效伤害，仍计一次受击。\n不能抵挡坠落，也不恢复无伤印。" if id == &"guard_charm" else "生命首次降至 1 且仍存活时，恢复 1 点生命，仅触发一次。\n不能救活致死伤害或坠落。"
			data.price = int(item.price)
			data.action = "库存已满" if count >= int(item.max) else "确认购买"
			data.enabled = count < int(item.max) and profile.coins >= int(item.price)
			data.footer = "库存 %d / %d    ·    %d 铜钱" % [count, int(item.max), int(item.price)]
			data.note = "已选择，下次正式局开始时消耗 1 件" if selected else "购买后可选择携带；同一局限一件"
	if not data.is_empty() and int(data.price) >= 0 and profile.coins < int(data.price):
		data.note = "%s%s还差 %d 铜钱" % [data.note, "\n" if not String(data.note).is_empty() else "", int(data.price) - profile.coins]
	if not profile.economy_block_reason().is_empty():
		data.enabled = false
	return data

func _render_cards() -> void:
	for card in _cards:
		card.get_parent().remove_child(card)
		card.queue_free()
	_cards.clear()
	product_buttons.clear()
	var ids: Array = PRODUCTS[active_tab]
	for index in range(ids.size()):
		var id: StringName = ids[index]
		var data := _product(id)
		var selected := id == selected_id
		var card := _panel(content, Rect2(0, 76 + index * 160, 600, 144), selected)
		_cards.append(card)
		var button := _button(card, "", Rect2(0, 0, 600, 144), _select_product.bind(id))
		for state in ["normal", "hover", "pressed"]:
			var style := StyleBoxFlat.new()
			style.bg_color = Color(UITokens.ACCENT, 0.06) if state != "normal" else Color.TRANSPARENT
			button.add_theme_stylebox_override(state, style)
		button.tooltip_text = "%s · %s" % [data.name, data.footer]
		product_buttons[id] = button
		_icon(card, id, Rect2(8, 6, 132, 132))
		_label(card, data.name, Rect2(152, 20, 430, 38), 26, Color("f0d39b"))
		_label(card, data.summary, Rect2(152, 68, 430, 26), 17)
		_label(card, data.footer, Rect2(152, 106, 430, 26), 15, Color("9caeb8"))
	if ids.is_empty():
		var empty := _panel(content, Rect2(0, 76, 600, 304))
		_cards.append(empty)
		_label(empty, "外观工坊尚未开张", Rect2(28, 50, 500, 42), 26, Color("f0d39b"))
		_label(empty, "后续章节将带来外观与称号。\n当前版本可先选购共修、秘卷和补给。", Rect2(28, 114, 500, 84), 19)

func _select_product(id: StringName) -> void:
	selected_id = id
	_refresh_profile()
	if product_buttons.has(id):
		product_buttons[id].grab_focus()

func _render_detail() -> void:
	detail.visible = not selected_id.is_empty()
	secondary_action.visible = false
	if selected_id.is_empty():
		return
	var data := _product(selected_id)
	detail_icon.texture = _icon_texture(selected_id)
	detail_title.text = data.name
	detail_kind.text = data.kind
	detail_body.text = data.body
	detail_status.text = data.note
	detail_price.text = "已永久解锁" if int(data.price) < 0 and data.get("owned", false) else ("已达上限" if int(data.price) < 0 else "%d 铜钱" % int(data.price))
	detail_balance.text = "预计剩余  %d 铜钱" % (profile.coins - int(data.price)) if int(data.price) >= 0 and profile.coins >= int(data.price) else "当前余额  %d 铜钱" % profile.coins
	primary_action.text = data.action
	primary_action.disabled = not data.enabled
	if data.has("inventory"):
		secondary_action.visible = true
		secondary_action.text = "取消携带 · 下次不带补给" if data.selected else "携带此补给 · 库存 %d" % data.inventory
		secondary_action.disabled = int(data.inventory) <= 0 or not profile.economy_block_reason().is_empty()

func _primary_action() -> void:
	if confirmation != null or selected_id.is_empty():
		return
	var data := _product(selected_id)
	if not data.enabled:
		return
	if data.get("owned", false):
		var ok := profile.select_scroll(&"" if data.equipped else selected_id)
		status.text = "秘卷配置已保存。" if ok else profile.last_error
		_refresh_profile()
		return
	_quote = {"id": selected_id, "price": data.price, "balance": profile.coins, "level": data.get("level", -1), "inventory": data.get("inventory", -1)}
	confirmation = UIConfirmDialog.new()
	confirmation.name = "PurchaseConfirmation"
	confirmation.configure(
		"确认升级" if data.has("level") else "确认购买",
		"%s\n花费  %d 铜钱\n余额  %d → %d 铜钱" % [data.name, data.price, profile.coins, profile.coins - int(data.price)],
		"确认 · %d 铜钱" % data.price,
		primary_action
	)
	confirmation.confirmed.connect(_confirm_purchase)
	confirmation.cancelled.connect(_close_confirmation)
	confirm_button = confirmation.confirm_button
	add_child(confirmation)

func _confirm_purchase() -> void:
	if confirmation == null or _quote.is_empty():
		return
	var quote := _quote.duplicate()
	_close_confirmation()
	var data := _product(quote.id)
	# A confirmation applies only to the exact wallet, tier/stock and price shown.
	if not data.enabled or profile.coins != quote.balance or data.price != quote.price or data.get("level", -1) != quote.level or data.get("inventory", -1) != quote.inventory:
		status.text = "商品状态已更新，请重新确认。"
		_refresh_profile()
		return
	var ok := profile.upgrade_growth(quote.id) if data.has("level") else profile.purchase(quote.id)
	status.text = "交易已保存。" if ok else profile.last_error
	_refresh_profile()

func _secondary_action() -> void:
	if confirmation != null or selected_id.is_empty():
		return
	var data := _product(selected_id)
	if not data.has("inventory"):
		return
	var ok := profile.select_item(&"" if data.selected else selected_id)
	status.text = "出战补给已保存。" if ok else profile.last_error
	_refresh_profile()

func _close_confirmation() -> void:
	if confirmation != null:
		confirmation.get_parent().remove_child(confirmation)
		confirmation.queue_free()
		confirmation = null
		confirm_button = null
		if primary_action.is_visible_in_tree() and not primary_action.disabled:
			primary_action.grab_focus()
	_quote.clear()

func _retry_save() -> void:
	status.text = "交易已保存。" if profile.save_profile() else profile.last_error
	_refresh_profile()

func _return_to_setup() -> void:
	if _launching:
		return
	_launching = true
	if RunNavigation.return_to_setup(get_tree()) != OK:
		_launching = false
		status.text = "暂时无法返回准备页，请重试。"

func _layout_ui() -> void:
	ScreenLayout.configure_window(get_viewport(), TouchControls.is_requested())
	ScreenLayout.fit_control(self, ScreenLayout.safe_rect(get_viewport()))

func _unhandled_key_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		if confirmation != null:
			_close_confirmation()
		else:
			_return_to_setup()

func _icon_texture(id: StringName) -> AtlasTexture:
	var atlas := AtlasTexture.new()
	atlas.atlas = ITEM_ICONS
	var cell := int(ICON_CELLS.get(id, 0))
	atlas.region = Rect2((cell % 3) * 512, (cell / 3) * 512, 512, 512)
	atlas.filter_clip = true
	return atlas

func _icon(parent: Control, id: StringName, rect: Rect2) -> TextureRect:
	var icon := TextureRect.new()
	icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	icon.texture = _icon_texture(id)
	icon.position = rect.position
	icon.size = rect.size
	icon.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(icon)
	return icon

func _panel(parent: Control, rect: Rect2, accent: bool = false) -> Panel:
	var panel := Panel.new()
	panel.position = rect.position
	panel.size = rect.size
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_theme_stylebox_override("panel", PaintedTheme.surface_style(accent))
	parent.add_child(panel)
	return panel

func _label(parent: Control, text: String, rect: Rect2, font_size: int, color: Color = UITokens.TEXT_PRIMARY) -> Label:
	var label := Label.new()
	label.text = text
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label

func _button(parent: Control, text: String, rect: Rect2, callback: Callable, accent: bool = false) -> Button:
	var button := UIActionButton.new()
	button.variant = "primary" if accent else "secondary"
	button.text = text
	button.position = rect.position
	button.size = rect.size
	button.add_theme_font_size_override("font_size", 18)
	button.pressed.connect(callback)
	parent.add_child(button)
	return button
