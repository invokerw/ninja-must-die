# 行前准备 UI 任务卡

- 界面 ID / 版本：`character_setup` / `v01`；日期：2026-11-06。
- 概念：已审核通过的通用 UI v01 之 02 / 03 板；运行时状态：`visual_review_pending`；`runtime_ready: false`。
- 负责人：Codex；审核人：用户。

## 功能与入口

F5 → `scenes/ui/character_setup.tscn`，标题“行前准备”。保留关卡选择、首领练习、跑酷练习、山路行商、设置和重试保存；武器预览与装备分开。新增的页签只是组织已有数据：秘卷 / 补给显示真实配置及调整入口，纪录仍是雾岭断桥原有的三个独立模式。

## 基线与概念依据

- 改版前正式场景截图：[准备页基础样式](../../common/v01/runtime/foundation/setup_1280.png)，1280×720、2026-11-06、隔离档案。更早的原始基线继续保留在通用 UI 任务卡。
- 原问题：武器只有横向文字按钮，预览 / 已装备混在按钮文字；角色说明与三个常驻历史卡使页面拥挤，缺少页签 / 详情通用组件。
- 概念：[02 通用卡片](../../../../concepts/ui/common/v01/02_composites.png)、[03 行前准备](../../../../concepts/ui/common/v01/03_preparation.png)；[提交提示词](../../../../prompts/ui/common/v01/generation.prompt.md)。
- 用户于 2026-11-06 明确回复 **“可以审核通过按照这个来吧”**，通过通用 UI 方向；后续“继续”授权按同一规范推进本切片。概念通过不等于本页运行时验收通过。
- 功能适配：只展示当前正式角色，不提供未完成角色 / 大立绘；使用两列“当前角色 + 装备与纪录”，保留原有练习入口。复用正式头像 / 武器图，不放大候选角色立绘或把概念图作为背景。

## 通用资源与状态

- 新增可复用 `UISelectCard / UITabBar / UIDetailPanel`，扩展 `UIStatusChip.preview`；其余复用 `UITokens / PaintedTheme / UIActionButton / FeedbackSettingsPanel`。
- 无新正式图片、分层素材或 `.tscn`。卡片图标沿用 `art/generated/ui/portrait.png` 与 `art/generated/combat/` 现有纹理，素材 / 文字分离。
- 支持首次空纪录、武器选中 / 预览 / 已装备、重复选择、切页保留预览、明确装备与保存失败重试、秘卷 / 补给真实数量、旧纪录 / 正式星级 / 练习隔离、较新档案只读、设置遮罩 / 键盘焦点、宽屏安全区。
- 控件接入 / 扩展 API：[统一规范第 11 节](../../../../../docs/UI_DESIGN_SYSTEM.md#11-第二批卡片页签与行前准备)。
- 1280×720 设计框，1600×720 宽屏与 `Rect2(60,24,1480,648)` 安全区；按钮不小于 48，卡片最低 140，长说明放滚动详情。

## 验证与截图

- 公共回归：`tests/test_ui_components.gd`；新增触摸 / 键盘切页、反复选中、锁定卡可查看、预览与装备分离、库存查看不消耗、只读禁止装备，以及设置焦点转入 / 循环 / 恢复。
- 卡片初次入树的状态标识溢出与图片纵向扩张已修复；图片槽固定 72×72，标签 / 图片边界已纳入无显示及图形回归。
- [实际截图图册](../../common/v01/runtime/preparation/README.md)、[本地回归摘要](../../common/v01/preparation_regressions.json)；截图均为正式准备页、隔离档案、未编辑像素。
- 本地完整 19 套回归全部退出 0、对应 PASS 且无错误；跨进程隔离档案先写后读通过，Python 导出检查 5 项通过。最终布局另完成图形 UI 专项，退出 0、`UI_COMPONENTS_PASS`、无错误；最后追加有效正式快照和末项滚动可达验证也通过。
- 助手已检查 10 张实际状态截图：卡片图片 / 标签在边界内，预览 / 装备独立，保存重试不遮挡携带摘要，设置有清楚焦点，宽屏内容位于安全框。纪录区按设计滚动，视窗外文本正常裁切。
- 自动回归、助手截图、用户视觉及 Android 的实际结果以该摘要和图册为准；用户运行时视觉 / Android 仍待验收。

```sh
godot_bin=/Applications/Godot_mono.app/Contents/MacOS/Godot
"$godot_bin" --headless --path . --fixed-fps 60 \
  --log-file /tmp/ninja-ui-preparation-components.log --script res://tests/test_ui_components.gd
# 实际截图：省略 --headless，追加：
# -- --capture-preparation-dir=/绝对路径/截图目录
```

## 保留与后续

正式准备场景与公共回归继续保留，无临时测试场景 / 入口。测试档案在 scope 结束时清理；概念、历史截图和本次截图保留可复核证据。

当前未实现正式多角色选择、其他角色立绘 / 专属技能、在准备页重复购买 / 消费、独立背包或完整快照纪录页。它们按各自功能切片继续，不能据此把所有通用模板记为完成。
