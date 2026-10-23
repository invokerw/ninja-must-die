class_name RopeSegmentData
extends Resource

@export var segment_id: StringName
@export var title: String
@export_multiline var hint: String
@export var length_px: float = 3200.0
@export var hazards: Array[RopeHazardData] = []
@export var pickups: Array[RopePickupData] = []
@export var enemies: Array[RopeEnemyData] = []
