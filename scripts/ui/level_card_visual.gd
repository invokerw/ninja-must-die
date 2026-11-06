extends Control

# Reuse the approved artwork. Only the selected, unlocked card uses the
# red/gold frame; a neutral card samples the illustration inside that frame.
const SELECTED := preload("res://art/generated/ui/level_select/v01/loop_02_roi_1_feature_card.png")
const LOCKED := preload("res://art/generated/ui/level_select/v01/loop_05_roi_4_locked_card_backplate.png")
const ILLUSTRATION := Rect2(76, 18, 338, 112)

var unlocked := false
var selected := false

func set_state(is_unlocked: bool, is_selected: bool) -> void:
	unlocked = is_unlocked
	selected = is_selected
	queue_redraw()

func _draw() -> void:
	var bounds := Rect2(Vector2.ZERO, size)
	if not unlocked:
		draw_texture_rect(LOCKED, bounds, false)
	elif selected:
		draw_texture_rect(SELECTED, bounds, false)
	else:
		draw_rect(bounds, Color("111c29"))
		draw_texture_rect_region(SELECTED, Rect2(5, 5, size.x - 10, 101), ILLUSTRATION)
		draw_rect(bounds.grow(-2), Color("8e9b9f"), false, 2.0)
		draw_rect(bounds.grow(-5), Color("55636c"), false, 1.0)
