extends Control

var profile: PlayerProfile
var run_loadout: RunLoadout
var selected_level_id: StringName = LevelCatalog.FOG_RIDGE_ID
var level_buttons: Dictionary = {}
var detail_title: Label
var detail_body: Label
var detail_record: Label
var detail_score: Label
var status: Label
var start_button: Button
var practice_button: Button
const ART := preload("res://scenes/ui/level_select_art.tscn")

var _launching := false
var art: Control
var _card_titles: Dictionary = {}
var _card_records: Dictionary = {}
var _lock_art: Array[Control] = []
var _record_rows: Array[Label] = []
var record_character_only := false
var _record_view_buttons: Array[Button] = []

func _enter_tree() -> void:
	run_loadout = RunNavigation.take_pending(scene_file_path)

func _ready() -> void:
	PaintedTheme.apply_font(self)
	if profile == null:
		profile = PlayerProfile.current()
	if run_loadout == null:
		run_loadout = profile.resolve()
	art = ART.instantiate()
	add_child(art)
	_label("第一章 · 驿灯路线", Rect2(168, 88, 250, 28), 18, Color("e8d5a4"))
	_label("沿山上行", Rect2(104, 185, 190, 32), 19)
	var back := _button("", Rect2(1184, 16, 80, 64), _return_to_setup)
	back.tooltip_text = "返回角色与武器"
	var entries := LevelCatalog.list_levels(&"chapter_01")
	for index in range(entries.size()):
		var entry: Dictionary = entries[index]
		var top := 230.0 + index * 164.0
		# Opaque Godot captions cover concept ratings; only real records are shown.
		_caption_panel(Rect2(120, top + 105, 325, 39))
		_card_titles[entry.level_id] = _label("", Rect2(130, top + 108, 300, 29), 21)
		_card_records[entry.level_id] = _label("", Rect2(120, top + 146, 330, 25), 16, Color("bdcbd2"))
		var button := _button("", Rect2(114, top, 338, 145), _select_level.bind(entry.level_id))
		button.toggle_mode = true
		level_buttons[entry.level_id] = button
	for node_name in ["loop_02_roi_4_lock_icon", "loop_03_roi_4_lock_backplate"]:
		_lock_art.append(art.get_node(NodePath(node_name)))
	detail_title = _label("", Rect2(550, 345, 272, 42), 22, Color("f3dfb6"))
	detail_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	detail_title.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_caption_panel(Rect2(510, 210, 670, 103), Color(0.04, 0.07, 0.11, 0.72))
	detail_body = _label("", Rect2(526, 218, 640, 90), 19)
	detail_body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	# Each row shares the center of its icon, independent of font line height.
	for center_y in [444, 493, 542]:
		var row := _label("", Rect2(552, center_y - 18, 275, 36), 18, Color("e8e1d0"))
		row.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		_record_rows.append(row)
	detail_record = _record_rows[0]
	var goal_title := _label("挑战目标", Rect2(852, 424, 340, 40), 21, Color("e8d5a4"))
	goal_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	goal_title.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	for index in range(2):
		var view := _button("全角色最高" if index == 0 else "当前角色", Rect2(850 + index * 178, 344, 170, 48), _set_record_view.bind(index == 1))
		view.toggle_mode = true
		_record_view_buttons.append(view)
	var goals := _label("收集与受击决定星级\n无伤印独立记录\n练习不改主线星级", Rect2(852, 460, 340, 80), 17)
	goals.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	goals.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	detail_score = _label("", Rect2(852, 548, 340, 28), 17, Color("bdcbd2"))
	detail_score.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	detail_score.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	status = _label("", Rect2(48, 672, 1180, 32), 18, Color("e8d5a4"))
	start_button = _action_button("开始挑战", Rect2(562, 570, 260, 88), 112, _start_level.bind(false))
	practice_button = _action_button("进入练习", Rect2(826, 570, 190, 88), 88, _start_level.bind(true))
	_action_button("重看剧情", Rect2(1020, 570, 205, 88), 94, _replay_story)
	_select_level(selected_level_id)
	get_viewport().size_changed.connect(_layout_ui)
	_layout_ui()

func _layout_ui() -> void:
	ScreenLayout.configure_window(get_viewport(), TouchControls.is_requested())
	ScreenLayout.fit_control(self, ScreenLayout.safe_rect(get_viewport()))

func _unhandled_key_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		_return_to_setup()

