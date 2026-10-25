class_name RunFeedback
extends Node2D

signal cue_played(cue: StringName)

const MAX_PARTICLES := 192
const MAX_VOICES := 8
const STREAMS := {
	&"jump": preload("res://audio/sfx/jump.wav"),
	&"air_jump": preload("res://audio/sfx/air_jump.wav"),
	&"flip": preload("res://audio/sfx/flip.wav"),
	&"land": preload("res://audio/sfx/land.wav"),
	&"dash": preload("res://audio/sfx/dash.wav"),
	&"pickup": preload("res://audio/sfx/pickup.wav"),
	&"skill": preload("res://audio/sfx/skill.wav"),
	&"strike": preload("res://audio/sfx/strike.wav"),
	&"hit": preload("res://audio/sfx/hit.wav"),
	&"impact": preload("res://audio/sfx/hit.wav"),
	&"weak_hit": preload("res://audio/sfx/hit.wav"),
	&"armor_hit": preload("res://audio/sfx/guard.wav"),
	&"weapon_cast": preload("res://audio/sfx/volley.wav"),
	&"dart_pickup": preload("res://audio/sfx/pickup.wav"),
	&"guard": preload("res://audio/sfx/guard.wav"),
	&"kill": preload("res://audio/sfx/kill.wav"),
	&"warning_top": preload("res://audio/sfx/warning_top.wav"),
	&"warning_bottom": preload("res://audio/sfx/warning_bottom.wav"),
	&"volley": preload("res://audio/sfx/volley.wav"),
	&"boss_enter": preload("res://audio/sfx/boss_enter.wav"),
	&"boss_enrage": preload("res://audio/sfx/boss_enter.wav"),
	&"sweep": preload("res://audio/sfx/sweep.wav"),
	&"weakpoint": preload("res://audio/sfx/weakpoint.wav"),
	&"boss_kill": preload("res://audio/sfx/boss_kill.wav"),
	&"ready": preload("res://audio/sfx/ready.wav"),
	&"clear": preload("res://audio/sfx/clear.wav"),
	&"fail": preload("res://audio/sfx/fail.wav"),
}
const SCREEN_SHADER := """shader_type canvas_item;
uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_nearest;
uniform vec2 shake_px = vec2(0.0);
uniform vec4 flash_color : source_color = vec4(0.0);
void fragment() {
	vec2 uv = clamp(SCREEN_UV + shake_px * SCREEN_PIXEL_SIZE, vec2(0.001), vec2(0.999));
	vec3 scene = texture(screen_texture, uv).rgb;
	COLOR = vec4(mix(scene, flash_color.rgb, flash_color.a), 1.0);
}
"""

var particles: Array[Dictionary] = []
var voices: Array[AudioStreamPlayer] = []
var ui_voice: AudioStreamPlayer
var screen_effect: ColorRect
var shake_remaining := 0.0
var flash_remaining := 0.0
var shake_offset := Vector2.ZERO
var _shake_strength := 0.0
var _flash_color := Color.TRANSPARENT
var _clock := 0.0
var _cooldowns: Dictionary = {}
var _voice_priorities: Array[int] = []
var _finished := false
var _player: PlayerController
var audio_output_enabled := false

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	# Fast headless simulations have no output mixer to drain queued playback on exit.
	audio_output_enabled = DisplayServer.get_name() != "headless"
	z_index = 50
	for index in range(MAX_VOICES):
		var voice := AudioStreamPlayer.new()
		voice.process_mode = Node.PROCESS_MODE_ALWAYS
		add_child(voice)
		voices.append(voice)
		_voice_priorities.append(0)
	ui_voice = AudioStreamPlayer.new()
	ui_voice.process_mode = Node.PROCESS_MODE_ALWAYS
	ui_voice.volume_db = -10.0
	add_child(ui_voice)
	var layer := CanvasLayer.new()
	layer.layer = 2
	add_child(layer)
	screen_effect = ColorRect.new()
	screen_effect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	screen_effect.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var material := ShaderMaterial.new()
	var shader := Shader.new()
	shader.code = SCREEN_SHADER
	material.shader = shader
	screen_effect.material = material
	layer.add_child(screen_effect)
	screen_effect.hide()

func bind_player(player: PlayerController) -> void:
	_player = player
	player.feedback_requested.connect(play)
	player.stopped.connect(_on_stopped)
	player.run_failed.connect(func(_reason: String) -> void: finish(false))

func play(cue: StringName, position: Vector2 = Vector2.ZERO) -> void:
	if _finished or get_tree().paused or not STREAMS.has(cue):
		return
	if is_instance_valid(_player) and not _player.active:
		return
	if float(_cooldowns.get(cue, 0.0)) > 0.0:
		return
	_cooldowns[cue] = 0.18 if cue == &"guard" else (0.06 if cue in [&"pickup", &"kill"] else 0.025)
	cue_played.emit(cue)
	_play_sound(cue)
	if FeedbackSettings.particles_enabled:
		_spawn_particles(cue, position)
	if cue in [&"hit", &"impact", &"kill", &"strike", &"boss_kill"]:
		if FeedbackSettings.shake_enabled:
			shake_remaining = 0.30 if cue == &"boss_kill" else 0.16
			_shake_strength = 5.0 if cue == &"boss_kill" else (3.0 if cue == &"hit" else 1.8)
		if FeedbackSettings.flash_enabled and cue in [&"hit", &"boss_kill"]:
			flash_remaining = 0.16
			_flash_color = Color("b24b4b") if cue == &"hit" else Color("d8b56a")

