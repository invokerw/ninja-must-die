# UI v02 组件候选

从已验证的 40 层 PSD 中整理出 **5 个操作按钮 × 底板 / 图标，共 10 张透明 PNG**。文件逐字节复制，未修改 RGB、alpha 或原始 PSD；来源图层、位置、尺寸与 SHA-256 见 [manifest.json](manifest.json)。完整候选 PSD 在 [source/layers.psd](source/layers.psd)。

状态：`preview_ready: true`、`runtime_ready: false`，用户视觉验收待进行。这里只提供常态图片；按下、禁用、冷却圆弧与数值由 Godot 实时绘制。金属倒角、铆钉与柔光等模型重绘差异仍保留。

2026-10-27 调整按钮内的“禁用 / 首领战”状态文字：96 像素按钮中的字号由 12 增至 17 像素，文字和冷却数字按完整圆形按钮居中，短状态使用深蓝底、细金边和暖色文字。前后对比及新截图见统一检查页的“UI 组件预览”；触摸回归再次通过。

## 游戏内预览

在 Godot 打开 [ui_touch_preview.tscn](../../../scenes/art/ui_touch_preview.tscn) 按 F6。预览复用现有多指、键盘、翻绳、跳跃和战斗逻辑，默认开启触屏按钮；也可切到首领预览检查武器技能。左侧下方跳跃禁用，空中翻绳键快速下落。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . res://scenes/art/ui_touch_preview.tscn
```

预览场景不会记录通关成绩。准备页和默认主场景仍使用原有 UI；Windows / Android 导出配置排除了本候选包、预览场景与脚本。它们在单独验收后再决定如何正式接入。

## 图层选择

| 动作 | 底板 | 图标 |
| --- | --- | --- |
| 跳跃 | `textures/jump_only_plate.png` | `textures/jump_only_icon.png` |
| 翻绳 / 空中快速下落 | `textures/rope_flip_plate.png` | `textures/rope_flip_icon.png` |
| 影步 | `textures/dash_plate.png` | `textures/dash_icon.png` |
| 弦月轮 | `textures/weapon_plate.png` | `textures/weapon_icon.png` |
| 月蚀斩 | `textures/skill_plate.png` | `textures/skill_icon.png` |

贯星矛使用现有 `WeaponArt` 矢量图形表达武器身份，待单独制作配套图片。重复节点的进度横轨与节点 PNG 不进入本包，预览由一个 Godot 控件绘制进度线与四个节点。钢索及两端固定件、角色、背景和栅格数值也不在本批组件中；原始 PSD 的对应视觉问题没有被改写或掩盖。

导出命令：`python3 tools/art/export_ui_candidate.py`。它要求本机原始 workbench 任务完整且校验匹配；已整理的候选包可独立用于本项目预览。

验证记录见 [preview_validation.json](preview_validation.json)。全套触摸行为回归复用 `tests/test_touch_controls.gd`，增加底部安全区文字边界检查；图形验证包含 1280×720 上侧、下侧、空中按下与 1600×720 冷却状态。Android 实机尚未验证。
