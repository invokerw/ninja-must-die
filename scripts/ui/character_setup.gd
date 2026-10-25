extends Control

var profile: PlayerProfile
var character: CharacterData
var selected_weapon: WeaponData
var weapon_buttons: Dictionary = {}
var equip_button: Button
var preview_title: Label
var preview_body: Label
var preview_stats: Label
var status: Label
var preview: WeaponPreview
var full_button: Button
var feedback_menu: FeedbackSettingsPanel
var history_labels: Dictionary = {}
var save_retry: Button
var _launching := false
var _equipment_save_pending := false

func _ready() -> void:
	if profile == null:
		profile = PlayerProfile.current()
	character = load("res://data/characters/shadow_runner.tres") as CharacterData
	_panel(Rect2(0, 0, 1280, 720), Color("111827"))
	_label("角色与武器", Rect2(44, 30, 1100, 48), 34, Color("d8b56a"))
	_label("选择出战装备，踏入雾岭断桥。", Rect2(44, 88, 1100, 30), 20)
	_panel(Rect2(44, 142, 400, 348), Color("192536"))
	_panel(Rect2(470, 142, 766, 348), Color("192536"))
	_label("影刃", Rect2(72, 168, 330, 42), 30, Color("d8b56a"))
	_label("K  月蚀斩\n12 秒冷却 · 释放后保护 2 秒\n\n被动  踏影\n基础二段跳提升为三段跳", Rect2(72, 226, 330, 190), 21)
	_label("主武器槽 × 1\n武器技能独立使用 J", Rect2(72, 414, 330, 65), 20, Color("91a1ad"))
	var weapons := profile.list_weapons(character)
	for index in range(weapons.size()):
		var weapon := weapons[index]
		var button := _button(weapon.display_name, Rect2(496 + index * 364, 164, 350, 58), _select_weapon.bind(weapon))
		weapon_buttons[weapon.weapon_id] = button
	preview_title = _label("", Rect2(496, 246, 710, 40), 28, Color("d8b56a"))
	preview_body = _label("", Rect2(496, 298, 710, 34), 19)
	preview_stats = _label("", Rect2(496, 347, 710, 66), 19)
	preview = WeaponPreview.new()
	preview.position = Vector2(496, 404)
	preview.size = Vector2(430, 80)
	preview.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(preview)
	equip_button = _button("装备", Rect2(1010, 420, 200, 52), _equip_selected)
	status = _label("", Rect2(44, 504, 1192, 32), 18, Color("d8b56a"))
	full_button = _button("完整关卡", Rect2(44, 550, 380, 46), _launch.bind("res://scenes/main.tscn"))
	_button("首领练习", Rect2(450, 550, 380, 46), _launch.bind("res://scenes/boss_practice.tscn"))
	_button("跑酷练习", Rect2(856, 550, 380, 46), _launch.bind("res://scenes/practice.tscn"))
	var modes := [&"full", &"boss_practice", &"parkour_practice"]
	for index in range(modes.size()):
		var left := 44 + index * 406
		_panel(Rect2(left, 602, 380, 106), Color("192536"))
		history_labels[modes[index]] = _label("", Rect2(left + 16, 610, 348, 94), 17)
	save_retry = _button("重试保存", Rect2(914, 42, 150, 42), profile.save_profile)
	_button("设置 F2", Rect2(1086, 42, 150, 42), _toggle_settings)
	feedback_menu = FeedbackSettingsPanel.new()
	feedback_menu.profile = profile
	feedback_menu.position = Vector2(900, 100)
	feedback_menu.hide()
	add_child(feedback_menu)
	profile.save_status_changed.connect(_refresh_profile)
	_select_weapon(profile.get_equipped_weapon(character))
	_refresh_profile()

