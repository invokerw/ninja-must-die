class_name UIDetailPanel
extends PanelContainer

var title_label: Label
var body_label: Label
var content: VBoxContainer
var footer: HBoxContainer
var scroll: ScrollContainer

func _init() -> void:
	theme = PaintedTheme.ui_theme()
	add_theme_stylebox_override("panel", PaintedTheme.surface_style())
	var layout := VBoxContainer.new()
	add_child(layout)
	title_label = Label.new()
	title_label.add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"section_title"])
	title_label.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
	title_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	layout.add_child(title_label)
	scroll = ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	layout.add_child(scroll)
	content = VBoxContainer.new()
	content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(content)
	body_label = Label.new()
	body_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body_label.add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"secondary"])
	body_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	content.add_child(body_label)
	footer = HBoxContainer.new()
	footer.hide()
	footer.child_order_changed.connect(_sync_footer)
	layout.add_child(footer)

func set_description(title: String, body: String) -> void:
	title_label.text = title
	title_label.visible = not title.is_empty()
	body_label.text = body
	body_label.visible = not body.is_empty()

func _sync_footer() -> void:
	footer.visible = footer.get_child_count() > 0
