class_name PaintedBackdrop
extends Control

const SKY := preload("res://art/generated/environments/fog_ridge_sky_v01.png")
const MIDDLE := preload("res://art/generated/environments/fog_ridge_middle_v01.png")
const FOREGROUND := preload("res://art/generated/environments/fog_ridge_foreground_v01.png")
var scroll_x := 0.0

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

func _process(_delta: float) -> void:
	# Parallax follows the real camera, including during boss pursuit.
	scroll_x = get_viewport().get_canvas_transform().affine_inverse().origin.x
	queue_redraw()

func _draw() -> void:
	var bounds := get_viewport_rect()
	var height := maxf(bounds.size.y, 1.0)
	# Cover the screen with one sky: the moon never duplicates on a wide viewport.
	var sky_scale := maxf(bounds.size.x / SKY.get_width(), height / SKY.get_height())
	var sky_size := SKY.get_size() * sky_scale
	var sky_overflow := maxf(0.0, sky_size.x - bounds.size.x)
	var sky_offset := clampf(scroll_x * 0.008, 0.0, sky_overflow)
	draw_texture_rect(SKY, Rect2(Vector2(-sky_offset, 0.0), sky_size), false)
	var width := float(MIDDLE.get_width()) * height / float(MIDDLE.get_height())
	var offset := fposmod(scroll_x * 0.11, width)
	var tiles := ceili((bounds.size.x + offset) / width)
	for index in range(tiles):
		draw_texture_rect(MIDDLE, Rect2(float(index) * width - offset, 0, width, height), false, Color(0.8, 0.87, 1.0, 0.66))
	var foreground_width := float(FOREGROUND.get_width()) * height / float(FOREGROUND.get_height())
	var foreground_offset := fposmod(scroll_x * 0.23, foreground_width)
	for index in range(ceili((bounds.size.x + foreground_offset) / foreground_width)):
		draw_texture_rect(FOREGROUND, Rect2(float(index) * foreground_width - foreground_offset, 0, foreground_width, height), false, Color(0.85, 0.9, 1.0, 0.65))
	# Quiet the painting around both playable sides; this overlay has no world collision.
	draw_rect(bounds, Color(0.025, 0.045, 0.08, 0.2))