func _select_weapon(weapon: WeaponData) -> void:
	selected_weapon = weapon
	preview.weapon = weapon
	preview_title.text = weapon.display_name
	preview_body.text = weapon.description
	var skill := weapon.skill
	preview_stats.text = "冷却 %.0f 秒  ·  %d 枚 × %d 伤害 = %d\n首领战基础伤害 · 无无敌 · %s" % [skill.cooldown_seconds, skill.projectile_count, skill.boss_damage, skill.projectile_count * skill.boss_damage, "即时连续发射" if skill.cast_delay_seconds == 0.0 else "蓄势 %.2f 秒后发射" % skill.cast_delay_seconds]
	_refresh_equipment()

func _refresh_equipment() -> void:
	var equipped := profile.get_equipped_weapon(character)
	for id in weapon_buttons:
		var weapon := PlayerProfile.WEAPONS[id] as WeaponData
		weapon_buttons[id].text = weapon.display_name + (" · 已装备" if id == equipped.weapon_id else (" · 预览中" if id == selected_weapon.weapon_id else " · 查看"))
	var same := selected_weapon.weapon_id == equipped.weapon_id
	var equipment_pending := profile.save_pending and _equipment_save_pending
	equip_button.disabled = same and not equipment_pending
	equip_button.text = ("重试保存" if equipment_pending else "已装备") if same else "装备此武器"
	status.text = "当前出战：%s · %s。装备在本局内固定，可返回此页更换。" % [character.display_name, equipped.display_name]
	if profile.save_pending and not profile.last_error.is_empty():
		status.text = profile.last_error
	elif not profile.load_notice.is_empty():
		status.text = profile.load_notice

func _refresh_profile() -> void:
	if not profile.save_pending:
		_equipment_save_pending = false
	_refresh_equipment()
	save_retry.visible = profile.save_pending
	for mode in history_labels:
		var record := profile.history.get_record(&"fog_ridge_60s", mode)
		var label := history_labels[mode] as Label
		if record.is_empty():
			label.text = "尚无通关纪录\n完成此模式后自动保存\n三个模式分别记录"
		elif mode == &"boss_practice":
			label.text = "历史最快  %.2f 秒\n已完成 %d 次\n独立练习，不计整关评级" % [record.best_time, record.completions]
		else:
			label.text = "最佳评级 %s  ·  最快 %.2f 秒\n最高分 %d  ·  最佳收集 %d / %d\n已完成 %d 次 · 各项纪录独立统计" % [record.best_rank, record.best_time, record.best_score, record.best_collected, record.collectible_total, record.completions]

func _toggle_settings() -> void:
	feedback_menu.visible = not feedback_menu.visible

func _unhandled_key_input(event: InputEvent) -> void:
	if not event is InputEventKey or not event.pressed or event.echo:
		return
	if event.physical_keycode == KEY_F2:
		_toggle_settings()
	elif event.physical_keycode == KEY_M:
		feedback_menu.set_setting(not FeedbackSettings.sound_enabled, "sound")

func _equip_selected() -> void:
	if not profile.try_equip(character, selected_weapon.weapon_id):
		status.text = profile.last_error
		return
	var saved := profile.save_profile()
	_equipment_save_pending = not saved
	_refresh_equipment()
	if not saved:
		status.text = profile.last_error

func _launch(path: String) -> void:
	if _launching:
		return
	_launching = true
	if RunNavigation.launch(get_tree(), path, profile.resolve(character)) != OK:
		_launching = false
		status.text = "暂时无法进入关卡，请重试。"

func _label(text: String, rect: Rect2, font_size: int, color: Color = Color("dde7e7")) -> Label:
	var label := Label.new()
	label.text = text
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(label)
	return label

func _panel(rect: Rect2, color: Color) -> void:
	var panel := ColorRect.new()
	panel.position = rect.position
	panel.size = rect.size
	panel.color = color
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(panel)

func _button(text: String, rect: Rect2, callback: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.position = rect.position
	button.size = rect.size
	button.focus_mode = Control.FOCUS_NONE
	button.add_theme_font_size_override("font_size", 22)
	var style := StyleBoxFlat.new()
	style.bg_color = Color("233142")
	style.border_color = Color("d8b56a")
	style.set_border_width_all(1)
	style.set_corner_radius_all(5)
	button.add_theme_stylebox_override("normal", style)
	button.pressed.connect(callback)
	add_child(button)
	return button
