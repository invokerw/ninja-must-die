extends Control

var profile: PlayerProfile
var character: CharacterData
var selected_weapon: WeaponData
var weapon_buttons: Dictionary = {}
var equip_button: UIActionButton
var preview_title: Label
var preview_body: Label
var preview_stats: Label
var status: Label
var preview: WeaponPreview
var full_button: Button
var feedback_menu: FeedbackSettingsPanel
var history_labels: Dictionary = {}
var save_retry: Button
var wallet: Label
var save_badge: UIStatusChip
var tabs: UITabBar
var pages: Dictionary = {}
var scroll_summary: UIDetailPanel
var supply_summary: UIDetailPanel
var loadout_summary: Label
var _launching := false
var _equipment_save_pending := false

func _ready() -> void:
	PaintedTheme.apply_font(self)
	if profile == null:
		profile = PlayerProfile.current()
	character = profile.resolve().character
	_build_shell()
	_build_character()
	_build_loadout()
	_build_history()
	feedback_menu = FeedbackSettingsPanel.new()
	feedback_menu.profile = profile
	feedback_menu.hide()
	add_child(feedback_menu)
	profile.save_status_changed.connect(_refresh_profile)
	_select_weapon(profile.get_equipped_weapon(character))
	_refresh_profile()
	get_viewport().size_changed.connect(_layout_ui)
	_layout_ui()

func _build_shell() -> void:
	var backdrop := CanvasLayer.new()
	backdrop.layer = -10
	add_child(backdrop)
	backdrop.add_child(PaintedBackdrop.new())
	var veil := ColorRect.new()
	veil.color = Color(UITokens.INK, 0.5)
	veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	backdrop.add_child(veil)
	veil.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_label(self, "行前准备", Rect2(48, 28, 460, 50), 34, UITokens.ACCENT_LIGHT)
	wallet = _label(self, "", Rect2(650, 38, 390, 34), 20, UITokens.ACCENT_LIGHT)
	wallet.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	loadout_summary = _label(self, "", Rect2(48, 88, 560, 28), 18, UITokens.TEXT_SECONDARY)
	save_badge = UIStatusChip.new()
	save_badge.position = Vector2(866, 82)
	save_badge.size = Vector2(174, 32)
	add_child(save_badge)
	save_retry = _button(self, "重试保存", Rect2(684, 80, 160, 48), profile.save_profile)
	_button(self, "设置 F2", Rect2(1088, 28, 144, 56), _toggle_settings)
	status = _label(self, "", Rect2(48, 576, 1184, 28), 17, UITokens.ACCENT_LIGHT)
	status.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_button(self, "山路行商", Rect2(48, 624, 160, 56), _open_shop)
	_button(self, "历史纪录", Rect2(224, 624, 160, 56), _show_records)
	_button(self, "跑酷练习", Rect2(552, 624, 176, 56), _launch.bind("res://scenes/practice.tscn"))
	_button(self, "首领练习", Rect2(744, 624, 176, 56), _launch.bind("res://scenes/boss_practice.tscn"))
	full_button = _button(self, "关卡选择", Rect2(944, 624, 288, 56), _open_level_select, "primary")

func _build_character() -> void:
	var panel := _detail(self, Rect2(48, 144, 336, 416), "当前角色", "")
	var card := UISelectCard.new()
	card.configure(character.character_id, character.display_name, "主武器槽 × 1", PaintedTheme.PORTRAIT)
	card.set_state(false, &"equipped", "已出战")
	card.focus_mode = Control.FOCUS_NONE
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.content.add_child(card)
	var mobility := character.get_mobility_data()
	_label_in_column(panel.content, "身法 · %s" % mobility.display_name, 20, UITokens.ACCENT_LIGHT)
	_label_in_column(panel.content, mobility.description, 18)
	var active := character.active_skill
	_label_in_column(panel.content, "忍术 · %s" % active.display_name, 20, UITokens.ACCENT_LIGHT)
	_label_in_column(panel.content, "冷却 %.0f 秒 · 保护 %.0f 秒" % [active.cooldown_seconds, active.invulnerability_seconds], 18)

