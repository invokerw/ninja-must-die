extends "res://scripts/main.gd"

const CandidateControls := preload("res://scripts/art/candidate_touch_controls.gd")
const CandidateRail := preload("res://scripts/art/candidate_progress_rail.gd")
var candidate_rail: Control

func _ready() -> void:
	super._ready()
	# This scene is a review surface; completing it must not write a ranked run.
	_completion_recorded = true
	candidate_rail = CandidateRail.new()
	candidate_rail.position = Vector2(880, 58)
	candidate_rail.size = Vector2(320, 26)
	$UI/HUD.add_child(candidate_rail)
	$UI/HUD/ProgressBack.hide()
	var badge := _hud_label($UI/HUD, Rect2(400, 118, 450, 28), 18)
	badge.text = "UI 组件预览 · 候选，待视觉验收"
	badge.modulate = Color("d8b56a")
	_hud_button($UI/HUD, "跑酷预览", Rect2(400, 154, 140, 36), _open_preview.bind(false))
	_hud_button($UI/HUD, "首领预览", Rect2(552, 154, 140, 36), _open_preview.bind(true))

func _setup_touch_controls() -> void:
	touch_controls = CandidateControls.new()
	touch_controls.name = "CandidateTouchControls"
	touch_controls.player = player
	touch_controls.combat = combat
	touch_controls.pause_requested.connect(_toggle_pause)
	$UI.add_child(touch_controls)
	get_viewport().size_changed.connect(_layout_ui)
	_sync_touch_controls()
	_layout_ui()

func _process(delta: float) -> void:
	super._process(delta)
	if is_instance_valid(candidate_rail):
		candidate_rail.progress = progress_fill.size.x / maxf(progress_fill.get_parent().size.x, 1.0)

func _open_preview(boss: bool) -> void:
	if _transitioning:
		return
	_transitioning = true
	player.stop()
	var path := "res://scenes/art/ui_touch_boss_preview.tscn" if boss else "res://scenes/art/ui_touch_preview.tscn"
	if RunNavigation.launch(get_tree(), path, run_loadout) != OK:
		_transitioning = false