func _select_level(level_id: StringName) -> void:
	var entry := LevelCatalog.get_level(level_id)
	if entry.is_empty():
		return
	selected_level_id = LevelCatalog.canonicalize(level_id)
	var completed := _completed_level_ids()
	var unlocked := LevelCatalog.is_unlocked(selected_level_id, completed)
	for id in level_buttons:
		var button := level_buttons[id] as Button
		var item := LevelCatalog.get_level(id)
		var item_unlocked := LevelCatalog.is_unlocked(id, completed)
		var record := _get_record(id)
		button.tooltip_text = "%s · %s" % [item.title, "已解锁" if item_unlocked else "未解锁"]
		button.set_pressed_no_signal(id == selected_level_id)
		_card_titles[id].text = "%s%s" % [item.title, "" if item_unlocked else " · 未解锁"]
		_card_records[id].text = _record_short_text(record)
	for lock in _lock_art:
		lock.visible = not LevelCatalog.is_unlocked(entries_second_id(), completed)
	if not unlocked:
		for requirement: StringName in entry.requires:
			status.text = "需要先完成：%s" % LevelCatalog.get_level(requirement).get("title", String(requirement))
		start_button.disabled = true
		practice_button.disabled = true
	else:
		status.text = "当前出战：%s · %s" % [run_loadout.character.display_name, run_loadout.weapon.display_name]
		start_button.disabled = false
		practice_button.disabled = false
	for node_name in ["loop_02_roi_5_runner_control_composite", "loop_04_roi_5_runner_footer_plate", "loop_02_roi_6_left_control_composite", "loop_03_roi_6_left_footer_plate"]:
		art.get_node(NodePath(node_name)).modulate = Color.WHITE if unlocked else Color(0.45, 0.48, 0.52)
	detail_title.text = entry.title + ("  · 已解锁" if unlocked else "  · 未解锁")
	detail_body.text = _description(entry)
	var selected_record := profile.history.get_record(selected_level_id, &"full", run_loadout.character.character_id if record_character_only else &"")
	for index in range(_record_view_buttons.size()):
		_record_view_buttons[index].set_pressed_no_signal(record_character_only == (index == 1))
	var record_lines := _record_text(selected_record).split("\n")
	for index in range(_record_rows.size()):
		_record_rows[index].text = record_lines[index]
	detail_score.text = "最高分    尚无纪录" if selected_record.is_empty() else "最高分    %d" % selected_record.best_score
	detail_score.tooltip_text = _snapshot_text(selected_record)
	detail_record.tooltip_text = detail_score.tooltip_text

func _set_record_view(character_only: bool) -> void:
	record_character_only = character_only
	_select_level(selected_level_id)

func _snapshot_text(record: Dictionary) -> String:
	if not record.has("best_score_snapshot"):
		return "旧版纪录缺少单局快照，星级待重新挑战。" if not record.is_empty() else "当前视图尚无正式纪录。"
	var snapshot: Dictionary = record.best_score_snapshot
	var fastest: Dictionary = record.fastest_snapshot
	var text := "最高分单局：%s · %s\n%d / %d 影晶 · 受击 %d 次 · %.2f 秒\n最快单局：%s · %s" % [_character_name(snapshot.character_id), _weapon_name(snapshot.weapon_id), snapshot.collected, snapshot.collectible_total, snapshot.damage_count, snapshot.time_seconds, _character_name(fastest.character_id), _weapon_name(fastest.weapon_id)]
	if record.flawless:
		var stamp: Dictionary = record.flawless_snapshot
		text += "\n首次无伤：%s UTC · %s · %s" % [stamp.completed_at, _character_name(stamp.character_id), _weapon_name(stamp.weapon_id)]
	if not record.get("legacy_record", {}).is_empty():
		var legacy: Dictionary = record.legacy_record
		text += "\n旧版：%s · %d 分 · 最快 %.2f 秒 · %d 次通关\n旧版成绩未换算为星级。" % [legacy.best_rank, legacy.best_score, legacy.best_time, legacy.completions]
	return text

func _character_name(id: String) -> String:
	var character := CharacterRegistry.get_character(StringName(id))
	return character.display_name if character != null else id

func _weapon_name(id: String) -> String:
	var weapon := PlayerProfile.WEAPONS.get(StringName(id)) as WeaponData
	return weapon.display_name if weapon != null else id

