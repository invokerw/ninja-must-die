class_name WeaponPreview
extends Control

var weapon: WeaponData
var icon_only := false
var _clock := 0.0

func _process(delta: float) -> void:
	_clock += delta
	queue_redraw()

func _draw() -> void:
	if weapon == null:
		return
	if icon_only:
		WeaponArt.draw_icon(self, weapon.weapon_id, size * 0.5, minf(size.x, size.y) * 0.34)
		return
	var center := Vector2(42.0, size.y * 0.5)
	draw_circle(center, 17.0, Color("dde7e7"))
	draw_line(center + Vector2(-8, 9), center + Vector2(9, 9), Color("111827"), 2.0)
	WeaponArt.draw_icon(self, weapon.weapon_id, center + Vector2(24, -3), 13.0)
	draw_line(Vector2(8, center.y + 20), Vector2(size.x - 12, center.y + 20), Color("233142"), 2.0)
	var phase := fmod(_clock, 2.2)
	for index in range(weapon.skill.projectile_count):
		var travel := (phase - weapon.skill.cast_delay_seconds - float(index) * weapon.skill.shot_interval) / 0.9
		if travel < 0.0 or travel > 1.0:
			continue
		var at := Vector2(lerpf(90.0, size.x - 28.0, travel), center.y)
		WeaponArt.draw_icon(self, weapon.weapon_id, at, 12.0)
	draw_arc(Vector2(size.x - 18, center.y), 18.0, 0, TAU, 24, Color("b24b4b"), 3.0)
