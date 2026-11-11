class_name UIBattleHUD
extends Control

signal pause_requested

var health: UILinearMeter
var health_label: Label
var character_label: Label
var portrait: TextureRect
var protection_label: Label
var crystals: Label
var timer: Label
var segment_title: Label
var segment_hint: Label
var progress_label: Label
var progress: ProgressRail
var threat: UIThreatNotice
var boss: UIBossStatus
var item: UIStatusChip
var combo: Label
var feedback_label: Label
var pause_button: UIActionButton
var notice: Label

func _ready() -> void:
	theme = PaintedTheme.ui_theme()
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	portrait = PaintedTheme.portrait(self, Rect2(32, 24, 72, 72))
	character_label = _label("", Rect2(124, 28, 90, 28), 18, UITokens.ACCENT)
	health_label = _label("", Rect2(220, 26, 110, 32), 22)
	health = UILinearMeter.new()
	health.position = Vector2(124, 65)
	health.size = Vector2(196, 7)
	add_child(health)
	protection_label = _label("", Rect2(124, 78, 390, 24), 16, UITokens.ACCENT_LIGHT)
	var crystal := TextureRect.new()
	crystal.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	crystal.texture = preload("res://art/generated/collectibles/shadow_crystal.png")
	crystal.position = Vector2(362, 30)
	crystal.size = Vector2(26, 38)
	crystal.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	crystal.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(crystal)
	crystals = _label("", Rect2(400, 30, 130, 40), 22)
	timer = _label("", Rect2(574, 30, 180, 40), 22)
	progress_label = _label("", Rect2(892, 24, 280, 32), 18)
	progress = ProgressRail.new()
	progress.position = Vector2(892, 64)
	progress.size = Vector2(280, 18)
	add_child(progress)
	pause_button = UIActionButton.new()
	pause_button.variant = "quiet"
	pause_button.text = "Ⅱ"
	pause_button.tooltip_text = "暂停 · Esc"
	pause_button.position = Vector2(1180, 20)
	pause_button.size = Vector2(64, 64)
	pause_button.pressed.connect(func() -> void: pause_requested.emit())
	add_child(pause_button)
	segment_title = _label("", Rect2(44, 108, 800, 30), 18)
	item = UIStatusChip.new()
	item.position = Vector2(44, 158)
	item.size = Vector2(276, 38)
	add_child(item)
	combo = _label("", Rect2(44, 216, 280, 28), 16, UITokens.TEXT_SECONDARY)
	feedback_label = _label("", Rect2(44, 254, 580, 28), 18, UITokens.ACCENT_LIGHT)
	segment_hint = _label("", Rect2(44, 304, 760, 54), 16, UITokens.TEXT_SECONDARY)
	segment_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	boss = UIBossStatus.new()
	boss.position = Vector2(344, 154)
	boss.size = Vector2(592, 84)
	boss.hide()
	add_child(boss)
	threat = UIThreatNotice.new()
	threat.position = Vector2(952, 108)
	threat.size = Vector2(280, 104)
	add_child(threat)
	notice = _label("", Rect2(344, 112, 592, 32), 16, UITokens.DANGER_TEXT)
	notice.hide()
	queue_redraw()

func render(value: Dictionary) -> void:
	health_label.text = value.health_text
	character_label.text = value.character_name
	portrait.modulate = value.character_tint
	protection_label.text = value.protection
	health.set_value(value.health, value.max_health, UITokens.DANGER_TEXT if value.health <= 1 else UITokens.DANGER)
	crystals.text = value.crystals
	timer.text = value.timer
	progress.progress = value.progress
	progress.markers = value.markers
	progress_label.text = value.progress_text
	item.set_status(value.item.status, value.item.caption)
	combo.text = value.combo
	feedback_label.text = value.feedback
	boss.visible = not value.boss.is_empty()
	if boss.visible:
		boss.set_state(value.boss)
	threat.set_notice(value.threat.text, value.threat.side, value.threat.urgent, value.threat.active)

func _label(text: String, rect: Rect2, font_size: int, tint: Color = UITokens.TEXT_PRIMARY) -> Label:
	var label := Label.new()
	label.text = text
	label.position = rect.position
	label.size = rect.size
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", tint)
	label.add_theme_color_override("font_shadow_color", UITokens.INK)
	label.add_theme_constant_override("shadow_offset_y", 1)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(label)
	return label

func _draw() -> void:
	draw_arc(Vector2(552, 49), 11, 0, TAU, 32, UITokens.TEXT_PRIMARY, 1.5, true)
	draw_line(Vector2(552, 49), Vector2(552, 42), UITokens.TEXT_PRIMARY, 1.5, true)
	draw_line(Vector2(552, 49), Vector2(557, 52), UITokens.TEXT_PRIMARY, 1.5, true)
