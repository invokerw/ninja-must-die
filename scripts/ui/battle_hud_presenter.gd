class_name BattleHUDPresenter
extends RefCounted

static func snapshot(player: PlayerController, combat: RunnerCombat, level: RopeLevelController, elapsed: float, boss_practice: bool, completed: bool = false) -> Dictionary:
	var route_ratio := 0.0 if boss_practice else (0.75 if level.boss_data != null else 1.0)
	var progress := clampf(inverse_lerp(level.data.start_x, level.data.get_finish_x(), player.global_position.x), 0, 1) * route_ratio
	var boss := level.boss
	var boss_state := {}
	if is_instance_valid(boss):
		progress += (1.0 - route_ratio) * (1.0 - float(boss.health) / boss.data.max_health)
		var phase: StringName = {
			RopeBoss.State.ENTRANCE: &"entrance", RopeBoss.State.WINDUP: &"windup",
			RopeBoss.State.ACTIVE: &"attack", RopeBoss.State.RECOVERY: &"weak",
			RopeBoss.State.DEFEATED: &"defeated", RopeBoss.State.CANCELLED: &"cancelled",
		}[boss.state]
		boss_state = {"phase": phase, "title": "%s%s · %d / %d" % [boss.data.display_name, " · 半血强化" if boss.enraged else "", boss.health, boss.data.max_health], "hint": boss.get_hint(), "health": boss.health, "maximum": boss.data.max_health, "enraged": boss.enraged}
		if phase == &"cancelled":
			boss_state = {}
	var markers: Array[float] = []
	var distance := 0.0
	if not boss_practice:
		for segment in level.data.segments:
			distance += segment.length_px
			markers.append(distance / maxf(level.data.get_length(), 1.0) * route_ratio)
	if markers.is_empty() or markers[-1] < 1.0:
		markers.append(1.0)
	if completed:
		progress = 1.0
	var title := "首领练习" if boss_practice else ("关卡进度" if level.boss_data != null else "终点进度")
	var item_state := player.get_consumed_item_state()
	var item_id := StringName(item_state.id)
	var item := {"status": &"empty", "caption": "补给 · 未携带"}
	if not item_id.is_empty():
		var item_name: String = EconomyService.ITEMS.get(item_id, {}).get("name", "补给")
		item = {"status": &"used" if item_state.used else &"carried", "caption": "%s · %s" % [item_name, "已触发" if item_state.used else "待触发"]}
	var protection := maxf(player.immunity_remaining, maxf(player.skill_immunity_remaining, player.mobility.invulnerability_remaining))
	return {
		"character_name": player.character.display_name, "character_tint": player.character.visual_tint,
		"protection": "保护 %.1fs" % protection if protection > 0.00001 else "",
		"health": player.health, "max_health": player.get_max_health(),
		"health_text": "%d / %d" % [player.health, player.get_max_health()],
		"crystals": "%d / %d" % [player.crystals, level.pickup_positions.size()],
		"timer": "%.1f s" % elapsed, "progress": progress, "markers": markers,
		"progress_text": "%s  %d%%" % [title, roundi(progress * 100)],
		"boss": boss_state, "item": item, "threat": threat_snapshot(player, level),
		"combo": "击破 %d · 连击 %d · 最高 %d" % [combat.kills, combat.combo, combat.max_combo],
		"feedback": combat.feedback,
	}

static func action_snapshot(action: StringName, player: PlayerController, combat: RunnerCombat, available: bool, pressed: bool) -> Dictionary:
	var value := {"available": available, "pressed": pressed, "remaining": 0.0, "cooldown": 0.0, "meter_value": 0.0, "meter_max": 1.0, "quota": false, "title": "", "status": "", "key": "", "glyph": &"jump", "weapon_id": combat.weapon.data.weapon_id, "rope_mode": ("down" if player.rope_side == PlayerController.ROPE_TOP else "up") if player.on_rope else "fall"}
	var duration := 1.0
	match action:
		&"jump_only":
			value.merge({"title": "跳跃", "key": "Space", "status": "上翻" if player.on_rope and player.rope_side == PlayerController.ROPE_BOTTOM else ("起跳" if player.on_rope else "余 %d 跳" % player.jumps_remaining)}, true)
		&"rope_flip":
			value.merge({"title": "快速下落" if not player.on_rope else ("下翻" if player.rope_side == PlayerController.ROPE_TOP else "上翻"), "glyph": &"flip", "key": "S / ↓"}, true)
		&"mobility":
			var mobility := player.mobility
			value.merge({"title": mobility.data.display_name, "key": "Shift", "glyph": mobility.data.mobility_id, "status": mobility.remaining_text(player._mobility_context()), "remaining": mobility.cooldown_remaining}, true)
			duration = maxf(mobility.data.cooldown_seconds, 0.01)
			if mobility.data.input_mode == MobilityData.InputMode.HOLD and not player.on_rope:
				value.quota = true
				value.meter_value = mobility.air_time_remaining
				value.meter_max = mobility.data.parameters.get("air_duration", 1.0)
				value.status = "余 %.1fs" % mobility.air_time_remaining if mobility.air_time_remaining > 0.00001 else "已用尽"
		&"weapon":
			value.merge({"title": combat.weapon.data.display_name, "glyph": &"weapon", "texture": WeaponArt.texture_for(combat.weapon.data.weapon_id), "texture_region": WeaponArt.icon_region_for(combat.weapon.data.weapon_id), "key": "J", "remaining": combat.weapon.cooldown_remaining, "status": "就绪" if available else ("等待交战" if is_instance_valid(combat.boss) and combat.boss.alive else "首领战")}, true)
			duration = combat.weapon.data.skill.cooldown_seconds
		&"skill":
			value.merge({"title": player.character.active_skill.display_name, "glyph": &"skill", "key": "K", "remaining": combat.skill_cooldown_remaining, "status": "就绪"}, true)
			duration = player.character.active_skill.cooldown_seconds
		&"pause":
			value.merge({"title": "", "glyph": &"pause", "key": "", "status": "继续" if player.get_tree().paused else "暂停"}, true)
	if value.remaining > 0.00001:
		value.status = "%.1fs" % value.remaining if value.remaining <= 2 else "%ds" % ceili(value.remaining)
		value.meter_value = value.remaining
		value.meter_max = maxf(duration, 0.01)
	value.cooldown = clampf(value.remaining / maxf(duration, 0.01), 0, 1)
	return value

