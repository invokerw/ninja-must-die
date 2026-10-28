class_name PaintedHUD
extends RefCounted

static func install(main: Node2D) -> ProgressRail:
	var hud := main.get_node("UI/HUD") as Control
	for path in ["TopBar", "CharacterPanel", "SkillPanel", "BossPanel", "ResultOverlay"]:
		PaintedTheme.decorate_panel(hud.get_node(path))
	PaintedTheme.portrait(hud, Rect2(30, 20, 92, 94))
	hud.get_node("TopBar").size.x = 700
	var status := hud.get_node("StatusText") as Label
	status.position.x = 154
	status.size.x = 556
	status.add_theme_font_size_override("font_size", 17)
	var hint := hud.get_node("HintText") as Label
	hint.position.x = 154
	hint.size.x = 556
	hint.add_theme_font_size_override("font_size", 13)
	var character := hud.get_node("CharacterPanel") as Control
	character.size.y = 78
	for spec in [["CharacterText", 10, 16], ["PassiveText", 32, 16], ["CombatText", 52, 12]]:
		var label := character.get_node(spec[0]) as Label
		label.position.y = spec[1]
		label.size.y = 20
		label.add_theme_font_size_override("font_size", spec[2])
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
	rail.position = Vector2(880, 58)
	rail.size = Vector2(320, 26)
	hud.add_child(rail)
	hud.get_node("ProgressBack").hide()
	return rail