func _play_sound(cue: StringName) -> void:
	if not FeedbackSettings.sound_enabled:
		return
	var priority := 2 if cue in [&"warning_top", &"warning_bottom", &"boss_enter", &"boss_enrage", &"hit", &"boss_kill"] else 1
	var selected := -1
	for index in range(voices.size()):
		if not voices[index].playing:
			selected = index
			break
	if selected < 0:
		for index in range(voices.size()):
			if _voice_priorities[index] < priority:
				selected = index
				break
	if selected < 0:
		return
	var voice := voices[selected]
	voice.stop()
	voice.stream = STREAMS[cue]
	voice.volume_db = -12.0 if priority == 2 else (-19.0 if cue == &"pickup" else -16.0)
	voice.pitch_scale = 1.25 if cue == &"boss_enrage" else 1.0
	if audio_output_enabled:
		voice.play()
	_voice_priorities[selected] = priority

func _spawn_particles(cue: StringName, position: Vector2) -> void:
	var count := 0
	var tint := Color("d8b56a")
	match cue:
		&"jump", &"air_jump", &"flip", &"land": count = 7
		&"dash": count = 12
		&"pickup", &"ready", &"dart_pickup": count = 10
		&"weak_hit", &"weapon_cast": count = 6
		&"armor_hit":
			count = 5
			tint = Color("dde7e7")
		&"skill", &"strike", &"weakpoint", &"impact": count = 18
		&"guard":
			count = 10
			tint = Color("dde7e7")
		&"hit", &"kill":
			count = 20
			tint = Color("b24b4b")
		&"boss_kill": count = 48
		&"boss_enrage":
			count = 28
			tint = Color("f08b68")
	if count == 0:
		return
	# Deterministic visual spread uses no gameplay random state or scene nodes.
	for index in range(count):
		if particles.size() >= MAX_PARTICLES:
			particles.pop_front()
		var angle := float(index) * 2.399963 + _clock * 0.7
		var speed := 65.0 + float((index * 37) % 130)
		var motion := Vector2.from_angle(angle) * speed + Vector2(120.0, -55.0)
		if cue == &"dash":
			motion = Vector2(-260.0 - float(index * 16), sin(angle) * 90.0)
		var lifetime := 0.3 + float(index % 5) * 0.055
		particles.append({"position": position, "velocity": motion, "remaining": lifetime, "lifetime": lifetime, "color": tint, "radius": 2.0 + float(index % 3)})

func _process(delta: float) -> void:
	var suspended := get_tree().paused and not _finished
	for voice in voices:
		voice.stream_paused = suspended
	if suspended:
		return
	_clock += delta
	for cue in _cooldowns:
		_cooldowns[cue] = maxf(float(_cooldowns[cue]) - delta, 0.0)
	for index in range(particles.size() - 1, -1, -1):
		var particle := particles[index]
		particle.remaining -= delta
		if particle.remaining <= 0.0:
			particles.remove_at(index)
			continue
		particle.position += particle.velocity * delta
		particle.velocity.y += 210.0 * delta
	shake_remaining = maxf(shake_remaining - delta, 0.0)
	flash_remaining = maxf(flash_remaining - delta, 0.0)
	shake_offset = Vector2(sin(_clock * 113.0), cos(_clock * 97.0)) * _shake_strength * minf(shake_remaining / 0.16, 1.0)
	var material := screen_effect.material as ShaderMaterial
	material.set_shader_parameter("shake_px", shake_offset)
	material.set_shader_parameter("flash_color", Color(_flash_color, 0.12 * minf(flash_remaining / 0.16, 1.0)))
	screen_effect.visible = shake_remaining > 0.0 or flash_remaining > 0.0
	queue_redraw()

func apply_settings() -> void:
	if not FeedbackSettings.sound_enabled:
		for voice in voices:
			voice.stop()
		ui_voice.stop()
	if not FeedbackSettings.particles_enabled:
		particles.clear()
	if not FeedbackSettings.shake_enabled:
		shake_remaining = 0.0
		shake_offset = Vector2.ZERO
	if not FeedbackSettings.flash_enabled:
		flash_remaining = 0.0
	var material := screen_effect.material as ShaderMaterial
	material.set_shader_parameter("shake_px", shake_offset)
	if not FeedbackSettings.flash_enabled:
		material.set_shader_parameter("flash_color", Color.TRANSPARENT)
	screen_effect.visible = shake_remaining > 0.0 or flash_remaining > 0.0
	queue_redraw()

func _on_stopped() -> void:
	for voice in voices:
		voice.stop()
	particles.clear()
	shake_remaining = 0.0
	flash_remaining = 0.0
	shake_offset = Vector2.ZERO
	screen_effect.hide()
	queue_redraw()

func finish(success: bool) -> void:
	if _finished:
		return
	_on_stopped()
	_finished = true
	if FeedbackSettings.sound_enabled:
		ui_voice.stream = STREAMS[&"clear" if success else &"fail"]
		if audio_output_enabled:
			ui_voice.play()

func _draw() -> void:
	for particle in particles:
		var tint: Color = particle.color
		tint.a = float(particle.remaining) / float(particle.lifetime)
		var local_position := to_local(particle.position)
		draw_line(local_position, local_position - Vector2(particle.velocity) * 0.025, tint, float(particle.radius))

func _exit_tree() -> void:
	for voice in voices:
		voice.stop()
		voice.stream = null
	if is_instance_valid(ui_voice):
		ui_voice.stop()
		ui_voice.stream = null
