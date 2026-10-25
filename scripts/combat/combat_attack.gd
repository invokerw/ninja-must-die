class_name CombatAttack
extends RefCounted

var source_kind: StringName
var source_id: StringName
var character_id: StringName
var damage: int
var attack_id: int

func _init(kind: StringName, source: StringName, character: StringName, amount: int, sequence: int) -> void:
	source_kind = kind
	source_id = source
	character_id = character
	damage = amount
	attack_id = sequence
