extends Control
## Small geometry stays crisp at every HUD scale; values and fills remain live.

func _draw() -> void:
	var brass := Color("d8b56a")
	var moon := Color("dde7e7")
	var tip := Vector2(320, 70)
	draw_polyline(PackedVector2Array([tip + Vector2(0, -5), tip + Vector2(5, 0), tip + Vector2(0, 5), tip + Vector2(-5, 0), tip + Vector2(0, -5)]), brass, 1.5, true)
	draw_circle(tip, 1.5, brass)
	draw_line(Vector2(488, 45), Vector2(488, 71), Color(brass, 0.6), 1.0, true)
	var clock := Vector2(532, 59)
	draw_arc(clock, 10, 0, TAU, 40, moon, 1.5, true)
	draw_line(clock + Vector2(-3, -14), clock + Vector2(3, -14), moon, 2.0, true)
	draw_line(clock + Vector2(0, -14), clock + Vector2(0, -10), moon, 1.5, true)
	draw_line(clock + Vector2(8, -8), clock + Vector2(10, -10), moon, 1.5, true)
	draw_line(clock, clock + Vector2(0, -6), moon, 1.5, true)
	draw_line(clock, clock + Vector2(4, 2), moon, 1.5, true)
	draw_circle(clock, 1.5, moon)
