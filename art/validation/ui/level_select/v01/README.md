# 关卡选择页 UI 任务卡

- 界面 ID：`level_select`
- 版本：`v01`
- 当前状态：`visual_review_pending`
- 负责人 / 审核人：助手完成拼装与检查；用户审核概念及分层资源
- 创建日期：2026-10-30

## 功能与入口

- 用途：展示第一章关卡目录、正式纪录和当前出战配置，并进入正式挑战或练习。
- 进入入口：角色与武器准备页的“开始”流程。
- 返回 / 退出入口：返回角色与武器准备页。
- 正式场景：`res://scenes/ui/level_select.tscn`
- 预览入口：后续复用正式场景和 `tools/run_sandbox.gd`，暂不新增独立预览场景。

## 当前 UI 基线

- 基线截图：待补；离屏 Godot dummy 渲染器无法导出可靠纹理，本轮以现有代码布局作为基线。
- 截图日期、分辨率、触屏模式：待记录；设计坐标为 1280×720。
- 当前实现问题：现有界面为代码拼装的灰盒样式，面板、按钮和关卡条目使用通用主题，尚未完成专属视觉方向。
- 必须保留的控件 / 交互：关卡选择、锁定提示、正式纪录、开始挑战、进入练习、重看剧情、返回准备页。

## 设计约束

- 必须支持的状态：首次进入、选中、禁用、锁定、无纪录、已有纪录、加载失败、触屏安全区。
- 设计坐标 / 目标比例：1280×720；兼容宽屏和触屏安全区。
- 最小触摸尺寸：沿用触屏控件规范，按钮命中区域不得小于现有项目标准。
- 动态字段（由 Godot 绘制）：关卡标题、解锁状态、纪录、收集数量、当前角色 / 武器、提示和错误信息。
- 视觉目标与禁止事项：突出章节路线和当前关卡；不把纪录、解锁条件或动态提示烘焙进图片。

## 概念图与审核

- 概念图：`art/concepts/ui/level_select/v01.png`
- 提示词：`art/prompts/ui/level_select/v01.prompt.md`
- 参考截图 / 设计锚点：`art/style_guide/style_anchor.png`、`art/concepts/ui_top_hud_open_v01.png`、`art/concepts/ui_touch_combat_design_v02.png`、`docs/ART_DIRECTION.md`、`docs/TOUCH_CONTROLS.md`。
- 用户审核状态：`approved`
- 审核日期：2026-11-02
- 用户反馈：概念图审核通过，并明确授权将 `art/concepts/ui/level_select/v01.png` 发送到已配置的分层模型服务。

## 资源与拼装

- 分层资源：`art/layered/ui/level_select/v01/`（候选，`needs_review`，尚未接入运行时）
- 运行时资源：`art/generated/ui/level_select/v01/`，41 张独立贴图及来源、尺寸、alpha 边界清单；已获用户分层资源审核授权接入。
- 资源清单 / 检查报告：`art/layered/ui/level_select/v01/manifest.json`、`art/layered/ui/level_select/v01/verification.json`
- 2026-11-04 完整候选：`art/layered/ui/level_select/v01/run06/`，含 67 层 PSD、独立 PNG、清单、结构校验和助手视觉记录；历史部分提取不覆盖。
- Godot 拼装入口：`res://scenes/ui/level_select.tscn`
- 拼装：`res://scenes/ui/level_select_art.tscn` 复用正式页，按 1672×941 来源坐标映射到 1280×720；两张关卡插图沿用审核资源。动态标题、纪录、锁定、选中、禁用与按钮文字由 Godot 绘制，不显示概念图虚构评级；挑战/练习/剧情按钮与返回继续使用标准 Button。

## 功能与验收

