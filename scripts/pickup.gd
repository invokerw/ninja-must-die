class_name CrystalPickup
extends Area2D

const ART := preload("res://art/generated/collectibles/shadow_crystal.png")
var _collected := false

func _ready() -> void:
	collision_layer = 32
	collision_mask = 2
	var collision := CollisionShape2D.new()
	var shape := CircleShape2D.new()
	shape.radius = 18.0
	collision.shape = shape
	add_child(collision)
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if _collected or not body is PlayerController or not body.active:
		return
	_collected = true
	body.collect_crystal()
	queue_free()

func _draw() -> void:
	# Preserve the existing 18px pickup radius and center on the attached body.
	draw_texture_rect(ART, Rect2(-14, -20, 28, 40), false)