func _build_loadout() -> void:
	tabs = UITabBar.new()
	tabs.position = Vector2(408, 132)
	tabs.size = Vector2(824, 52)
	tabs.set_entries([
		{"id": &"weapons", "title": "武器"}, {"id": &"scrolls", "title": "秘卷"},
		{"id": &"supplies", "title": "补给"}, {"id": &"records", "title": "纪录"},
	], &"weapons")
	tabs.selection_changed.connect(_select_tab)
	add_child(tabs)
	for id in [&"weapons", &"scrolls", &"supplies", &"records"]:
		var page := Control.new()
		page.position = Vector2(408, 200)
		page.size = Vector2(824, 360)
		page.visible = id == &"weapons"
		add_child(page)
		pages[id] = page
	var page: Control = pages[&"weapons"]
	var weapons := profile.list_weapons(character)
	for index in range(weapons.size()):
		var weapon := weapons[index]
		var card := UISelectCard.new()
		card.configure(weapon.weapon_id, weapon.display_name, "技能冷却 %.0f 秒" % weapon.skill.cooldown_seconds, WeaponArt.texture_for(weapon.weapon_id))
		card.position = Vector2(index * 424, 0)
		card.size = Vector2(400, 140)
		card.pressed.connect(_select_weapon.bind(weapon))
		page.add_child(card)
		weapon_buttons[weapon.weapon_id] = card
	var detail := _detail(page, Rect2(0, 148, 560, 212), "", "")
	preview_title = detail.title_label
	preview_body = detail.body_label
	preview_stats = _label_in_column(detail.content, "", 18, UITokens.TEXT_SECONDARY)
	preview = WeaponPreview.new()
	preview.position = Vector2(584, 148)
	preview.size = Vector2(240, 92)
	preview.mouse_filter = Control.MOUSE_FILTER_IGNORE
	page.add_child(preview)
	equip_button = _button(page, "装备", Rect2(584, 256, 240, 56), _equip_selected)
	_label(page, "预览不改变出战装备", Rect2(584, 320, 240, 32), 16, UITokens.TEXT_SECONDARY)
	scroll_summary = _detail(pages[&"scrolls"], Rect2(0, 0, 824, 360), "秘卷", "")
	_button(scroll_summary.footer, "前往行商调整", Rect2(0, 0, 216, 52), _open_shop)
	supply_summary = _detail(pages[&"supplies"], Rect2(0, 0, 824, 360), "下次正式出战", "")
	_button(supply_summary.footer, "前往行商调整", Rect2(0, 0, 216, 52), _open_shop)

func _build_history() -> void:
	var detail := _detail(pages[&"records"], Rect2(0, 0, 824, 360), "雾岭断桥 · 模式纪录", "三个模式独立记录；正式关卡的完整纪录可在关卡选择查看。")
	for entry in [[&"full", "正式挑战"], [&"boss_practice", "首领练习"], [&"parkour_practice", "跑酷练习"]]:
		_label_in_column(detail.content, entry[1], 20, UITokens.ACCENT_LIGHT)
		history_labels[entry[0]] = _label_in_column(detail.content, "", 18)

func _select_tab(id: StringName) -> void:
	for key: StringName in pages:
		pages[key].visible = key == id

func _show_records() -> void:
	tabs.select(&"records")

func _refresh_carry() -> void:
	var economy := profile.economy_state()
	var scroll_id := StringName(economy.selected_scroll_id)
	var item_id := StringName(economy.selected_item_id)
	var scroll_name: String = EconomyService.ITEMS.get(scroll_id, {}).get("name", "未装备")
	var item_name: String = EconomyService.ITEMS.get(item_id, {}).get("name", "不携带补给")
	loadout_summary.text = "秘卷：%s · 补给：%s" % [scroll_name, item_name]
	scroll_summary.set_description("当前秘卷 · %s" % scroll_name, "已解锁 %d 本秘卷 · 同时装备一本\n\n购买、装备与卸下可在山路行商中调整。\n局内与暂停时配置固定。" % economy.scroll_ids.size())
	supply_summary.set_description("下次正式出战 · %s" % item_name, ("所选库存 %d 件\n\n" % profile.get_inventory(item_id) if not item_id.is_empty() else "本次未选择补给。\n\n") + "正式局开局时消耗一件；免费练习不耗库存。\n重试默认不续带，携带选择请在山路行商调整。")
	status.tooltip_text = "秘卷：%s\n补给：%s" % [scroll_name, item_name]

func _open_shop() -> void:
	if _launching or feedback_menu.visible:
		return
	_launching = true
	if RunNavigation.open_shop(get_tree()) != OK:
		_launching = false
		status.text = "暂时无法打开商店，请重试。"

func _layout_ui() -> void:
	ScreenLayout.configure_window(get_viewport(), TouchControls.is_requested())
	ScreenLayout.fit_control(self, ScreenLayout.safe_rect(get_viewport()))

func _select_weapon(weapon: WeaponData) -> void:
	selected_weapon = weapon
	preview.weapon = weapon
	preview_title.text = weapon.display_name
	preview_title.show()
	preview_body.text = weapon.description
	preview_body.show()
	var skill := weapon.skill
	preview_stats.text = "冷却 %.0f 秒 · %d 枚 × %d 伤害 = %d\n首领战基础伤害 · 无无敌 · %s" % [skill.cooldown_seconds, skill.projectile_count, skill.boss_damage, skill.projectile_count * skill.boss_damage, "即时连续发射" if skill.cast_delay_seconds == 0.0 else "蓄势 %.2f 秒后发射" % skill.cast_delay_seconds]
	_refresh_equipment()

