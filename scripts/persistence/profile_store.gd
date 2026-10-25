class_name ProfileStore
extends RefCounted

const VERSION := 1

static func read(path: String) -> Dictionary:
	var primary := _read_file(path)
	if primary.valid:
		return {"document": primary.document, "notice": ""}
	var backup := _read_file(path + ".bak")
	if backup.valid:
		return {"document": backup.document, "notice": "存档异常，已恢复上次保存。"}
	return {"document": {}, "notice": "存档无法读取，已使用默认配置。" if FileAccess.file_exists(path) else ""}

static func is_newer(document: Dictionary) -> bool:
	return float(document.get("version", VERSION)) > VERSION

static func write(path: String, document: Dictionary) -> bool:
	var temporary := path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(JSON.stringify(document, "\t"))
	file.flush()
	var error := file.get_error()
	file.close()
	if error != OK:
		return false
	var primary := _read_file(path)
	# Keep a known valid generation; never replace it with damaged input.
	if primary.valid and is_newer(primary.document):
		return false
	var backup_source := path if primary.valid else temporary
	if not primary.valid and FileAccess.file_exists(path):
		if _copy(path, path + ".corrupt") != OK:
			return false
	if primary.valid or not _read_file(path + ".bak").valid:
		if _copy(backup_source, path + ".bak.tmp") != OK or _rename(path + ".bak.tmp", path + ".bak") != OK:
			return false
	return _rename(temporary, path) == OK

static func _read_file(path: String) -> Dictionary:
	var invalid := {"valid": false, "document": {}}
	if not FileAccess.file_exists(path):
		return invalid
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return invalid
	var parser := JSON.new()
	var error := parser.parse(file.get_as_text())
	file.close()
	if error != OK:
		return invalid
	var parsed: Variant = parser.data
	if not parsed is Dictionary:
		return invalid
	var version: Variant = parsed.get("version", VERSION)
	if not (version is int or version is float) or not is_finite(float(version)) or float(version) < 0.0 or float(version) != floorf(float(version)):
		return invalid
	return {"valid": true, "document": parsed}

static func _copy(source: String, destination: String) -> Error:
	return DirAccess.copy_absolute(ProjectSettings.globalize_path(source), ProjectSettings.globalize_path(destination))

static func _rename(source: String, destination: String) -> Error:
	return DirAccess.rename_absolute(ProjectSettings.globalize_path(source), ProjectSettings.globalize_path(destination))
