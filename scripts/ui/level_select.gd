extends Control

const BACKGROUND := preload("res://art/generated/ui/level_select/v01/background_final.png")
const ILLUSTRATION := preload("res://art/generated/ui/level_select/v01/loop_04_overview_wide_illustration_panel.png")
const LANTERN := preload("res://art/generated/ui/level_select/v01/loop_02_roi_1_side_lantern.png")

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
var record_character_only := false
var record_tabs: UITabBar
var wallet: Label
var chapter_stars: Label
var save_retry: Button
var save_badge: UIStatusChip
var route: UIJourneyRoute
var snapshot_button: Button
var snapshot_dialog: UIConfirmDialog
var _launching := false
var _record_rows: Array[Label] = []
var _record_view_buttons: Array[Button] = []
var _selected_record: Dictionary = {}

func _enter_tree() -> void:
	run_loadout = RunNavigation.take_pending(scene_file_path)

func _ready() -> void:
	PaintedTheme.apply_font(self)
	if profile == null:
		profile = PlayerProfile.current()
	if run_loadout == null:
		run_loadout = profile.resolve()
	_build_shell()
	_build_levels()
	_build_detail()
	profile.save_status_changed.connect(func() -> void: _select_level(selected_level_id))
	_select_level(selected_level_id)
	get_viewport().size_changed.connect(_layout_ui)
	_layout_ui()

func _build_shell() -> void:
	# Full viewport scenery stays behind the safe, fitted design frame.
	var backdrop := CanvasLayer.new()
	backdrop.layer = -10
	add_child(backdrop)
	var background := TextureRect.new()
	background.texture = BACKGROUND
	background.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	background.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	backdrop.add_child(background)
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var veil := ColorRect.new()
	veil.color = Color(UITokens.INK, 0.25)
	veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	backdrop.add_child(veil)
	veil.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_panel(Rect2(0, 0, 1280, 80))
	_button("返回准备", Rect2(48, 16, 144, 48), _return_to_setup, &"quiet")
	_label("第一章 · 灯火将熄", Rect2(216, 18, 440, 48), 30, UITokens.ACCENT_LIGHT)
	chapter_stars = _label("", Rect2(720, 25, 264, 32), 20)
	wallet = _label("", Rect2(1000, 25, 232, 32), 20, UITokens.ACCENT_LIGHT)
	wallet.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	save_badge = UIStatusChip.new()
	save_badge.position = Vector2(490, 100)
	save_badge.size = Vector2(150, 34)
	add_child(save_badge)
	save_retry = _button("重试保存", Rect2(490, 142, 150, 48), profile.save_profile)
	_panel(Rect2(0, 632, 1280, 88))
	_label("当前出战：%s · %s" % [run_loadout.character.display_name, run_loadout.weapon.display_name], Rect2(48, 640, 480, 32), 20, UITokens.ACCENT_LIGHT)
	status = _label("", Rect2(48, 675, 480, 42), 16)
	status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	start_button = _button("开始挑战", Rect2(552, 648, 240, 56), _start_level.bind(false), &"primary")
	practice_button = _button("进入练习", Rect2(808, 648, 184, 56), _start_level.bind(true))
	var story := _button("重看剧情 · 暂未开放", Rect2(1008, 648, 224, 56), _replay_story, &"quiet")
	story.tooltip_text = "剧情尚未开放"

func _build_levels() -> void:
	var panel := _detail(Rect2(48, 96, 416, 516), "驿灯路线")
	panel.content.add_theme_constant_override("separation", 12)
	for entry: Dictionary in LevelCatalog.list_levels(&"chapter_01"):
		var card := UILevelCard.new()
		card.configure(entry.level_id, entry.title, "", _illustration())
		card.pressed.connect(_select_level.bind(entry.level_id))
		panel.content.add_child(card)
		level_buttons[entry.level_id] = card
	route = UIJourneyRoute.new()
	route.lantern_texture = LANTERN
	route.position = Vector2(488, 96)
	route.size = Vector2(256, 516)
	route.level_selected.connect(_select_level)
	add_child(route)
	var caption := _label("沿山上行 · 点亮驿灯", Rect2(488, 556, 256, 32), 18, UITokens.ACCENT_LIGHT)
	caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER

