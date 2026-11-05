class_name RopeHazardData
extends Resource

@export var offset_x: float = 0.0
@export_enum("top", "bottom") var cable_side: String = "top"
@export var size: Vector2 = Vector2(54.0, 72.0)
@export_enum("spike", "falling_bamboo") var hazard_type: String = "spike"
@export_range(0.1, 5.0) var warning_seconds: float = 1.0
@export_range(0.1, 5.0) var active_seconds: float = 1.15
@export_range(0.0, 3.0) var exit_seconds: float = 0.35
@export_enum("top", "bottom") var safe_side: String = "bottom"

func get_validation_errors() -> PackedStringArray:
	var errors := PackedStringArray()
	if hazard_type not in ["spike", "falling_bamboo"]:
		errors.append("未知的机关类型")
	if not size.is_finite() or size.x <= 0.0 or size.y <= 0.0:
		errors.append("机关尺寸必须是有限正数")
	if not is_finite(warning_seconds) or warning_seconds <= 0.0:
		errors.append("机关预警时间必须大于零")
	if not is_finite(active_seconds) or active_seconds <= 0.0:
		errors.append("机关生效时间必须大于零")
	if not is_finite(exit_seconds) or exit_seconds < 0.0:
		errors.append("机关退场时间不能为负数")
	if hazard_type == "falling_bamboo" and safe_side == cable_side:
		errors.append("落竹的安全侧必须与危险侧相反")
	return errors
