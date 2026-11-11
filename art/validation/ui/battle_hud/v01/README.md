# 战斗 HUD 通用 UI 迁移任务卡

- 界面 ID：`battle_hud`；版本：`v01`；日期：2026-11-09。
- 状态：`visual_review_pending`；实现与本地回归完成，用户运行时视觉 / Android 实机待验收。
- 依据：用户于 2026-11-06 审核通用 UI v01，当前明确授权“继续战斗 HUD 完整迁移”。
- 概念：[06 战斗 HUD](../../../../concepts/ui/common/v01/06_combat.png)；基线：[正式 HUD](../../common/v01/baseline/hud_1280.png)。
- 入口：正式 `scenes/main.tscn` 及两个继承练习场景。F5 → 关卡 / 免费练习；F3 切换触屏。

## 本次实现

正式 HUD 统一复用 `UITokens / PaintedTheme`，新增 `UIBattleHUD / UICombatAction / UIBossStatus / UIThreatNotice / UILinearMeter / UIRadialMeter`，由 `BattleHUDPresenter` 读取数据。API 和后续扩展规则见[规范第 14 节](../../../../../docs/UI_DESIGN_SYSTEM.md#14-第五批完整战斗-hud)。

- 悬浮生命 / 影晶 / 时间、角色名 / 保护时间、段落、击破 / 连击、战斗反馈、桌面暂停入口使用共同字体和色板。
- 路线节点按实际关卡段长生成，保留原有完整关路线 75% / 首领 25% 和两种练习的进度规则；第二关五段不再画成固定四等分。
- 首领显示真实生命与唯一当前阶段，半血强化独立标注；侧别预警用箭头、文字、动作和时间表达。安全段使用中性标记。
- 一左四右动作保持原命中区；圆内状态、圆外名称与剩余环分离。御风额度、雷闪冷却、踏影条件来自身法运行时；武器图来自当局配置，按图像有效边界等比缩放。去掉遮挡图形的小实心状态牌。
- 桌面使用同一套只读动作与快捷键，触屏仍通过原 `TouchControls / RunInput`；没有第二套攻击、计时或消费逻辑。
- 被动补给只显示本局实际消费的物品及待触发 / 已触发状态，未携带如实显示；重复刷新不扣库存，不增加新操作键。普通重试仍不续带补给。

删除旧 HUD 卡片、隐藏的角色 / 忍术 / 武器面板，以及失去用途的 `PaintedHUD / FloatingHUDMarks` 脚本和 UID。没有新增正式位图、PSD 或测试场景；旧素材、历史验收证据和仍被测试 / 工具使用的候选触屏预览保留。候选预览改接共同状态，切换按钮避开首领信息。

本次没有调整钢索、物理判定、冷却、身法和伤害规则。灰盒角色仍使用既有头像着色，专属正式头像 / 立绘未新增；不将完整 HUD 迁移记为全部 61 类 UI 或所有角色美术完成。

## 验证证据

公共 `tests/test_ui_components.gd` 检查真实受击后生命条、暂停冻结、键盘状态、首领互斥阶段与强化、实际路线节点、御风额度与雷闪冷却、真实购买 / 消费 / 被动触发及重复刷新不重复消费。对首轮图形发现的威胁文字宽度、头像尺寸问题追加边界检查，并调整键盘提示位置。

[完整本地回归](regressions.json)：19 套串行 GDScript 均退出 0，找到各套 PASS，无脚本错误；跨进程隔离档案先写后读通过；5 项 Python 导出规则检查通过。无显示日志保留本机 `get_system_ca_certificates` 环境诊断，摘要将它与脚本错误分开记录。远端 CI、安装包运行检查未执行。

[17 张实际截图](runtime/README.md)覆盖两关、键盘 / 触屏、1280×720 / 1600×720 / `Rect2(60,24,1480,648)` 安全区、低生命、忍术冷却、首领现身 / 蓄力 / 攻击 / 弱点 / 强化、御风额度、雷闪冷却及两种被动补给。图形捕获退出 0、`UI_COMPONENTS_PASS`，无脚本或渲染错误；助手检查文字方向、信息边界、动作名称和状态分离。详见 [capture.log](capture.log) 和 [validation.json](validation.json)。

截图使用正式场景、独立 SubViewport 和 `TestProfileScope`：数值 / 阶段为确定性注入，补给通过真实消费与受击触发，不表示完成了整条路线或真人手感验收。结束清理测试档案，不读写玩家正式 `user://save.json`。人工身法 / 模式验证继续复用 `tools/run_sandbox.gd`。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --fixed-fps 60 \
  --log-file /tmp/ninja-battle-hud-components.log --script res://tests/test_ui_components.gd

# 图形截图省略 --headless，追加：
# -- --capture-hud-dir=res://art/validation/ui/battle_hud/v01/runtime
```

最终资源导入退出 0、无脚本解析错误；编辑器退出仍有既有 `EditorSettings not instantiated yet ... shutdown_adb_on_exit` 诊断。截图 PNG 的尺寸、CRC / SHA-256、Godot 导入配对和新脚本 UID 已核对；Windows / Android 两个预设继续排除验证、概念、候选与测试目录，正式运行路径不依赖这些资源。

## 待人工验收

用户检查正式局内信息层级、武器 / 身法图形辨认和实玩时的遮挡；Android 检查真实安全区、缩放阅读、拇指可达性、多指、切后台与延迟 / 性能。自动回归与助手截图检查不能代替这两项。