func _build_detail() -> void:
	var panel := _detail(Rect2(768, 96, 464, 516), "")
	panel.content.add_theme_constant_override("separation", 4)
	detail_title = panel.title_label
	detail_title.show()
	detail_body = panel.body_label
	var image := TextureRect.new()
	image.texture = _illustration()
	image.custom_minimum_size = Vector2(0, 68)
	image.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	image.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	image.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.content.add_child(image)
	panel.content.move_child(image, 0)
	detail_body.show()
	detail_body.add_theme_font_size_override("font_size", 16)
	record_tabs = UITabBar.new()
	record_tabs.custom_minimum_size = Vector2(0, 48)
	record_tabs.set_entries([
		{"id": &"overall", "title": "全角色最高"},
		{"id": &"character", "title": "当前角色"},
	], &"overall")
	record_tabs.selection_changed.connect(func(id: StringName) -> void: _set_record_view(id == &"character"))
	panel.content.add_child(record_tabs)
	_record_view_buttons.append(record_tabs.buttons[&"overall"])
	_record_view_buttons.append(record_tabs.buttons[&"character"])
	detail_record = _column_label(panel.content, 18, UITokens.ACCENT_LIGHT)
	detail_score = _column_label(panel.content, 18)
	for index in range(2):
		_record_rows.append(_column_label(panel.content, 18))
	snapshot_button = UIActionButton.new()
	snapshot_button.text = "查看出战快照"
	snapshot_button.custom_minimum_size = Vector2(0, 48)
	snapshot_button.pressed.connect(_open_snapshot)
	panel.content.add_child(snapshot_button)
	_label("收集与受击决定星级 · 无伤印独立记录", Rect2(768, 610, 464, 24), 16, UITokens.TEXT_SECONDARY)

func _layout_ui() -> void:
	ScreenLayout.configure_window(get_viewport(), TouchControls.is_requested())
	ScreenLayout.fit_control(self, ScreenLayout.safe_rect(get_viewport()))

func _unhandled_key_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		if snapshot_dialog != null:
			_close_snapshot()
		else:
			_return_to_setup()

