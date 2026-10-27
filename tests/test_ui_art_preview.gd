extends "res://tests/test_touch_controls.gd"

const CANDIDATE := preload("res://scenes/art/ui_touch_preview.tscn")

func _initialize() -> void:
	print("UI_ART_PREVIEW: reusing the full touch behavior suite with candidate rendering")
	super._initialize()

func _spawn(boss: bool = false, parent: Node = null) -> Node2D:
	var main: Node2D = CANDIDATE.instantiate()
	main.start_at_boss = boss
	if not boss:
		main.get_node("Level").boss_data = null
	(parent if parent != null else root).add_child(main)
	await _frames(12 if boss else 3)
	return main

func _test_layout() -> void:
	await super._test_layout()
	var viewport := SubViewport.new()
	viewport.size = Vector2i(1280, 720)
	viewport.world_2d = World2D.new()
	root.add_child(viewport)
	var main := await _spawn(false, viewport)
	var controls: TouchControls = main.touch_controls
	controls.safe_area_override = Rect2(60, 24, 1160, 648)
	controls.sync_state()
	for action in [&"jump_only", &"rope_flip", &"dash", &"weapon", &"skill"]:
		var caption: Label = controls._labels[action]
		_check(controls.safe_area_override.encloses(Rect2(caption.position, caption.size)), "Candidate captions must remain inside a tall bottom system inset")
	viewport.free()
