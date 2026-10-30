class_name PaintedHUD
extends RefCounted

static func install(main: Node2D) -> ProgressRail:
	var hud := main.get_node("UI/HUD") as Control
	for path in ["CharacterPanel", "SkillPanel", "BossPanel", "ResultOverlay"]:
		PaintedTheme.decorate_panel(hud.get_node(path))
	_install_top_hud(hud)
	var character := hud.get_node("CharacterPanel") as Control
	character.size.y = 48
	for spec in [["CharacterText", 6, 16], ["PassiveText", 0, 16], ["CombatText", 28, 12]]:
		var label := character.get_node(spec[0]) as Label
		label.position.y = spec[1]
		label.size.y = 20
		label.add_theme_font_size_override("font_size", spec[2])
	character.get_node("PassiveText").hide()
	var skill := hud.get_node("SkillPanel") as Control
	skill.size.y = 72
	skill.get_node("SkillText").position.y = 10
	skill.get_node("SkillText").add_theme_font_size_override("font_size", 18)
	skill.get_node("ProtectionText").position.y = 36
	skill.get_node("ProtectionText").add_theme_font_size_override("font_size", 13)
	skill.get_node("CooldownBack").position.y = 60
	main.weapon_text.position.y = 10
	main.weapon_text.add_theme_font_size_override("font_size", 17)
	main.weapon_hint.position.y = 36
	main.weapon_hint.add_theme_font_size_override("font_size", 12)
	var weapon_panel := main.weapon_text.get_parent() as Control
	weapon_panel.position.y = 320
	weapon_panel.size.y = 68
	main.weapon_fill.get_parent().position.y = 58
	var rail := ProgressRail.new()
	rail.position = Vector2(898, 62)
	rail.size = Vector2(290, 18)
	hud.add_child(rail)
	hud.get_node("ProgressBack").hide()
	return rail

static func _install_top_hud(hud: Control) -> void:
	hud.get_node("TopBar").hide()
	hud.get_node("StatusText").hide()
	hud.get_node("HintText").hide()
	var portrait := PaintedTheme.portrait(hud, Rect2(32, 24, 78, 78))
	portrait.size = Vector2(78, 78)
	# Keep the live data bindings while removing every card background.
	var health := hud.get_node("HealthCard") as ColorRect
	health.color.a = 0.0
	health.position = Vector2(126, 34)
	health.size = Vector2(194, 44)
	_label(health.get_node("HealthTitle"), Rect2(0, 0, 78, 28), 18, Color("d8b56a"))
	_label(health.get_node("HealthText"), Rect2(100, 0, 88, 28), 22)
	var health_back := health.get_node("HealthBack") as ColorRect
	health_back.position = Vector2(0, 33)
	health_back.size = Vector2(194, 6)
	health_back.color = Color("243346", 0.8)
	health_back.get_node("HealthFill").size.y = 6.0
	var crystals := hud.get_node("CrystalCard") as ColorRect
	crystals.color.a = 0.0
	crystals.position = Vector2(372, 38)
	crystals.size = Vector2(116, 40)
	crystals.get_node("CrystalTitle").hide()
	_label(crystals.get_node("CrystalText"), Rect2(36, 0, 88, 36), 22)
	crystals.get_node("CrystalText").horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	var crystal := TextureRect.new()
	# Disable the texture minimum before assigning it, so the icon keeps its HUD size.
	crystal.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	crystal.texture = preload("res://art/generated/collectibles/shadow_crystal.png")
	crystal.position = Vector2(0, 1)
	crystal.size = Vector2(28, 38)
	crystal.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	crystal.mouse_filter = Control.MOUSE_FILTER_IGNORE
	crystals.add_child(crystal)
	var timer := hud.get_node("TimeCard") as ColorRect
	timer.color.a = 0.0
	timer.position = Vector2(520, 38)
	timer.size = Vector2(140, 40)
	timer.get_node("TimeTitle").hide()
	_label(timer.get_node("TimeText"), Rect2(38, 0, 100, 36), 22)
	timer.get_node("TimeText").horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	_label(hud.get_node("SegmentTitle"), Rect2(44, 108, 700, 30), 18)
	_label(hud.get_node("ProgressLabel"), Rect2(904, 30, 278, 28), 18)
	hud.get_node("ProgressLabel").horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	_label(hud.get_node("ThreatText"), Rect2(904, 82, 284, 25), 15, Color("d8b56a"))
	var marks := preload("res://scripts/ui/floating_hud_marks.gd").new()
	marks.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hud.add_child(marks)

static func _label(label: Label, bounds: Rect2, font_size: int, tint: Color = Color("dde7e7")) -> void:
	label.position = bounds.position
	label.size = bounds.size
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", tint)
	label.add_theme_color_override("font_shadow_color", Color("0a1424", 0.85))
	label.add_theme_constant_override("shadow_offset_x", 0)
	label.add_theme_constant_override("shadow_offset_y", 1)
