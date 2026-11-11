class_name UIConfirmDialog
extends Control

signal confirmed
signal cancelled

var title_label: Label
var body_label: Label
var confirm_button: UIActionButton
var cancel_button: UIActionButton
var panel: Panel
var return_focus: Control
var _body_scroll: ScrollContainer

func _init() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	theme = PaintedTheme.ui_theme()
	mouse_filter = Control.MOUSE_FILTER_STOP
	z_index = 30
	var shade := ColorRect.new()
	shade.color = UITokens.MODAL_DIMMER
	add_child(shade)
	shade.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	panel = Panel.new()
	panel.add_theme_stylebox_override("panel", PaintedTheme.surface_style(true))
	add_child(panel)
	title_label = Label.new()
	title_label.add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"section_title"])
	title_label.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
	title_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(title_label)
	_body_scroll = ScrollContainer.new()
	_body_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	panel.add_child(_body_scroll)
	body_label = Label.new()
	body_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_body_scroll.add_child(body_label)
	cancel_button = UIActionButton.new()
	cancel_button.text = "取消"
	cancel_button.pressed.connect(func() -> void: cancelled.emit())
	panel.add_child(cancel_button)
	confirm_button = UIActionButton.new()
	confirm_button.variant = "primary"
	confirm_button.pressed.connect(func() -> void: confirmed.emit())
	panel.add_child(confirm_button)
	resized.connect(_layout)

func configure(title: String, body: String, confirm_text: String, focus_owner: Control = null) -> void:
	title_label.text = title
	body_label.text = body
	confirm_button.text = confirm_text
	return_focus = focus_owner

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_layout()
	for button: Button in [cancel_button, confirm_button]:
		var other := confirm_button if button == cancel_button else cancel_button
		button.focus_next = other.get_path()
		button.focus_previous = other.get_path()
		for side in [SIDE_LEFT, SIDE_TOP, SIDE_RIGHT, SIDE_BOTTOM]:
			button.set_focus_neighbor(side, other.get_path())
	cancel_button.grab_focus()

func _layout() -> void:
	panel.size = Vector2(minf(520, size.x - 48), minf(360, size.y - 48))
	panel.position = (size - panel.size) * 0.5
	title_label.position = Vector2(28, 24)
	title_label.size = Vector2(panel.size.x - 56, 42)
	_body_scroll.position = Vector2(28, 88)
	_body_scroll.size = Vector2(panel.size.x - 56, panel.size.y - 188)
	var button_width := (panel.size.x - 72) * 0.5
	cancel_button.position = Vector2(24, panel.size.y - 80)
	cancel_button.size = Vector2(button_width, 56)
	confirm_button.position = Vector2(48 + button_width, panel.size.y - 80)
	confirm_button.size = Vector2(button_width, 56)

func _input(event: InputEvent) -> void:
	if not is_visible_in_tree() or not event is InputEventKey or not event.pressed or event.echo:
		return
	if event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		cancelled.emit()
	elif event.is_action_pressed("ui_focus_next") or event.is_action_pressed("ui_focus_prev"):
		var owner := get_viewport().gui_get_focus_owner()
		if owner == cancel_button and not confirm_button.disabled:
			confirm_button.grab_focus()
		else:
			cancel_button.grab_focus()
		get_viewport().set_input_as_handled()

func _exit_tree() -> void:
	if is_instance_valid(return_focus) and return_focus.is_inside_tree() and return_focus.is_visible_in_tree() and not return_focus.is_queued_for_deletion():
		if return_focus is BaseButton and return_focus.disabled:
			return
		return_focus.grab_focus()
