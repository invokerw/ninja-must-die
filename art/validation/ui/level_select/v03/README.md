# 关卡选择页 · 通用体系完整布局 v03

- 界面 ID：`level_select`；创建 / 更新日期：2026-11-11。
- 当前状态：`visual_review_pending`；用户运行时视觉 / Android 实机待验收。
- 正式入口：F5 → 行前准备 → 关卡选择；返回准备按钮或 Esc 退出。
- 正式场景：`res://scenes/ui/level_select.tscn`；回归和截图复用该场景，无新增测试场景。

## 设计依据与改动范围

当前基线为 [v02 首次进入截图](../v02/runtime/level_select_1280_first.png)。v02 只迁移按钮、页签、状态和动态文字，仍沿用旧的两块大面板；用户于 2026-11-11 指出关卡选择尚未替换。

本次直接落实用户于 2026-11-06 审核通过的 [通用体系 04 关卡设计板](../../../../concepts/ui/common/v01/04_journey.png)，不另起视觉方向，不生成或替换新的候选位图。沿用该设计板的列表 / 中央驿灯 / 右侧详情 / 固定动作底栏；按真实业务适配两关和未开放的剧情。

- `UILevelCard` 扩展 `UISelectCard`：横幅插图、名称、真实纪录、通用星级及解锁 / 完成状态；选中与解锁、通关独立。
- `UIJourneyRoute`：目录驱动的节点和连线；点击驿灯可查看对应关卡，包括锁定关卡；节点不计算解锁或发奖。
- 详情复用 `UIDetailPanel / UITabBar`，长内容可滚动；余额和章节星数来自档案和正式纪录，旧版成绩不换算星数。
- “查看出战快照”复用通用弹层，可触摸查看最高分 / 最快 / 首次无伤单局，包含已记录的角色、武器、成绩、成长、秘卷、补给与规则版本；缺字段明确显示“未记录”。Esc 先关弹层，关闭恢复来源焦点。
- 返回、挑战、练习、剧情提示和保存重试使用 `UIActionButton`，保存异常与只读使用 `UIStatusChip`。
- 保留正式 / 练习、锁定、未保存奖励阻断、只读档案和旧纪录兼容。剧情仍未开放；本轮没有加入故事、角色选择或经济规则。

## 资源与保留理由

复用 `art/generated/ui/level_select/v01/` 的 `background_final.png`、`loop_04_overview_wide_illustration_panel.png` 和 `loop_02_roi_1_side_lantern.png`。插图以 Godot `AtlasTexture` 选取已有画面区域，不改原始像素、PSD 或 UID。两关继续共用原有已审核插图，未制作新的风竹渡专属图。

正式页已解除 `level_select_art.tscn` 和 `level_card_visual.gd` 的依赖。旧拼装场景、适配脚本及原分层资源暂留作旧版构图与图层对照；新版尚未获得用户运行时视觉验收，不在本切片提前删除历史资源。验收后再搜索实际依赖并清理失去用途的适配代码，保留来源与证据。

Windows / Android 正式导出继续排除 `tests/*`、`tools/*`、`art/validation/*`、`art/concepts/*` 等。正式页仅引用 `scripts/ui/`、目录 / 档案接口和 `art/generated/`，无调试目录依赖。

## 验证

设计坐标为 1280×720；检查 1600×720 和 `Rect2(60,24,1480,648)` 模拟安全区。卡片、路线和动作均为原生按钮，触摸目标至少 48×48；背景铺满视口，交互随安全框缩放。

2026-11-11 实际检查：

- 串行运行 `level_select / ui_components / stars_records / reward_transactions / touch_controls / ui_art_preview`：均退出 0，找到对应 PASS，最终保存日志无 `SCRIPT ERROR / ERROR:`；图形专项运行最新关卡回归与新增触摸 / 防穿透 / 待保存边界亦退出 0。
- `python3 -m unittest discover -s tests -p test_ci_export.py`：5 项通过；新文档链接检查与 `git diff --check` 通过。
- 真实 OpenGL 生成 [14 张运行时截图](runtime/README.md)，助手检查了首次 / 锁定 / 解锁、正式 / 旧版 / 空角色纪录、快照、只读、最大余额、保存失败、宽屏与安全区；未见明显文字裁切、相邻控件重叠或动作越界。快照长文使用原生滚动，关闭按钮固定可达。
- 机器摘要：[validation.json](validation.json)，回归日志位于 `logs/`，图形日志：[capture.log](capture.log)。最初沙箱内导入有系统证书 / Mono 编辑器服务及编辑器设置写入权限错误，未将该次导入记为无错误通过；后续具备权限的运行时回归和图形日志无上述错误。测试均使用隔离档案，未读写玩家正式存档。

用户概念审核沿用已通过的通用 04 板；本次运行时视觉和 Android 实机尚未验收，远端 CI 未运行。

复现（图形截图不要加 `--headless`）：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --always-on-top --path . --fixed-fps 60 --log-file /tmp/ninja-journey-capture.log --script res://tests/test_level_select.gd -- --capture-dir=res://art/validation/ui/level_select/v03/runtime
```
