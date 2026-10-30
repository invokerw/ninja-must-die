extends SceneTree

const MODES := {
	"parkour": "res://scenes/practice.tscn",
	"boss": "res://scenes/boss_practice.tscn",
	"full": "res://scenes/main.tscn",
}
const USAGE := "--script res://tools/run_sandbox.gd -- [--character=shadow_runner|wind_scout|thunder_guard] [--mode=parkour|boss|full] [--touch]"

var _profile_scope: TestProfileScope

func _initialize() -> void:
	_start.call_deferred()

func _start() -> void:
	var character_id: StringName = &"shadow_runner"
	var mode := "parkour"
	var touch := false
	for argument in OS.get_cmdline_user_args():
		if argument == "--help":
			print(USAGE)
			quit()
			return
		elif argument.begins_with("--character="):
			character_id = StringName(argument.trim_prefix("--character="))
		elif argument.begins_with("--mode="):
			mode = argument.trim_prefix("--mode=")
		elif argument == "--touch":
			touch = true
		else:
			push_error("Unknown sandbox option: %s\n%s" % [argument, USAGE])
			quit(1)
			return
	if CharacterRegistry.get_character(character_id) == null or not MODES.has(mode):
		push_error("Unknown sandbox character or mode.\n%s" % USAGE)
		quit(1)
		return
	# Keep the scope alive across scene changes, retries and return to preparation.
	_profile_scope = TestProfileScope.new("manual-%d" % OS.get_process_id())
	TouchControls.preview_enabled = touch
	var scene := create_run(character_id, mode)
	root.add_child(scene)
	current_scene = scene
	print("SANDBOX_READY character=%s mode=%s isolated_profile=true" % [character_id, mode])

static func create_run(character_id: StringName, mode: String = "parkour") -> Node2D:
	var character := CharacterRegistry.get_character(character_id)
	if character == null or not MODES.has(mode):
		return null
	var scene := (load(MODES[mode]) as PackedScene).instantiate() as Node2D
	scene.run_loadout = PlayerProfile.current().resolve(character)
	return scene

func _finalize() -> void:
	if _profile_scope != null:
		_profile_scope.close()
