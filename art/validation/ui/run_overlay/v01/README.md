# 暂停与结算通用 UI 迁移任务卡

- 界面 ID：`run_overlay`；版本：`v01`；日期：2026-11-09。
- 状态：`visual_review_pending`；用户运行时视觉与 Android 实机均待验收。
- 正式入口：`scenes/main.tscn`，由 `practice.tscn` / `boss_practice.tscn` 继承；未新增预览场景。
- 验收入口：F5 → 任一挑战 / 练习 → Esc 暂停；失败、通关、首领击破后进入同一结算面板。

## 依据、基线与范围

沿用用户于 2026-11-06 审核通过的[通用 UI v01](../../common/v01/README.md)，适配其中[07 弹层与设置](../../../../concepts/ui/common/v01/07_overlays.png)和[08 结算与重试](../../../../concepts/ui/common/v01/08_results.png)模板。当前界面基线见[原暂停](../../common/v01/baseline/pause_1280.png)、[原结算](../../common/v01/baseline/result_1280.png)。这是已审核模板在现有功能上的迁移，不新增独立视觉方向、位图或分层资源。

原界面在 `main.gd` 内拼装固定高度标签、设置、重试和保存入口，长身法说明与奖励统计会挤占操作区；按钮不参与键盘焦点。迁移新增 `UIRunPanel` 作为通用面板模板，复用 `PaintedTheme`、`UIActionButton`、`UIStatusChip`，由面板管理布局与焦点，主场景只绑定信号和真实数据：

- 840×568 设计面板，固定标题、当局配置、操作与存档区，中部说明 / 奖励可滚动；1280、1600 和模拟安全区均复用 `ScreenLayout`。
- 暂停突出“继续挑战”，显示当局角色、武器、秘卷和实际已消耗补给。配置取 `RunLoadout` 快照，不读取局外新选择；没有实际消耗时明确显示“未消耗补给”。
- 正式成绩使用 `UIStarRating` 原生填充 / 空心三星、实际分数及独立无伤文字；练习、失败和加载错误不套用正式星级。
- 原有统计与奖励明细在同一滚动区域切换，铜钱 / 余额摘要固定可见，动画与视图切换均不发奖。保存重试只提交既有草稿；奖励待保存时禁用新正式重试，保存成功恢复。只读档案不提供覆盖保存；状态变化会将焦点移到有效动作。
- Tab / 方向键在当前面板动作中循环；暂停初始焦点为继续，结算为重试，保存失败为保存重试。Enter 执行当前焦点按钮；R 继续沿用全局重试语义。
- 设置打开时隐藏父面板，关闭恢复暂停 / 结果及来源焦点；设置阻断后台触屏暂停和重试快捷键。全屏遮罩覆盖宽屏留白，控件留在安全区。

本批未实现重新携带补给、返回关卡新路由、独立伤害占比图或完整 HUD 重构；沿用已有重试默认不续带、返回准备和三种模式规则。原生命 / 冷却计时、判定、奖励公式和存档格式不变。删除失去用途的旧 `RetryHint` 节点，候选触屏预览继续保留，并改用通用按钮。

## 验证

`tests/test_ui_components.gd` 扩展真实触摸 / 键盘验证：安全初始焦点、Enter / Tab、设置 Esc 恢复和重试阻断、长文滚动与固定底部、真实三星 / 独立无伤、奖励切页不重复发放、保存失败与只读。触屏专项追加设置后台暂停键阻断；身法与触屏布局回归检查滚动视口的实际边界。

[本地完整回归](regressions.json)记录 19 套串行 GDScript、跨进程隔离存档写读、5 项 Python 导出检查。实际图形捕获复用正式场景与 `TestProfileScope`，不读写玩家正式档案；首领结果使用注入用时 / 影晶 / 剩余生命后的真实技能击破流程，练习与失败走对应原有回调，不把截图当作全关手感验收。

[11 张实际截图](runtime/README.md)覆盖暂停、宽屏、安全区、设置、正式通关、奖励、保存失败、失败、跑酷练习、首领练习和只读。助手截图检查与自动回归独立记录于 [validation.json](validation.json)。图形检查通过不代表用户视觉或 Android 通过；远端 CI 未运行。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --fixed-fps 60 \
  --log-file /tmp/ninja-ui-run-components.log --script res://tests/test_ui_components.gd

# 图形截图省略 --headless，追加：
# -- --capture-run-dir=res://art/validation/ui/run_overlay/v01/runtime
```

公共组件、回归和正式场景长期保留；没有临时脚本 / 场景进入运行时。验证材料仍由 Windows / Android 两个导出预设排除。

最终资源导入退出 0、无脚本解析错误；编辑器退出仍有既有 `EditorSettings not instantiated yet ... shutdown_adb_on_exit` 诊断。无显示回归日志保留本机 `get_system_ca_certificates` 环境提示，不将它们记为脚本失败或宣称整个编辑器日志无错误。
