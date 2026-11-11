class_name UILevelCard
extends UISelectCard

var unlocked := false
var rating: UIStarRating

func _init() -> void:
	super()
	custom_minimum_size = Vector2(320, 200)
	state_chip.reparent(self)
	rating = UIStarRating.new()
	rating.scale = Vector2.ONE * 0.5
	add_child(rating)
	artwork.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED

func set_progress(is_unlocked: bool, is_selected: bool, record: Dictionary) -> void:
	unlocked = is_unlocked
	var completed := int(record.get("completions", 0)) > 0
	set_state(is_selected, &"owned" if unlocked else &"locked", ("已通关" if completed else "已解锁") if unlocked else "未解锁")
	rating.stars = int(record.get("best_stars", 0))
	if record.is_empty():
		description_label.text = "尚无正式纪录"
	elif record.has("best_stars"):
		description_label.text = "最高 %d 星 · %s" % [record.best_stars, "历史无伤印" if record.flawless else "尚无无伤印"]
	else:
		description_label.text = "旧版 %s · 星级待挑战" % record.best_rank

func _layout() -> void:
	if _column == null or rating == null:
		return
	artwork.position = Vector2(12, 12)
	artwork.size = Vector2(maxf(0, size.x - 24), 80)
	_column.position = Vector2(16, 100)
	_column.size = Vector2(maxf(0, size.x - 32), 58)
	state_chip.position = Vector2(16, 160)
	state_chip.size = Vector2(132, 32)
	rating.position = Vector2(size.x - 100, 164)
	rating.size = rating.custom_minimum_size
