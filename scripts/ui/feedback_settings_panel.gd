class_name FeedbackSettingsPanel
extends PanelContainer

var profile: PlayerProfile
var feedback: RunFeedback
var checks: Dictionary = {}
var save_status: Label
var retry_button: Button

func _ready() -> void:
	custom_minimum_size = Vector2(336, 296)
	var style := StyleBoxFlat.new()
	style.bg_color = Color("111827")
	style.border_color = Color("d8b56a")
	style.set_border_width_all(2)
	style.set_content_margin_all(12)
	add_theme_stylebox_override("panel", style)
	var box := VBoxContainer.new()
	add_child(box)
	var title := Label.new()
	title.text = "体验反馈 · 自动保存"
	title.add_theme_color_override("font_color", Color("d8b56a"))
	title.add_theme_font_size_override("font_size", 20)
	box.add_child(title)
	for entry in [["sound", "音效（M 静音）"], ["particles", "粒子"], ["shake", "画面震动"], ["flash", "冲击闪光"]]:
		var check := CheckButton.new()
		check.text = entry[1]
		check.focus_mode = Control.FOCUS_NONE
		check.add_theme_font_size_override("font_size", 18)
		box.add_child(check)
		checks[entry[0]] = check
		check.toggled.connect(set_setting.bind(entry[0]))
	save_status = Label.new()
	save_status.custom_minimum_size.x = 308
	save_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	save_status.add_theme_font_size_override("font_size", 15)
	box.add_child(save_status)
	retry_button = Button.new()
	retry_button.text = "重试保存"
	retry_button.focus_mode = Control.FOCUS_NONE
	retry_button.pressed.connect(profile.save_profile)
	box.add_child(retry_button)
	profile.settings_changed.connect(sync_settings)
	profile.save_status_changed.connect(_refresh_status)
	sync_settings()
	_refresh_status()

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
	retry_button.visible = profile.save_pending
