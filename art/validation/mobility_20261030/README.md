# 阶段 A 验证 · 2026-10-30

环境：macOS、Godot 4.7 stable mono、1280×720 图形渲染及固定 60 FPS 无显示回放。

- 13 套 GDScript 回归全部通过：`rope_landing`、`rope_pickups`、`level_route`、`mobility`、`combat`、`projectiles`、`boss`、`feedback`、`weapons`、`save`、`touch_controls`、`player_art`、`ui_art_preview`。
- 跨进程档案检查通过：`PROFILE_WRITE_PASS`、`PROFILE_RELOAD_PASS`。
- 导出元数据 Python 单测 5 项通过；两个现有美术渲染脚本通过 Godot `--check-only`。
- 三名角色分别以基础主路线完成约 95.90 秒完整关卡，0 受击、50 / 50 影晶；另验证影刃身法第三跳替代路线。
- 已图形渲染并检查下方六张图片：角色按钮名称、未满足条件提示和暂停说明无重叠，内容位于操作区与暂停面板内。新角色复用现有立绘 / 头像，仅角色本体占位着色；共用忍术标记为灰盒。

| 角色 | 触屏操作 | 暂停说明 |
| --- | --- | --- |
| 影刃 | [操作](shadow_runner_controls.png) | [暂停](shadow_runner_pause.png) |
| 岚织 | [操作](wind_scout_controls.png) | [暂停](wind_scout_pause.png) |
| 烬锋 | [操作](thunder_guard_controls.png) | [暂停](thunder_guard_pause.png) |

复现单套回归：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --fixed-fps 60 --log-file /tmp/ninja-mobility.log --script res://tests/test_mobility.gd
```

Windows 发布 CI 已纳入 `mobility` 专项，本次未触发远端发布。Android 实机、多指手感和真人平衡验收仍待进行。

场景整理补验：两个按角色复制的包装场景已由 `tools/run_sandbox.gd` 替代；`mobility`、`touch_controls`、`save` 及 5 项 Python 导出测试重新通过。身法专项覆盖三名角色 × 三种模式的启动、暂停布局、重试和触屏预览保留；另以独立进程验证启动参数拒绝、测试结算写入隔离档案、重试、返回准备页及正常退出清理档案和备份。此项整理不改变上述人工验收状态。后续遵循 [测试场景规范](../../../docs/TEST_SCENES.md)。
