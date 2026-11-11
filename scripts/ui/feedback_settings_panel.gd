class_name FeedbackSettingsPanel
extends PanelContainer

var profile: PlayerProfile
var feedback: RunFeedback
var checks: Dictionary = {}
var save_status: Label
var retry_button: UIActionButton
var save_badge: UIStatusChip
var _dimmer: ColorRect
var close_button: UIActionButton
var _previous_focus: Control

func _ready() -> void:
	theme = PaintedTheme.ui_theme()
	custom_minimum_size = Vector2(400, 360)
	add_theme_stylebox_override("panel", PaintedTheme.surface_style(true))
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	add_child(box)
	var header := HBoxContainer.new()
	box.add_child(header)
	var title := Label.new()
	title.text = "体验反馈 · 自动保存"
	title.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
	title.add_theme_font_size_override("font_size", 20)
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(title)
	var close := UIActionButton.new()
	close_button = close
	close.variant = "quiet"
	close.text = "关闭"
	close.custom_minimum_size = Vector2(64, 48)
	close.add_theme_font_size_override("font_size", 18)
	close.pressed.connect(hide)
	header.add_child(close)
	for entry in [["sound", "音效（M 静音）"], ["particles", "粒子"], ["shake", "画面震动"], ["flash", "冲击闪光"]]:
		var check := UIToggleRow.new()
		check.text = entry[1]
		check.custom_minimum_size.y = 48
		check.add_theme_font_size_override("font_size", 18)
		box.add_child(check)
		checks[entry[0]] = check
		check.toggled.connect(set_setting.bind(entry[0]))
	save_badge = UIStatusChip.new()
	box.add_child(save_badge)
	save_status = Label.new()
	save_status.custom_minimum_size.x = 352
	save_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	save_status.add_theme_font_size_override("font_size", 15)
	box.add_child(save_status)
	retry_button = UIActionButton.new()
	retry_button.variant = "primary"
	retry_button.text = "重试保存"
	retry_button.custom_minimum_size.y = 48
	retry_button.pressed.connect(profile.save_profile)
	box.add_child(retry_button)
	profile.settings_changed.connect(sync_settings)
	profile.save_status_changed.connect(_refresh_status)
	sync_settings()
	_refresh_status()
	resized.connect(_layout_panel)
	visibility_changed.connect(_sync_visibility)
	_install_dimmer.call_deferred()
	_layout_panel()

func _install_dimmer() -> void:
	if not is_inside_tree():
		return
	_dimmer = ColorRect.new()
	_dimmer.name = "SettingsDimmer"
	_dimmer.color = UITokens.MODAL_DIMMER
	_dimmer.z_index = z_index
	get_parent().add_child(_dimmer)
	get_parent().move_child(_dimmer, get_index())
	_sync_visibility()

func _sync_visibility() -> void:
	if is_instance_valid(_dimmer):
		_dimmer.visible = visible
	if visible:
		var owner := get_viewport().gui_get_focus_owner()
		if owner == null or not is_ancestor_of(owner):
			_previous_focus = owner
		close_button.grab_focus()
	elif is_instance_valid(_previous_focus) and _previous_focus.is_inside_tree() and _previous_focus.is_visible_in_tree():
		_previous_focus.grab_focus()
		_previous_focus = null
	_layout_panel()

func _input(event: InputEvent) -> void:
	if not is_visible_in_tree() or not event is InputEventKey or not event.pressed:
		return
	if event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		hide()
		return
	var controls: Array[Control] = [close_button]
	for control: Button in checks.values():
		controls.append(control)
	if retry_button.visible:
		controls.append(retry_button)
	var owner := get_viewport().gui_get_focus_owner()
	var forward := event.is_action_pressed("ui_focus_next") or event.is_action_pressed("ui_down") or event.is_action_pressed("ui_right")
	var backward := event.is_action_pressed("ui_focus_prev") or event.is_action_pressed("ui_up") or event.is_action_pressed("ui_left")
	if forward or backward:
		var index := controls.find(owner)
		controls[posmod(index + (-1 if backward else 1), controls.size())].grab_focus()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("ui_accept") and owner not in controls:
		get_viewport().set_input_as_handled()

func _layout_panel() -> void:
	if not is_inside_tree():
		return
	var bounds := Rect2(Vector2.ZERO, ScreenLayout.DESIGN_SIZE)
	if get_parent() is Control:
		bounds.size = get_parent().size
	position = bounds.get_center() - size * 0.5
	if is_instance_valid(_dimmer):
		_dimmer.position = bounds.position
		_dimmer.size = bounds.size

func _exit_tree() -> void:
	if is_instance_valid(_dimmer):
		_dimmer.queue_free()

func set_setting(enabled: bool, setting: String) -> void:
	profile.set_feedback_setting(setting, enabled)

func sync_settings() -> void:
	var values := FeedbackSettings.snapshot()
	for setting in checks:
		checks[setting].set_pressed_no_signal(values[setting])
	if is_instance_valid(feedback):
		feedback.apply_settings()

func _refresh_status() -> void:
	save_status.text = profile.last_error if profile.save_pending else profile.load_notice
	save_status.visible = not save_status.text.is_empty()
	retry_button.visible = profile.save_pending and not profile.is_read_only()
	save_badge.set_status(&"readonly" if profile.is_read_only() else (&"pending" if profile.save_pending else &"saved"))