static func threat_snapshot(player: PlayerController, level: RopeLevelController) -> Dictionary:
	var nearest_seconds := INF
	var message := "前方：安全段"
	var nearest_side := ""
	var speed := player.get_forward_speed()
	for hazard in level.hazards:
		if not is_instance_valid(hazard):
			continue
		var distance := hazard.global_position.x - player.global_position.x
		if distance >= -48.0 and distance <= hazard.warning_distance:
			var seconds := maxf(distance, 0.0) / maxf(speed, 1.0)
			if seconds < nearest_seconds:
				nearest_seconds = seconds
				nearest_side = hazard.cable_side
				message = "前方预警  %s机关 · %.1fs" % ["上侧" if hazard.cable_side == "top" else "下侧", seconds]
	for enemy in level.enemies:
		if not is_instance_valid(enemy) or not enemy.alive:
			continue
		var distance := enemy.global_position.x - player.global_position.x
		if distance < -36.0 or distance > enemy.warning_distance:
			continue
		var seconds := maxf(distance, 0.0) / maxf(speed, 1.0)
		if seconds < nearest_seconds:
			nearest_seconds = seconds
			nearest_side = enemy.cable_side
			message = "%s哨兵 · 翻绳躲避 / 忍术" % ("上侧" if enemy.cable_side == "top" else "下侧")
	for shooter in level.shooters:
		if shooter.attack_state != ScreenShooter.AttackState.WINDUP:
			continue
		var seconds := shooter.windup_remaining + shooter.get_flight_seconds()
		if seconds < nearest_seconds or (shooter.cable_side == nearest_side and seconds <= nearest_seconds + 0.7):
			nearest_seconds = minf(nearest_seconds, seconds)
			nearest_side = shooter.cable_side
			message = "右侧齐射 · %d 枚 · 蓄力 %.1fs" % [shooter.volley_count, shooter.windup_remaining]
	if is_instance_valid(level.projectile_root):
		for projectile: EnemyProjectile in level.projectile_root.get_children():
			var distance := projectile.global_position.x - player.global_position.x
			if projectile.spent or distance < -26.0:
				continue
			var seconds := maxf(distance, 0.0) / maxf(speed - projectile.velocity.x, 1.0)
			var cable_side := projectile.cable_side
			if cable_side.is_empty():
				cable_side = "top" if projectile.global_position.y < player.rope_y else "bottom"
			if seconds < nearest_seconds or (cable_side == nearest_side and seconds <= nearest_seconds + 0.25):
				nearest_seconds = minf(nearest_seconds, seconds)
				nearest_side = cable_side
				message = "平行飞弹 · %.1fs · 留意间隙" % seconds
	if is_instance_valid(level.boss) and level.boss.state in [RopeBoss.State.WINDUP, RopeBoss.State.ACTIVE]:
		message = level.boss.get_hint()
		if level.boss.attack != RopeBoss.Attack.PARALLEL_VOLLEY:
			message += " · 下翻躲避" if level.boss.attack == RopeBoss.Attack.UPPER_SWEEP else " · 上翻躲避"
		nearest_seconds = level.boss.remaining if level.boss.state == RopeBoss.State.WINDUP else 0.0
		nearest_side = "top" if level.boss.attack == RopeBoss.Attack.UPPER_SWEEP else ("bottom" if level.boss.attack == RopeBoss.Attack.LOWER_SWEEP else "")
	if nearest_side in ["top", "bottom"] and not message.contains("上侧") and not message.contains("下侧"):
		message = ("%s · " % ("上侧" if nearest_side == "top" else "下侧")) + message
	return {"text": message, "side": nearest_side, "urgent": nearest_seconds <= 0.8, "active": nearest_seconds != INF}