func _refresh_equipment() -> void:
	var equipped := profile.get_equipped_weapon(character)
	for id: StringName in weapon_buttons:
		var selected := id == selected_weapon.weapon_id
		weapon_buttons[id].set_state(selected, &"equipped" if id == equipped.weapon_id else (&"preview" if selected else &"owned"))
	var same := selected_weapon.weapon_id == equipped.weapon_id
	var equipment_pending := profile.save_pending and _equipment_save_pending
	equip_button.disabled = profile.is_read_only() or (same and not equipment_pending)
	equip_button.text = "当前只读" if profile.is_read_only() else (("重试保存" if equipment_pending else "已装备") if same else "装备此武器")
	status.text = "当前出战：%s · %s。装备在本局内固定，可返回此页更换。" % [character.display_name, equipped.display_name]
	if profile.save_pending and not profile.last_error.is_empty():
		status.text = profile.last_error
	elif not profile.load_notice.is_empty():
		status.text = profile.load_notice

func _refresh_profile() -> void:
	wallet.text = "铜钱 %d%s" % [profile.coins, " · 待保存" if not profile.pending_transaction.is_empty() else ""]
	save_badge.visible = profile.save_pending or profile.is_read_only()
	save_badge.set_status(&"readonly" if profile.is_read_only() else &"pending")
	if not profile.save_pending:
		_equipment_save_pending = false
	_refresh_equipment()
	_refresh_carry()
	save_retry.visible = profile.save_pending and not profile.is_read_only()
	for mode in history_labels:
		var record := profile.history.get_record(LevelCatalog.FOG_RIDGE_ID, mode)
		var label := history_labels[mode] as Label
		if record.is_empty():
			label.text = "尚无通关纪录\n完成此模式后自动保存"
		elif mode == &"boss_practice":
			label.text = "历史最快 %.2f 秒 · 已完成 %d 次\n独立练习，不计整关评级" % [record.best_time, record.completions]
		elif record.has("best_stars"):
			label.text = "最高 %d 星 · %s\n最高分 %d · 最佳收集 %d / %d\n最快 %.2f 秒 · 已完成 %d 次" % [record.best_stars, "已获无伤印" if record.flawless else "尚无无伤印", record.best_score, record.best_collected, record.collectible_total, record.best_time, record.completions]
		else:
			label.text = "%s %s · 最快 %.2f 秒\n最高分 %d · 最佳收集 %d / %d\n%s" % ["旧版评级" if mode == &"full" else "最佳评级", record.best_rank, record.best_time, record.best_score, record.best_collected, record.collectible_total, "星级待重新挑战" if mode == &"full" else "练习不记录主线星级"]

func _toggle_settings() -> void:
	feedback_menu.visible = not feedback_menu.visible

func _unhandled_key_input(event: InputEvent) -> void:
	if not event is InputEventKey or not event.pressed or event.echo:
		return
	if event.physical_keycode == KEY_ESCAPE and feedback_menu.visible:
		feedback_menu.hide()
		get_viewport().set_input_as_handled()
	elif event.physical_keycode == KEY_F2:
		_toggle_settings()
	elif event.physical_keycode == KEY_F3:
		TouchControls.preview_enabled = not TouchControls.preview_enabled
		_layout_ui()
	elif event.physical_keycode == KEY_M:
		feedback_menu.set_setting(not FeedbackSettings.sound_enabled, "sound")

func _equip_selected() -> void:
	if profile.is_read_only() or feedback_menu.visible:
		return
	if not profile.try_equip(character, selected_weapon.weapon_id):
		status.text = profile.last_error
		return
	var saved := profile.save_profile()
	_equipment_save_pending = not saved
	_refresh_equipment()
	if not saved:
		status.text = profile.last_error

func _launch(path: String) -> void:
	if _launching or feedback_menu.visible:
		return
	_launching = true
	if RunNavigation.launch(get_tree(), path, profile.resolve(character)) != OK:
		_launching = false
		status.text = "暂时无法进入关卡，请重试。"

func _open_level_select() -> void:
	if _launching or feedback_menu.visible:
		return
	_launching = true
	if RunNavigation.open_level_select(get_tree(), profile.resolve(character)) != OK:
		_launching = false
		status.text = "暂时无法打开关卡选择，请重试。"

func _detail(parent: Node, rect: Rect2, title: String, body: String) -> UIDetailPanel:
	var panel := UIDetailPanel.new()
	panel.position = rect.position
	panel.size = rect.size
	panel.set_description(title, body)
	parent.add_child(panel)
	return panel

func _label(parent: Node, text: String, rect: Rect2, font_size: int, color: Color = UITokens.TEXT_PRIMARY) -> Label:
	var label := Label.new()
	label.text = text
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label

func _label_in_column(parent: Node, text: String, font_size: int, color: Color = UITokens.TEXT_PRIMARY) -> Label:
	var label := _label(parent, text, Rect2(), font_size, color)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return label

func _button(parent: Node, text: String, rect: Rect2, callback: Callable, variant: String = "secondary") -> UIActionButton:
	var button := UIActionButton.new()
	button.variant = variant
	button.text = text
	button.position = rect.position
	button.size = rect.size
	button.custom_minimum_size = rect.size.max(UITokens.TOUCH_MIN)
	button.add_theme_font_size_override("font_size", 20)
	button.pressed.connect(callback)
	parent.add_child(button)
	return button
