class_name UITabBar
extends HBoxContainer

signal selection_changed(id: StringName)

var selected_id: StringName
var buttons: Dictionary = {}

func _init() -> void:
	theme = PaintedTheme.ui_theme()
	custom_minimum_size.y = 52
	add_theme_constant_override("separation", 8)

func set_entries(entries: Array, initial_id: StringName = &"") -> void:
	for child in get_children():
		remove_child(child)
		child.queue_free()
	buttons.clear()
	for entry: Dictionary in entries:
		var id := StringName(entry.id)
		if id.is_empty() or buttons.has(id):
			continue
		var button := UIActionButton.new()
		button.text = entry.title
		button.toggle_mode = true
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		button.custom_minimum_size.y = 52
		button.add_theme_font_size_override("font_size", 20)
		button.add_theme_stylebox_override("normal", PaintedTheme.button_style(&"quiet", &"normal"))
		var pressed := PaintedTheme.button_style(&"quiet", &"normal")
		pressed.border_color = UITokens.ACCENT
		pressed.border_width_bottom = 2
		button.add_theme_stylebox_override("pressed", pressed)
		button.add_theme_color_override("font_pressed_color", UITokens.ACCENT_LIGHT)
		button.pressed.connect(select.bind(id))
		add_child(button)
		buttons[id] = button
	selected_id = &""
	if not buttons.is_empty():
		select(initial_id if buttons.has(initial_id) else buttons.keys()[0], false)

func select(id: StringName, emit_change: bool = true) -> void:
	if not buttons.has(id):
		return
	var changed := selected_id != id
	selected_id = id
	for key: StringName in buttons:
		buttons[key].set_pressed_no_signal(key == id)
	if changed and emit_change:
		selection_changed.emit(id)