func _select_level(level_id: StringName) -> void:
	var entry := LevelCatalog.get_level(level_id)
	if entry.is_empty() or snapshot_dialog != null:
		return
	selected_level_id = LevelCatalog.canonicalize(level_id)
	wallet.text = "铜钱 %d" % profile.coins
	save_badge.visible = profile.save_pending or profile.is_read_only()
	save_badge.set_status(&"readonly" if profile.is_read_only() else (&"pending" if profile.save_pending else &"saved"))
	save_retry.visible = profile.save_pending and not profile.is_read_only()
	var completed := _completed_level_ids()
	var unlocked := LevelCatalog.is_unlocked(selected_level_id, completed)
	var total_stars := 0
	var route_entries: Array[Dictionary] = []
	for id: StringName in level_buttons:
		var card := level_buttons[id] as UILevelCard
		var item := LevelCatalog.get_level(id)
		var item_unlocked := LevelCatalog.is_unlocked(id, completed)
		var record := _get_record(id)
		total_stars += int(record.get("best_stars", 0))
		card.set_progress(item_unlocked, id == selected_level_id, record)
		card.tooltip_text = "%s · %s" % [item.title, "已解锁" if item_unlocked else "未解锁"]
		route_entries.append({"level_id": id, "order": item.order, "title": item.title, "unlocked": item_unlocked, "selected": id == selected_level_id, "completed": id in completed})
	route.set_entries(route_entries)
	chapter_stars.text = "章节星数 %d / %d" % [total_stars, level_buttons.size() * 3]
	var blocked := profile.is_read_only() or (not profile.pending_transaction.is_empty() and not profile.last_error.is_empty())
	start_button.disabled = not unlocked or blocked
	practice_button.disabled = not unlocked
	if not unlocked:
		var requirements := PackedStringArray()
		for requirement: StringName in entry.requires:
			requirements.append(LevelCatalog.get_level(requirement).get("title", String(requirement)))
		status.text = "需要先完成：%s" % "、".join(requirements)
	elif profile.is_read_only():
		status.text = "当前存档只读，可进入免费练习。"
	elif blocked:
		status.text = "奖励尚未保存，请重试保存；免费练习可用。"
	else:
		status.text = "练习不改变主线星级，不消耗补给。"
	detail_title.text = entry.title
	detail_body.text = _description(entry)
	_selected_record = profile.history.get_record(selected_level_id, &"full", run_loadout.character.character_id if record_character_only else &"")
	# Overall legacy clears remain visible without fabricating per-character records.
	if _selected_record.is_empty() and not record_character_only:
		_selected_record = _get_record(selected_level_id)
	record_tabs.select(&"character" if record_character_only else &"overall", false)
	var record_lines := _record_text(_selected_record).split("\n")
	detail_record.text = record_lines[0]
	for index in range(_record_rows.size()):
		_record_rows[index].text = record_lines[index + 1]
	detail_score.text = "最高分    尚无纪录" if _selected_record.is_empty() else "最高分    %d" % _selected_record.best_score
	snapshot_button.disabled = _selected_record.is_empty()
	snapshot_button.text = "尚无出战快照" if _selected_record.is_empty() else "查看出战快照"
	detail_score.tooltip_text = _snapshot_text(_selected_record)
	detail_record.tooltip_text = detail_score.tooltip_text

func _open_snapshot() -> void:
	if snapshot_dialog != null or _selected_record.is_empty():
		return
	snapshot_dialog = UIConfirmDialog.new()
	snapshot_dialog.configure("%s · %s" % [detail_title.text, "当前角色纪录" if record_character_only else "全角色纪录"], _snapshot_text(_selected_record), "返回纪录", snapshot_button)
	snapshot_dialog.cancel_button.text = "关闭"
	snapshot_dialog.confirmed.connect(_close_snapshot)
	snapshot_dialog.cancelled.connect(_close_snapshot)
	add_child(snapshot_dialog)

func _close_snapshot() -> void:
	if snapshot_dialog == null:
		return
	var dialog := snapshot_dialog
	snapshot_dialog = null
	dialog.queue_free()

func _set_record_view(character_only: bool) -> void:
	record_character_only = character_only
	_select_level(selected_level_id)

func _snapshot_text(record: Dictionary) -> String:
	if not record.has("best_score_snapshot"):
		return "旧版纪录缺少单局快照，星级待重新挑战。" if not record.is_empty() else "当前视图尚无正式纪录。"
	var snapshot: Dictionary = record.best_score_snapshot
	var fastest: Dictionary = record.fastest_snapshot
	var text := "最高分单局\n%s\n\n最快单局\n%s" % [_snapshot_run_text(snapshot), _snapshot_run_text(fastest)]
	if record.flawless:
		text += "\n\n首次无伤\n%s" % _snapshot_run_text(record.flawless_snapshot)
	if not record.get("legacy_record", {}).is_empty():
		var legacy: Dictionary = record.legacy_record
		text += "\n旧版：%s · %d 分 · 最快 %.2f 秒 · %d 次通关\n旧版成绩未换算为星级。" % [legacy.best_rank, legacy.best_score, legacy.best_time, legacy.completions]
	return text

