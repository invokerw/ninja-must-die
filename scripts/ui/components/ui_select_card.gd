class_name UISelectCard
extends Button

var item_id: StringName
var selected := false
var title_label: Label
var description_label: Label
var state_chip: UIStatusChip
var artwork: TextureRect
var _column: VBoxContainer

func _init() -> void:
	theme = PaintedTheme.ui_theme()
	custom_minimum_size = Vector2(216, 140)
	artwork = TextureRect.new()
	artwork.custom_minimum_size = Vector2(72, 72)
	artwork.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	artwork.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	artwork.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(artwork)
	_column = VBoxContainer.new()
	_column.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_column.add_theme_constant_override("separation", 6)
	add_child(_column)
	title_label = Label.new()
	title_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	title_label.add_theme_font_size_override("font_size", 22)
	title_label.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
	title_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_column.add_child(title_label)
	description_label = Label.new()
	description_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	description_label.add_theme_font_size_override("font_size", 16)
	description_label.add_theme_color_override("font_color", UITokens.TEXT_SECONDARY)
	description_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_column.add_child(description_label)
	state_chip = UIStatusChip.new()
	state_chip.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_column.add_child(state_chip)
	resized.connect(_layout)
	_column.minimum_size_changed.connect(_layout)
	set_state(false)

func _ready() -> void:
	_layout()

func configure(id: StringName, title: String, description: String, texture: Texture2D = null) -> void:
	item_id = id
	title_label.text = title
	description_label.text = description
	artwork.texture = texture
	artwork.visible = texture != null
	tooltip_text = "%s\n%s" % [title, description]
	_layout()

func set_state(is_selected: bool, status: StringName = &"", caption: String = "") -> void:
	selected = is_selected
	for state in [&"normal", &"hover", &"pressed", &"disabled"]:
		var style := PaintedTheme.surface_style(selected)
		style.set_content_margin_all(0)
		if state in [&"hover", &"pressed"]:
			style.bg_color = UITokens.SURFACE_RAISED
		elif state == &"disabled":
			style.bg_color = UITokens.INK
		add_theme_stylebox_override(state, style)
	add_theme_stylebox_override("focus", PaintedTheme.button_style(&"secondary", &"focus"))
	state_chip.visible = not status.is_empty()
	if state_chip.visible:
		state_chip.set_status(status, caption)
	queue_redraw()

func _layout() -> void:
	if _column == null:
		return
	artwork.position = Vector2(20, maxf(16, (size.y - 72) * 0.5))
	artwork.size = Vector2(72, 72)
	var inset := 108.0 if artwork.visible else 20.0
	_column.position = Vector2(inset, 16)
	_column.size = Vector2(maxf(0, size.x - inset - 20), maxf(0, size.y - 32))

func _draw() -> void:
	if selected:
		draw_colored_polygon(PackedVector2Array([Vector2(0, 0), Vector2(16, 0), Vector2(0, 16)]), UITokens.ACCENT)