- 自动回归：2026-11-04 串行运行 `test_level_select`、`test_touch_controls`、`test_ui_art_preview`，退出码均为 0，分别获得 `LEVEL_SELECT_PASS`、`TOUCH_PASS`、`TOUCH_PASS`。关卡选择覆盖准备入口、真实触摸选中/切回、禁用按钮拒绝触摸启动、锁定提示、锁定图层消隐、无纪录、解锁、正式/练习真实跳转、剧情未开放提示及 Esc 返回。
- 助手截图检查与路径：2026-11-04 已比较源图与 `run06/recomposed.png` 的 760px 整图预览，并检查原始图集及圆形独立图层；发现大插图月亮及山景、部分图标和面板的模型重绘差异。记录见 `art/layered/ui/level_select/v01/run06/visual_review.json`。尚未完成 Godot 拼装截图检查。
- 用户视觉审核：2026-11-04 分层资源已审核通过（“审核通过了，继续吧”）；Godot 运行时画面尚待用户审核，不能将资源审核等同为运行时验收。
- Android 实机审核：待进行。
- 当前交付状态：`visual_review_pending`
- 分层验证：2026-11-04 恢复 `run06` 完成 5 个视觉轮次，67 层 PSD 回读成功，图层 RGBA、合成图及透明洞链验证通过；无动态文字，文字层为 0。原像素恢复不适用，不建立像素一致性。耗时包含跨日等待与历史失败，不能作为单次生成耗时。
- 未解决问题：分层重绘差异已由用户接受。已完成正式 Godot 拼装和助手截图检查；运行时视觉与 Android 实机待验收。剧情播放和正式奖励沿用后续切片边界，按钮提供“暂未开放”提示。

## Godot 实际画面 · 2026-11-04

- `runtime/level_select_1280_first.png`：首次进入、无纪录、第一关选中。
- `runtime/level_select_1280_locked.png`：第二关锁定、前置条件、禁用挑战和练习。
- `runtime/level_select_1600_unlocked.png`：1600×720 宽屏、第一关已完成、第二关解锁且锁图层消隐；安全设计框居中。
- 使用真实 OpenGL 图形渲染，SubViewport 实例化正式关卡选择页；TestProfileScope 隔离档案，不改玩家正式存档。
- 助手检查：文字可读、卡片命中区位于安全设计框内，选中/锁定/解锁状态与数据一致。该结果不代表 Android 实机通过。

重新截图（不要加 `--headless`）：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . --fixed-fps 60 --log-file /tmp/ninja-level-select-capture.log --script res://tests/test_level_select.gd -- --capture-dir=res://art/validation/ui/level_select/v01/runtime
```

没有新增测试场景；自动测试和截图复用正式 `level_select.tscn`，`level_select_art.tscn` 是正式运行时组件。两个导出预设均包含全部 41 张运行时贴图、排除 tests/tools/art/layered/art/validation；正式页无这些排除目录的资源依赖。

## 局部居中修复 · 2026-11-05

根据用户红框反馈调整正式布局，不修改原始 PSD 或贴图像素：

- 关卡标题限制在铭牌文字区内，水平、垂直居中；铭牌适配标题长度，保留左侧徽章空间。
- 锁芯按可见轮廓与外圈同心；三行纪录分别与对应图标共用中心线，最高分移至右栏下方，避免挤占第三行。
- 三个底部按钮图标统一可见高度和中心线；文字在扣除图标占位后的区域居中，正常、悬停、按下、禁用、焦点状态使用一致边距。
- 挑战目标文字在右栏居中，各行与最高分保留间距。

验证：无显示关卡选择回归与真实 OpenGL 截图运行均退出 0，输出 `LEVEL_SELECT_PASS`。触摸测试直接向所属视口注入真实 `InputEventScreenTouch`，消除桌面窗口焦点及屏幕缩放对测试坐标的干扰，继续验证选中、禁用拒绝启动、解锁、跳转及返回。

最新截图保存在 `alignment_fix/`：`level_select_1280_first.png`、`level_select_1280_locked.png`、`level_select_1280_record.png`、`level_select_1600_unlocked.png`。助手已逐一检查无纪录、锁定、有纪录及宽屏画面；用户对本次运行时修复的视觉审核和 Android 实机验收仍待进行。此前 `runtime/` 截图保留为修改前证据。

复现命令：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . --fixed-fps 60 --log-file /tmp/ninja-level-select-alignment.log --script res://tests/test_level_select.gd -- --capture-dir=res://art/validation/ui/level_select/v01/alignment_fix
```

提交前独立检查（2026-11-05）：使用暂存区内容导出临时快照，串行运行 `rope_landing`、`rope_pickups`、`level_route`、`mobility`、`combat`、`projectiles`、`boss`、`feedback`、`weapons`、`save`、`touch_controls`、`player_art`、`ui_art_preview`、`level_select`、`wind_bamboo`，全部获得对应 PASS 且退出 0；5 项 Python 导出测试和独立进程 `PROFILE_WRITE_PASS` / `PROFILE_RELOAD_PASS` 通过。该检查不包含远端 CI 或 Android 实机。
