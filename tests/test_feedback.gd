extends SceneTree

const PRACTICE := preload("res://scenes/practice.tscn")
const BOSS_PRACTICE := preload("res://scenes/boss_practice.tscn")
var _failures := 0

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	_reset_settings()
	_test_assets()
	await _test_real_actions()
	await _test_pause_and_settings()
	await _test_render_only_impact()
	await _test_boss_signals()
	await _test_result_and_reload()
	await _test_bounded_effects()
	_reset_settings()
	if _failures == 0:
		print("FEEDBACK_PASS (PCM assets, action cues, readable warnings, particles/voice bounds, render-only impact, independent toggles, pause/result/reload)")
	quit(0 if _failures == 0 else 1)

func _reset_settings() -> void:
	FeedbackSettings.sound_enabled = true
	FeedbackSettings.particles_enabled = true
	FeedbackSettings.shake_enabled = true
	FeedbackSettings.flash_enabled = true

func _test_assets() -> void:
	for cue in RunFeedback.STREAMS:
		var stream: AudioStreamWAV = RunFeedback.STREAMS[cue]
		_check(stream.get_length() >= 0.09 and stream.get_length() < 1.0 and stream.mix_rate == 22050, "Every event must have a short imported PCM effect: %s" % cue)
		_check(stream.data.size() > 3000, "Sound samples must contain actual audio data: %s" % cue)

func _test_real_actions() -> void:
	var main := PRACTICE.instantiate()
	root.add_child(main)
	var events: Array[StringName] = []
	main.feedback.cue_played.connect(func(cue: StringName) -> void: events.append(cue))
	await _tap("drop")
	await _frames(7)
	await _tap("jump")
	await _frames(7)
	await _tap("jump")
	await _frames(2)
	await _tap("jump")
	await _tap("dash")
	await _tap("skill")
	await _frames(10)
	for cue in [&"flip", &"jump", &"air_jump", &"dash", &"skill", &"strike"]:
		_check(events.has(cue), "Actual accepted input must emit %s feedback" % cue)
	_check(main.feedback.particles.size() > 0, "Real movement and combat must produce visual particles")
	var casts: int = main.combat.skill_casts
	await _tap("skill")
	_check(main.combat.skill_casts == casts and events.count(&"skill") == 1, "Rejected skill input must not create a second cast cue")
	main.player.collect_crystal()
	_check(events.has(&"pickup"), "Real crystal collection must play pickup feedback")
	main.player.take_damage()
	_check(events.has(&"guard") and main.player.damage_count == 0, "Protected contact must produce guard feedback without hurt feedback")
	main.player.skill_immunity_remaining = 0.0
	main.player.dash_remaining = 0.0
	main.player.take_damage()
	_check(events.has(&"hit") and main.player.damage_count == 1, "A real hit must produce damage feedback")
	main.combat.skill_cooldown_remaining = 0.01
	await _frames(2)
	_check(events.count(&"ready") == 1, "Cooldown completion must emit one readiness chime")
	main.free()

func _test_pause_and_settings() -> void:
	var main := PRACTICE.instantiate()
	root.add_child(main)
	var feedback := main.feedback as RunFeedback
	feedback.play(&"boss_kill", main.player.position)
	await _frames(2)
	paused = true
	# Allow the output mixer to acknowledge the queued pause before taking a snapshot.
	await _frames(5)
	var particle_state := feedback.particles.duplicate(true)
	var shake := feedback.shake_remaining
	var playback := feedback.voices[0].get_playback_position()
	await _frames(15)
	_check(feedback.particles == particle_state and feedback.shake_remaining == shake, "Pause must freeze visual lifetimes and movement")
	if feedback.audio_output_enabled:
		_check(feedback.voices[0].stream_paused and absf(feedback.voices[0].get_playback_position() - playback) < 0.001, "Pause must suspend in-game audio (paused=%s, before=%.5f, after=%.5f)" % [feedback.voices[0].stream_paused, playback, feedback.voices[0].get_playback_position()])
	_send(main, "feedback_settings")
	_check(main.feedback_menu.visible, "Feedback settings must open during pause")
	main._feedback_checks["particles"].button_pressed = false
	_check(feedback.particles.is_empty() and FeedbackSettings.shake_enabled and FeedbackSettings.flash_enabled, "Particles must be independently disableable without removing the other effects")
	main._feedback_checks["shake"].button_pressed = false
	_check(feedback.shake_remaining == 0.0 and feedback.shake_offset == Vector2.ZERO and FeedbackSettings.flash_enabled, "Shake must switch off immediately and independently")
	main._feedback_checks["flash"].button_pressed = false
	_check(feedback.flash_remaining == 0.0 and not feedback.screen_effect.visible, "Flash must switch off immediately")
	_send(main, "mute")
	_check(not FeedbackSettings.sound_enabled and not main._feedback_checks["sound"].button_pressed, "Mute shortcut must also update the visible sound switch")
	for voice in feedback.voices:
		_check(not voice.playing, "Mute must stop all active gameplay voices")
	paused = false
	await _frames(2)
	_check(not feedback.voices[0].stream_paused, "Resume must release paused gameplay voices")
	feedback.play(&"hit", main.player.position)
	await _frames(1)
	_check(feedback.particles.is_empty() and not feedback.screen_effect.visible, "Disabled effects must remain disabled for future events")
	main._feedback_checks["particles"].button_pressed = true
	feedback.play(&"weakpoint", main.player.position)
	_check(not feedback.particles.is_empty() and not FeedbackSettings.sound_enabled, "Muting audio must still allow visual feedback independently")
	main.free()
	_reset_settings()

