class_name CrystalPickup
extends Area2D

const ART := preload("res://art/generated/collectibles/shadow_crystal.png")
var _collected := false

func _ready() -> void:
	collision_layer = 32
	collision_mask = 2
	var collision := CollisionShape2D.new()
	var shape := CircleShape2D.new()
	shape.radius = 18.0 * (1.15 if body_has_light_scroll() else 1.0)
	collision.shape = shape
	add_child(collision)
	body_entered.connect(_on_body_entered)

func body_has_light_scroll() -> bool:
	var player := get_tree().get_first_node_in_group("player") as PlayerController
	return player != null and player.run_loadout != null and String(player.run_loadout.item_snapshot.get("selected_scroll_id", "")) == "light_scroll"

func _on_body_entered(body: Node2D) -> void:
	if _collected or not body is PlayerController or not body.active:
		return
	_collected = true
	body.collect_crystal()
	queue_free()

func _draw() -> void:
	# Preserve the existing 18px pickup radius and center on the attached body.
	draw_texture_rect(ART, Rect2(-14, -20, 28, 40), false)
