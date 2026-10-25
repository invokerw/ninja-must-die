class_name FeedbackSettings
extends RefCounted

# Runtime values are loaded once from PlayerProfile and applied immediately.
static var sound_enabled := true
static var particles_enabled := true
static var shake_enabled := true
static var flash_enabled := true

static func defaults() -> Dictionary:
	return {"sound": true, "particles": true, "shake": true, "flash": true}

static func snapshot() -> Dictionary:
	return {"sound": sound_enabled, "particles": particles_enabled, "shake": shake_enabled, "flash": flash_enabled}

static func apply(settings: Dictionary) -> void:
	sound_enabled = settings.get("sound", true)
	particles_enabled = settings.get("particles", true)
	shake_enabled = settings.get("shake", true)
	flash_enabled = settings.get("flash", true)