func _description(entry: Dictionary) -> String:
	var description: String = entry.get("description", "")
	var data := LevelCatalog.get_data(entry.level_id)
	if data != null and not data.segments.is_empty():
		description += "\n路线：%d 段 · %.0f 秒 · %d 颗影晶" % [data.segments.size(), data.get_nominal_seconds(), entry.collectible_total]
	return description

func _start_level(practice: bool) -> void:
	if _launching or not LevelCatalog.is_unlocked(selected_level_id, _completed_level_ids()):
		return
	_launching = true
	var entry := LevelCatalog.get_level(selected_level_id)
	var path: String = entry.practice_scene if practice else entry.formal_scene
	if RunNavigation.launch_level(get_tree(), path, run_loadout, selected_level_id) != OK:
		_launching = false
		status.text = "暂时无法进入关卡，请重试。"

func _return_to_setup() -> void:
	if _launching:
		return
	_launching = true
	if RunNavigation.return_to_setup(get_tree()) != OK:
		_launching = false
		status.text = "暂时无法返回准备页，请重试。"

func _replay_story() -> void:
	var entry := LevelCatalog.get_level(selected_level_id)
	status.text = "%s的剧情暂未开放。" % entry.title

func _completed_level_ids() -> Array[StringName]:
	var completed: Array[StringName] = []
	for entry: Dictionary in LevelCatalog.list_levels():
		var record := _get_record(entry.level_id)
		if int(record.get("completions", 0)) > 0:
			completed.append(entry.level_id)
	return completed

func _get_record(level_id: StringName) -> Dictionary:
	var canonical := LevelCatalog.canonicalize(level_id)
	var record := profile.history.get_record(canonical, &"full")
	if record.is_empty():
		var entry := LevelCatalog.get_level(canonical)
		var legacy: StringName = entry.get("legacy_level_id", &"")
		if not legacy.is_empty():
			record = profile.history.get_record(legacy, &"full")
	return record

func _record_short_text(record: Dictionary) -> String:
	if record.is_empty():
		return "尚无正式纪录"
	if record.has("best_stars"):
		return "最高 %d 星 · %s" % [record.best_stars, "无伤印" if record.flawless else "尚无无伤印"]
	return "旧版 %s · 星级待挑战" % record.best_rank

func _record_text(record: Dictionary) -> String:
	if record.is_empty():
		return "星级    尚无纪录\n用时    尚无纪录\n收集    尚无纪录"
	if record.has("best_stars"):
		var snapshot: Dictionary = record.best_score_snapshot
		return "最高 %d 星 · %s\n最快    %.2f 秒\n最高分局 %d/%d · 受击 %d 次" % [record.best_stars, "无伤印" if record.flawless else "尚无无伤印", record.best_time, snapshot.collected, snapshot.collectible_total, snapshot.damage_count]
	return "旧版 %s · 星级待挑战\n最快    %.2f 秒\n收集    %d / %d" % [record.best_rank, record.best_time, record.best_collected, record.collectible_total]

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

func entries_second_id() -> StringName:
	var entries := LevelCatalog.list_levels(&"chapter_01")
	return entries[1].level_id if entries.size() > 1 else &""

func _caption_panel(rect: Rect2, color: Color = Color("111c29")) -> void:
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
	button.focus_mode = Control.FOCUS_ALL
	button.add_theme_font_size_override("font_size", 18)
	for state in ["normal", "hover", "pressed", "disabled", "focus"]:
		var style := StyleBoxFlat.new()
		style.bg_color = Color(0, 0, 0, 0.0)
		if state in ["hover", "pressed", "focus"]:
			style.bg_color = Color(0.9, 0.7, 0.3, 0.12)
			style.border_color = Color("d8b56a")
			style.set_border_width_all(2)
		button.add_theme_stylebox_override(state, style)
	button.add_theme_color_override("font_color", Color("fff0d0"))
	button.add_theme_color_override("font_disabled_color", Color("8c9aab"))
	button.pressed.connect(callback)
	add_child(button)
	return button

func _action_button(text: String, rect: Rect2, icon_space: float, callback: Callable) -> Button:
	var button := _button(text, rect, callback)
	button.alignment = HORIZONTAL_ALIGNMENT_CENTER
	for state in ["normal", "hover", "pressed", "disabled", "focus"]:
		var style := button.get_theme_stylebox(state).duplicate() as StyleBoxFlat
		style.content_margin_left = icon_space
		style.content_margin_right = 12
		style.content_margin_top = 0
		style.content_margin_bottom = 0
		button.add_theme_stylebox_override(state, style)
	return button
