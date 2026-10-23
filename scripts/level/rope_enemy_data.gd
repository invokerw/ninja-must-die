class_name RopeEnemyData
extends Resource

@export var offset_x: float
@export_enum("top", "bottom") var cable_side: String = "top"
@export_range(1, 3) var health: int = 1
