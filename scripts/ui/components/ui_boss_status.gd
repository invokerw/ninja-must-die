class_name UIBossStatus
extends Control

var title: Label
var phase_label: Label
var health: UILinearMeter
var phase := &"entrance"

func _init() -> void:
	theme = PaintedTheme.ui_theme()
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	title = Label.new()
	title.add_theme_font_size_override("font_size", 20)
	title.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT)
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(title)
	health = UILinearMeter.new()
	health.position = Vector2(0, 34)
	health.size = Vector2(592, 8)
	add_child(health)
	phase_label = Label.new()
	phase_label.position = Vector2(0, 50)
	phase_label.size = Vector2(592, 28)
	phase_label.add_theme_font_size_override("font_size", 18)
	phase_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(phase_label)

func set_state(value: Dictionary) -> void:
	phase = value.get("phase", &"entrance")
	title.text = value.get("title", "")
	phase_label.text = value.get("hint", "")
	phase_label.add_theme_color_override("font_color", UITokens.ACCENT_LIGHT if phase == &"weak" else UITokens.TEXT_PRIMARY)
	health.set_value(value.get("health", 0), value.get("maximum", 1), UITokens.DANGER_TEXT if value.get("enraged", false) else UITokens.DANGER)