func _snapshot_run_text(snapshot: Dictionary) -> String:
	var text := "%s · %s\n%d 分 · %d 星 · %d / %d 影晶\n受击 %d 次 · %.2f 秒" % [_character_name(snapshot.character_id), _weapon_name(snapshot.weapon_id), snapshot.score, snapshot.stars, snapshot.collected, snapshot.collectible_total, snapshot.damage_count, snapshot.time_seconds]
	var growth: Dictionary = snapshot.get("growth_snapshot", {})
	text += "\n共修：武器 %d 级 · 体魄 %d 级" % [growth.weapon_training, growth.body_training] if growth.has("weapon_training") and growth.has("body_training") else "\n共修：未记录"
	var items: Dictionary = snapshot.get("item_snapshot", {})
	text += "\n秘卷：%s" % _snapshot_item_name(items, "selected_scroll_id")
	text += "\n补给：%s" % _snapshot_item_name(items, "consumed_item_id")
	text += "\n%s UTC · 星级规则 %d" % [snapshot.completed_at, snapshot.score_rule_version]
	return text

func _snapshot_item_name(items: Dictionary, field: String) -> String:
	if not items.has(field):
		return "未记录"
	var id := StringName(items[field])
	return EconomyService.ITEMS.get(id, {}).get("name", String(id)) if not id.is_empty() else "未携带"

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
	if _launching or snapshot_dialog != null or not LevelCatalog.is_unlocked(selected_level_id, _completed_level_ids()):
		return
	if not practice and not profile.can_start_formal_run():
		_select_level(selected_level_id)
		return
	_launching = true
	var entry := LevelCatalog.get_level(selected_level_id)
	var path: String = entry.practice_scene if practice else entry.formal_scene
	if RunNavigation.launch_level(get_tree(), path, run_loadout, selected_level_id) != OK:
		_launching = false
		status.text = profile.last_error if not profile.last_error.is_empty() else "暂时无法进入关卡，请重试。"

func _return_to_setup() -> void:
	if _launching or snapshot_dialog != null:
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

func _record_text(record: Dictionary) -> String:
	if record.is_empty():
		return "星级    尚无纪录\n用时    尚无纪录\n收集    尚无纪录"
	if record.has("best_stars"):
		var snapshot: Dictionary = record.best_score_snapshot
		return "最高 %d 星 · %s\n最快    %.2f 秒\n最高分局 %d/%d · 受击 %d 次" % [record.best_stars, "无伤印" if record.flawless else "尚无无伤印", record.best_time, snapshot.collected, snapshot.collectible_total, snapshot.damage_count]
	return "旧版 %s · 星级待挑战\n最快    %.2f 秒\n收集    %d / %d" % [record.best_rank, record.best_time, record.best_collected, record.collectible_total]

func _illustration() -> AtlasTexture:
	var texture := AtlasTexture.new()
	texture.atlas = ILLUSTRATION
	texture.region = Rect2(20, 18, ILLUSTRATION.get_width() - 40, ILLUSTRATION.get_height() - 36)
	return texture

func _detail(rect: Rect2, title: String) -> UIDetailPanel:
	var panel := UIDetailPanel.new()
	panel.position = rect.position
	panel.size = rect.size
	panel.set_description(title, "")
	add_child(panel)
	return panel

func _panel(rect: Rect2) -> void:
	var panel := Panel.new()
	panel.position = rect.position
	panel.size = rect.size
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(panel)

func _column_label(parent: Control, font_size: int, color: Color = UITokens.TEXT_PRIMARY) -> Label:
	var label := Label.new()
	label.custom_minimum_size.y = 28
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label

func _label(text: String, rect: Rect2, font_size: int, color: Color = UITokens.TEXT_PRIMARY) -> Label:
	var label := _column_label(self, font_size, color)
	label.text = text
	label.position = rect.position
	label.size = rect.size
	return label

func _button(text: String, rect: Rect2, callback: Callable, variant: StringName = &"secondary") -> Button:
	var button := UIActionButton.new()
	button.variant = variant
	button.text = text
	button.position = rect.position
	button.size = rect.size
	button.custom_minimum_size = rect.size.max(UITokens.TOUCH_MIN)
	button.add_theme_font_size_override("font_size", 20)
	button.pressed.connect(callback)
	add_child(button)
	return button
