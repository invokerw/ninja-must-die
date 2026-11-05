# 三星与历史纪录切片 · 2026-11-05

本记录对应提交 `381ea03` 的成绩切片；后续奖励与 v3 存档进度见 [奖励切片](../rewards_v01/README.md)。

当前状态：功能与助手截图检查完成，用户视觉 / 手感 / Android 实机统一待验收。没有新 UI 概念图、贴图或独立测试场景；本轮复用现有地图、准备页与结算面板，接入动态成绩和纪录视图。

## 已接入

- 正式主线按收集与有效受击给出 1～3 星，无伤印独立记录。
- 最高分、最快、首次无伤分别保存完整单局和出战快照，各角色与全角色纪录分开。
- 稳定单局 ID 随成绩存档，重复结算、保存重试和重新加载后不重复增加完成次数。
- v1 旧成绩、装备、设置及未知字段保留；旧等级不换成星级，旧完整通关继续满足关卡前置。新增成绩保存为 v2，较新版本保护继续有效。
- 地图增加“全角色最高 / 当前角色”切换；旧版和当前角色无纪录状态有明确文案。地图卡片始终显示全角色最高。
- 结算把三星、无伤印与原始统计放在首屏，首领击破与三类伤害仍保留；设置按钮下移，避免与完整首领结算的五行统计相交。

## 图形证据

真实 OpenGL 渲染，SubViewport 实例化正式场景，使用 `TestProfileScope` 隔离档案。共八张 PNG：

| 文件 | 状态 |
| --- | --- |
| `1280_stars.png` / `1600_stars.png` | 新主线 3 星 + 无伤印，全角色视图 |
| `1280_legacy.png` / `1600_legacy.png` | 只有旧版 S，星级待挑战；不显示虚构无伤印 |
| `1280_character_empty.png` / `1600_character_empty.png` | 当前角色没有新纪录，地图仍显示全角色最高 |
| `1280_result.png` / `1600_result.png` | 40/50、受击 1 次，真实首领击破后结算 2650 分三星，无伤印未取得 |

助手抽查四类状态与宽屏结算：文字可读，角色空纪录不串用全角色记录；五行首领统计、设置和重试保存区域互不遮挡。截图里的单局统计由测试注入，首领通过真实忍术命中击破；第二关真实终点、练习和失败边界另由专项行为测试覆盖。截图检查不能代替用户验收或 Android 检查。

复现（不加 `--headless`）：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . --fixed-fps 60 \
  --log-file /tmp/ninja-stars-capture.log --script res://tests/test_stars_records.gd -- \
  --capture-dir=res://art/validation/progress/stars_v01
```

## 验证与边界

`test_stars_records` 的无显示与图形运行均要求退出 0，并输出 `STARS_RECORDS_PASS`。专项覆盖整数阈值、不拼接成绩、独立无伤印、嵌套快照隔离、角色视图的真实触摸切换、旧档迁移、损坏记录与备份、较新版本保护、保存重试及重载去重。跨进程持久化专项增加新星级快照与单局 ID 验证。

本地串行 16 套 GDScript 回归全部退出 0 并获得对应 PASS，5 项 Python 导出测试通过，跨进程检查获得 `PROFILE_WRITE_PASS` / `PROFILE_RELOAD_PASS`。完整清单与命令见仓库 README / 打包工作流。运行日志为 `/tmp/ninja-stars-final-*.log`，图形日志为 `/tmp/ninja-stars-capture.log`。无显示 Godot 仍有既有 macOS 系统证书读取错误 `get_system_ca_certificates`，未发现新增脚本错误或断言失败；未执行远端 CI。

Godot 编辑器导入已生成新增脚本 UID，退出 0；日志另有退出时 `EditorSettings not instantiated` 的 Android SDK / ADB 设置诊断，因此不将此次导入记为 Android 环境检查通过。

真实铜钱、首通 / 新星 / 无伤印发奖、奖励事务、正式角色解锁、完整快照的移动端详情及无伤印专属美术 / 音效尚未接入。后续统一进行用户视觉、触屏手感与 Android 实机验收；本记录不将阶段 C 整体标为完成。此目录保留为验收证据，不参与 Windows / Android 正式导出。
