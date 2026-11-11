class_name UITokens
extends RefCounted

# Runtime source of the approved moon-ink-gold palette. No dependency on art/concepts.
const INK := Color("#111827")
const SURFACE := Color("#192536")
const SURFACE_RAISED := Color("#233448")
const TEXT_PRIMARY := Color("#dde7e7")
const TEXT_SECONDARY := Color("#9aaeb8")
const ACCENT := Color("#d8b56a")
const ACCENT_LIGHT := Color("#f0d39b")
const DANGER := Color("#b24b4b")
const DANGER_TEXT := Color("#f1aaa1")
const DISABLED := Color("#73818d")
const BORDER_NEUTRAL := Color("#526372")

const FONT_SIZES := {
	&"brand": 40, &"page_title": 34, &"section_title": 26, &"action": 22,
	&"body": 20, &"secondary": 18, &"caption": 16, &"metric": 32,
}
const SPACING := [4, 8, 12, 16, 24, 32, 48]
const CORNER_RADIUS := 6
const PANEL_PADDING := 24
const TOUCH_MIN := Vector2(48, 48)
const PRIMARY_SIZE := Vector2(216, 56)
const SECONDARY_SIZE := Vector2(160, 52)
const MODAL_DIMMER := Color(0.025, 0.04, 0.07, 0.88)
