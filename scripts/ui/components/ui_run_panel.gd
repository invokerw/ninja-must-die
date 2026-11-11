class_name UIRunPanel
extends Panel

signal resume_requested
signal retry_requested
signal setup_requested
signal settings_requested
signal rewards_requested
signal save_requested

var title_label: Label
var body_label: Label
var body_scroll: ScrollContainer
var loadout_label: Label
var save_status: Label
var save_badge: UIStatusChip
var resume_button: UIActionButton
var retry_button: UIActionButton
var setup_button: UIActionButton
var settings_button: UIActionButton
var rewards_button: UIActionButton
var save_button: UIActionButton
var stars: UIStarRating
var rating_label: Label
var score_label: Label
var reward_summary: Label
var _rating: Control
var _pause_mode := false
var _previous_focus: Control

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	theme = PaintedTheme.ui_theme()
	add_theme_stylebox_override("panel", PaintedTheme.surface_style(true))
	position = Vector2(220, 76)
	size = Vector2(840, 568)
	mouse_filter = Control.MOUSE_FILTER_STOP
	loadout_label = _label(Rect2(32, 76, 776, 28), 18, UITokens.TEXT_SECONDARY)
	body_scroll = ScrollContainer.new()
	body_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(body_scroll)
	_rating = Control.new()
	_rating.position = Vector2(32, 114)
	_rating.size = Vector2(776, 56)
	_rating.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_rating)
	stars = UIStarRating.new()
	stars.size = Vector2(156, 48)
	_rating.add_child(stars)
	rating_label = _label(Rect2(184, 6, 280, 40), 20, UITokens.ACCENT_LIGHT, _rating)
	score_label = _label(Rect2(484, 0, 292, 48), 32, UITokens.ACCENT_LIGHT, _rating)
	score_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_rating.hide()
	resume_button = _button("继续挑战", Rect2(624, 24, 184, 52), "primary", func() -> void: resume_requested.emit())
	settings_button = _button("设置", Rect2(624, 366, 184, 48), "quiet", func() -> void: settings_requested.emit())
	rewards_button = _button("奖励明细", Rect2(32, 366, 184, 48), "secondary", func() -> void: rewards_requested.emit())
	rewards_button.hide()
	reward_summary = _label(Rect2(232, 366, 376, 48), 18, UITokens.ACCENT_LIGHT)
	reward_summary.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	reward_summary.hide()
	save_badge = UIStatusChip.new()
	save_badge.position = Vector2(32, 432)
	save_badge.size = Vector2(144, 34)
	add_child(save_badge)
	save_status = _label(Rect2(192, 428, 412, 48), 16, UITokens.TEXT_SECONDARY)
	save_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	save_button = _button("重试保存", Rect2(624, 424, 184, 52), "secondary", func() -> void: save_requested.emit())
	retry_button = _button("重试 R / Enter", Rect2(32, 496, 376, 48), "primary", func() -> void: retry_requested.emit())
	setup_button = _button("角色与武器", Rect2(432, 496, 376, 48), "secondary", func() -> void: setup_requested.emit())
	visibility_changed.connect(_sync_focus)
	_layout_body()

func bind_labels(title: Label, body: Label) -> void:
	title_label = title
	body_label = body
	title.position = Vector2(32, 24)
	title.size = Vector2(568, 44)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	title.add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"section_title"])
	title.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	body.reparent(body_scroll)
	body.position = Vector2.ZERO
	body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"body"])
	body.add_theme_color_override("font_color", UITokens.TEXT_PRIMARY)
	body.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_layout_body()

func set_pause_mode(value: bool) -> void:
	_pause_mode = value
	resume_button.visible = value
	retry_button.variant = "secondary" if value else "primary"
	_rating.hide()
	rewards_button.hide()
	reward_summary.hide()
	rewards_button.text = "奖励明细"
	if is_instance_valid(body_label):
		body_label.tooltip_text = ""
	body_scroll.scroll_vertical = 0
	_layout_body()

func set_rating(value: int, flawless: bool, score: int) -> void:
	stars.stars = value
	rating_label.text = "本局无伤印" if flawless else "本局未获无伤印"
	score_label.text = "%d / 3000" % score
	_rating.show()
	_layout_body()

func reset_scroll() -> void:
	body_scroll.scroll_vertical = 0

func _layout_body() -> void:
	var top := 184 if _rating.visible else 114
	body_scroll.position = Vector2(32, top)
	body_scroll.size = Vector2(776, 350 - top)
	if is_instance_valid(body_label):
		body_label.size = Vector2(752, 0)

func _sync_focus() -> void:
	if visible:
		var owner := get_viewport().gui_get_focus_owner()
		if owner == null or not is_ancestor_of(owner):
			_previous_focus = owner
		focus_primary()
	else:
		if is_instance_valid(_previous_focus) and _previous_focus.is_visible_in_tree() and not _previous_focus.is_queued_for_deletion():
			_previous_focus.grab_focus()
		elif is_instance_valid(get_viewport().gui_get_focus_owner()) and is_ancestor_of(get_viewport().gui_get_focus_owner()):
			get_viewport().gui_release_focus()
		_previous_focus = null

func focus_primary() -> void:
	var target := resume_button if _pause_mode else (save_button if save_button.visible else retry_button)
	if target.disabled:
		target = setup_button
	target.grab_focus()

func refresh_action_focus() -> void:
	if not is_visible_in_tree():
		return
	var owner := get_viewport().gui_get_focus_owner()
	if is_instance_valid(owner) and is_ancestor_of(owner) and (not owner.is_visible_in_tree() or (owner is BaseButton and owner.disabled)):
		focus_primary()

func _input(event: InputEvent) -> void:
	if not is_visible_in_tree() or not event is InputEventKey or not event.pressed or event.echo:
		return
	var forward := event.is_action_pressed("ui_focus_next") or event.is_action_pressed("ui_down") or event.is_action_pressed("ui_right")
	var backward := event.is_action_pressed("ui_focus_prev") or event.is_action_pressed("ui_up") or event.is_action_pressed("ui_left")
	if forward or backward:
		var controls: Array[Control] = []
		for button in [resume_button, rewards_button, settings_button, save_button, retry_button, setup_button]:
			if button.is_visible_in_tree() and not button.disabled:
				controls.append(button)
		var index := controls.find(get_viewport().gui_get_focus_owner())
		controls[posmod(index + (-1 if backward else 1), controls.size())].grab_focus()
		get_viewport().set_input_as_handled()

func _button(caption: String, rect: Rect2, variant: String, callback: Callable) -> UIActionButton:
	var button := UIActionButton.new()
	button.text = caption
	button.variant = variant
	button.position = rect.position
	button.size = rect.size
	button.add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"secondary"])
	button.pressed.connect(callback)
	add_child(button)
	return button

func _label(rect: Rect2, font_size: int, tint: Color, parent: Node = self) -> Label:
	var label := Label.new()
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", tint)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(label)
	return label
