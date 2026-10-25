class_name ScreenLayout
extends RefCounted

const DESIGN_SIZE := Vector2(1280, 720)

static func configure_window(viewport: Viewport, touch: bool) -> void:
	if viewport is Window and DisplayServer.get_name() != "headless":
		var aspect := Window.CONTENT_SCALE_ASPECT_EXPAND if touch else Window.CONTENT_SCALE_ASPECT_KEEP
		if viewport.content_scale_aspect != aspect:
			viewport.content_scale_aspect = aspect

static func safe_rect(viewport: Viewport) -> Rect2:
	var bounds := viewport.get_visible_rect()
	if not OS.has_feature("mobile"):
		return bounds
	var display_safe := Rect2(DisplayServer.get_display_safe_area())
	if not display_safe.has_area():
		return bounds
	var inverse := viewport.get_screen_transform().affine_inverse()
	var safe := Rect2(inverse * display_safe.position, inverse.basis_xform(display_safe.size)).intersection(bounds)
	return safe if safe.has_area() else bounds

static func fit_frame(safe: Rect2) -> Rect2:
	var factor := minf(safe.size.x / DESIGN_SIZE.x, safe.size.y / DESIGN_SIZE.y)
	var fitted := DESIGN_SIZE * factor
	return Rect2(safe.get_center() - fitted * 0.5, fitted)

static func fit_control(control: Control, safe: Rect2) -> void:
	var frame := fit_frame(safe)
	control.set_anchors_preset(Control.PRESET_TOP_LEFT)
	control.position = frame.position
	control.size = DESIGN_SIZE
	control.scale = frame.size / DESIGN_SIZE