func _test_render_only_impact() -> void:
	var baseline: Array[Vector2] = []
	for enabled in [false, true]:
		FeedbackSettings.shake_enabled = enabled
		FeedbackSettings.flash_enabled = enabled
		var main := PRACTICE.instantiate()
		root.add_child(main)
		var camera := main.player.get_node("Camera2D") as Camera2D
		var camera_offset := camera.offset
		var shooter: ScreenShooter = main.level.shooters[0]
		main.player.position.x = shooter.trigger_x - 20.0
		camera.reset_smoothing()
		var shots: Array[Vector2] = []
		shooter.projectile_fired.connect(func(shot: EnemyProjectile) -> void:
			shots.append(shot.global_position)
			shots.append(shot.velocity)
		)
		for tick in range(55):
			if enabled and tick % 4 == 0:
				main.feedback.play(&"hit", main.player.position)
			await _frames(1)
		_check(shots.size() == 6 and camera.offset == camera_offset, "Impact feedback must preserve camera and all three real projectiles")
		if not enabled:
			baseline = shots
		else:
			_check(shots == baseline, "Turning shake/flash on must preserve identical projectile origins and directions")
			_check(main.feedback.screen_effect.get_parent().layer == 2 and main.get_node("UI").layer == 3, "The render effect must sit below HUD and above the world")
		main.free()
	_reset_settings()

func _test_boss_signals() -> void:
	var main := BOSS_PRACTICE.instantiate()
	root.add_child(main)
	var events: Array[StringName] = []
	main.feedback.cue_played.connect(func(cue: StringName) -> void: events.append(cue))
	await _tap("drop")
	for tick in range(240):
		if is_instance_valid(main.level.boss) and main.level.boss.is_vulnerable():
			break
		await _frames(1)
	for cue in [&"boss_enter", &"warning_top", &"sweep", &"weakpoint"]:
		_check(events.has(cue), "Real boss transitions must emit %s once per transition" % cue)
	await _tap("skill")
	await _frames(10)
	_check(events.has(&"weak_hit") and not events.has(&"hit"), "Hitting the weak point must have its own impact without pretending the player was hurt")
	_check(main.feedback.flash_remaining == 0.0, "An offensive hit must not create a red player-damage flash")
	var warnings_before := events.count(&"warning_bottom")
	var launches_before := events.count(&"volley")
	main.level.boss.attack = RopeBoss.Attack.PARALLEL_VOLLEY
	main.level.boss._begin_attack()
	await _frames(77)
	_check(events.count(&"warning_bottom") == warnings_before + 1 and events.count(&"volley") == launches_before + 1, "One boss volley must emit one correct-side warning and one launch cue, not one cue per bullet")
	main.free()

func _test_result_and_reload() -> void:
	var main := PRACTICE.instantiate()
	root.add_child(main)
	current_scene = main
	main.player.position.x = main.level.data.get_finish_x() - 65.0
	await _frames(15)
	_check(main._finished and paused and main.feedback.ui_voice.stream == RunFeedback.STREAMS[&"clear"], "A completed run must select a result chime even while paused")
	if main.feedback.audio_output_enabled:
		_check(main.feedback.ui_voice.playing, "Result audio must really play in graphical mode while the tree is paused")
	_check(main.feedback.particles.is_empty() and not main.feedback.screen_effect.visible, "Result entry must clear all world particles and screen effects")
	FeedbackSettings.sound_enabled = false
	main.feedback.apply_settings()
	main._restart_run()
	await _frames(3)
	main = current_scene
	_check(not FeedbackSettings.sound_enabled and not main._feedback_checks["sound"].button_pressed and not main.feedback_menu.visible, "Retry must keep session preferences and rebuild a closed settings menu")
	_check(main.feedback.particles.is_empty() and main.feedback.shake_remaining == 0.0 and not main.feedback.ui_voice.playing, "Retry must not inherit old particles, shake or result audio")
	FeedbackSettings.sound_enabled = true
	main.feedback.apply_settings()
	main.player.take_damage(main.player.health)
	await _frames(2)
	_check(main.feedback.ui_voice.stream == RunFeedback.STREAMS[&"fail"] and main._finished, "A real death must choose the failure sound")
	paused = false
	main.free()

func _test_bounded_effects() -> void:
	var main := PRACTICE.instantiate()
	root.add_child(main)
	main.player.skill_immunity_remaining = 1000.0
	var feedback := main.feedback as RunFeedback
	var count := feedback.get_child_count()
	for tick in range(1200):
		feedback.play(&"boss_kill", main.player.position)
		feedback.play(&"pickup", main.player.position)
		await _frames(1)
		_check(feedback.particles.size() <= RunFeedback.MAX_PARTICLES, "Particle bursts must remain bounded during sustained feedback")
	_check(feedback.get_child_count() == count and feedback.voices.size() == 8, "Repeated events must reuse the fixed voice pool and never create effect nodes")
	main.player.stop()
	await _frames(2)
	_check(feedback.particles.is_empty() and not feedback.screen_effect.visible, "Stopping gameplay must clear all pending visual feedback")
	main.free()

func _send(main: Node, action: StringName) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = true
	main._unhandled_input(event)

func _tap(action: StringName) -> void:
	Input.action_press(action)
	await _frames(1)
	Input.action_release(action)
	await _frames(1)

func _frames(count: int) -> void:
	for index in range(count):
		await physics_frame
		await process_frame

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error(message)
