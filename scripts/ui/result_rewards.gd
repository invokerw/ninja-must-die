class_name ResultRewards
extends RefCounted

static func line(summary: Dictionary) -> String:
	if summary.is_empty() or not summary.has("total"):
		return ""
	var text := "铜钱 +%d · 余额 %d" % [summary.total, summary.balance]
	for id in summary.new_character_ids:
		var character := CharacterRegistry.get_character(StringName(id))
		if character != null:
			text += " · %s加入" % character.display_name
	for id in summary.new_level_ids:
		text += " · 解锁%s" % LevelCatalog.get_level(StringName(id)).get("title", id)
	return text

static func breakdown(summary: Dictionary) -> String:
	if not summary.has("breakdown"):
		return ""
	var parts: Array[String] = []
	var names := {"base": "通关", "collection": "收集", "first_clear": "首通", "stars": "新星", "flawless": "首次无伤", "milestones": "章节星数"}
	for key in names:
		if summary.breakdown.get(key, 0) > 0:
			parts.append("%s %d" % [names[key], summary.breakdown[key]])
	return " · ".join(parts)

static func details(summary: Dictionary) -> String:
	var parts := breakdown(summary).split(" · ")
	var rows: Array[String] = ["本次奖励 +%d 铜钱 · 余额 %d" % [summary.total, summary.balance]]
	for index in range(0, parts.size(), 2):
		rows.append(parts[index] + (" · " + parts[index + 1] if index + 1 < parts.size() else ""))
	return "\n".join(rows)
