# 雾岭断桥风格锚点 v01

- 日期：2026-10-26
- 工作流：内置 image_gen
- 用途：环境与材质风格评审，后续分层背景的参考；不是无缝背景图层。
- 目标文件：`art/style_guide/style_anchor.png`
- 选择说明：最终采用无角色、无钢索、无机关、无 UI 的环境稿；玩法对象单独制作，避免混入背景。
- 下方记录工具本次实际使用的提示词，同时保留 `.generated.prompt.txt` 原文。

```text
Use case: stylized-concept
Asset type: ENVIRONMENT-ONLY visual style anchor for an original 2D Eastern-fantasy side-scrolling game, landscape 16:9.
Primary request: Create a NEW clean environment keyframe for the level Fog Ridge Broken Bridge. This asset defines the world art style and will later guide separate parallax backgrounds. Match the restrained blue-grey, muted violet, moonlit ink-painting material language of the concept images in this conversation. Render ONLY THE ENVIRONMENT; this is not a gameplay screenshot or UI mockup.
Scene/backdrop: a vast mist-filled Chinese mountain gorge at night. Layered karst ridges recede into blue-grey haze. Sparse ruined roofed pavilions stand on far cliff edges, with an occasional weathered stone arch and thin waterfall. Dark bamboo silhouettes only at the extreme lower corners, never filling the middle play area. A pale crescent moon is visible high on the upper left. No red banners or red decorations anywhere.
Style/medium: original premium hand-painted 2D game art; controlled dry-ink contours, broad gouache-like color planes, faint paper texture in distant fog, crisp foreground silhouette and soft distant edges, moderate architectural detail. Intentionally simplify tiny vegetation and stone texture. Side-on landscape composition with layered depth, not a perspective corridor or a 3D render.
Composition/framing: very wide 16:9 composition. The middle and lower-middle horizontal band, from 58 to 84 percent of image height, is mostly open mist and low-contrast distant shapes, reserving a readable future gameplay corridor. Quiet upper edge for a later HUD and quiet lower corners for later touch controls. Do not draw any interface, portrait, frame, bar, button, symbol or number. Keep foreground cliffs confined to extreme margins.
Lighting/mood: soft moonlight consistently from upper left, calm tension, atmospheric depth, no dramatic black crush or heavy bloom.
Color palette: ink night #111827, mist blue #34495E, distant grey #6E7F8D, very muted violet haze, moonlight #DDE7E7; only tiny dim aged-brass architectural accents if needed. No cinnabar hazard color in this background asset.
Text (verbatim): ""
Constraints: environment ONLY. ZERO PEOPLE, ZERO RUNNERS, ZERO CABLES OR ROPES, ZERO SPIKES OR HAZARDS, ZERO COLLECTIBLES, ZERO UI. The gameplay cable, player, collectibles and hazards are separate assets that will be added later by the engine. Do not copy or repaint the full earlier gameplay screenshot.
Avoid: text, watermark, logos, interface, decorative red, busy foliage across the play corridor, strong high-contrast detail around the future rope lane, photorealism, 3D render, pixel art, neon colors, saturated cartoon style, character silhouette hidden in the scenery.
```
