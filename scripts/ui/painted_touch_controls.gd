class_name PaintedTouchControls
extends TouchControls

# The optional legacy skin is only used by the retained art-review scenes.
var skin: TouchControlSkin
var action_views: Dictionary = {}

func _ready() -> void:
	super._ready()
	for action in ACTIONS:
		var view := UICombatAction.new()
		view.legacy_art = skin != null and action != &"pause"
		add_child(view)
		action_views[action] = view
	_layout()
	sync_state()

func _layout() -> void:
	super._layout()
	for action in action_views:
		var view: UICombatAction = action_views[action]
		var rect := get_action_rect(action)
		# The pause glyph is compact; its original 96px hit target stays intact.
		view.position = rect.position
		view.size = rect.size
		view.caption.position.y = minf(view.size.y, _safe.end.y - rect.position.y - view.caption.size.y - 2)

func visual_state(action: StringName) -> Dictionary:
	action = _canonical_action(action)
	return BattleHUDPresenter.action_snapshot(action, player, combat, _is_available(action), _fingers.values().has(action))

func sync_state() -> void:
	var safe := safe_area_override if safe_area_override.has_area() else ScreenLayout.safe_rect(get_viewport())
	if safe != _safe:
		_layout()
	super.sync_state()
	# Keyboard players see the same live actions; only enabled touch previews
	# own finger/mouse input. No second input path is introduced by the views.
	visible = true
	for label: Label in _labels.values():
		label.hide()
	for action in action_views:
		var view: UICombatAction = action_views[action]
		view.visible = (enabled and not finished and not blocked) if action == &"pause" else _can_play()
		if not view.visible:
			continue
		view.set_state(visual_state(action), not enabled)
		var rect := get_action_rect(action)
		view.caption.position.y = minf(view.size.y, _safe.end.y - rect.position.y - view.caption.size.y - 2)

func _draw() -> void:
	if skin == null:
		return
	for action in RIGHT_ACTIONS + LEFT_ACTIONS:
		if _can_play():
			skin.draw_button(self, action, get_action_rect(action), visual_state(action))
