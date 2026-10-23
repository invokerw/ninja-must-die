class_name PassiveData
extends Resource

enum Effect { EXTRA_AIR_JUMPS }

@export var passive_id: StringName = &"triple_jump"
@export var display_name: String = "踏影（三段跳）"
@export var effect: Effect = Effect.EXTRA_AIR_JUMPS
@export_range(0, 1) var extra_air_jumps: int = 1
