class_name UIActionButton
extends Button

@export_enum("primary", "secondary", "quiet", "danger") var variant: String = "secondary":
	set(value):
		variant = value if value in ["primary", "secondary", "quiet", "danger"] else "secondary"
		PaintedTheme.style_button(self, StringName(variant))

var busy := false
var _available := true
var _busy_time := 0.0

func _init() -> void:
	custom_minimum_size = UITokens.TOUCH_MIN
	theme = PaintedTheme.ui_theme()
	add_theme_font_size_override("font_size", UITokens.FONT_SIZES[&"action"])
	PaintedTheme.style_button(self)
	set_process(false)

func set_available(value: bool, reason: String = "") -> void:
	_available = value
	tooltip_text = reason
	disabled = busy or not value

func set_busy(value: bool) -> void:
	if value == busy:
		return
	if value:
		_available = not disabled
	busy = value
	disabled = busy or not _available
	set_process(busy)
	queue_redraw()

func _process(delta: float) -> void:
	_busy_time = fmod(_busy_time + delta, 1.0)
	queue_redraw()

func _draw() -> void:
	if not busy:
		return
	var center := Vector2(16, size.y * 0.5)
	draw_arc(center, 6, _busy_time * TAU, _busy_time * TAU + PI * 1.4, 20, UITokens.ACCENT, 2, true)
