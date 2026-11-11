# 通用 UI 设计系统 v01 任务卡

- 界面族 ID：`common`；版本：`v01`；创建日期：2026-11-06。
- 负责人：Codex；审核人：用户。
- 概念状态：`approved`；首批组件状态：`visual_review_pending`；`runtime_ready: false`。
- 目标：为《影刃疾行》建立后续界面必须复用或扩展的统一 UI 语言，覆盖基础、组合、整屏模板与异常状态。

## 功能与入口

首轮交付概念稿、组件目录、界面模板、状态和扩展规范；用户通过后，已制作通用主题与首批原生控件。未新增玩法、正式位图或 Godot 预览场景。运行入口继续为 `scenes/ui/character_setup.tscn`，地图和商店复用现有正式场景，局内复用 `scenes/main.tscn` 及正式练习场景。

## 当前 UI 基线

2026-11-06 使用 Godot 4.7 图形渲染器 / OpenGL Compatibility，在 1280×720、触屏显示、隔离测试档案下捕获：

| 文件 | 实际来源 |
| --- | --- |
| [准备](baseline/setup_1280.png) | `scenes/ui/character_setup.tscn` |
| [地图](baseline/map_1280.png) | `scenes/ui/level_select.tscn` |
| [商店](baseline/shop_1280.png) | `scenes/ui/shop.tscn` |
| [设置](baseline/settings_1280.png) | 正式准备页的设置面板 |
| [战斗](baseline/hud_1280.png) | 正式 `main.tscn`，冻结角色并注入显示数值 |
| [暂停](baseline/pause_1280.png) | 正式 `main.tscn` 的暂停逻辑 |
| [结算](baseline/result_1280.png) | 正式 `main.tscn` 的结算面板，注入示例文字，未提交成绩 / 奖励 |

截图脚本使用 `TestProfileScope("ui-common-v01-baseline")`，退出清理临时档案。控制台退出 0，输出 `UI_COMMON_BASELINE_PASS (7 current-scene captures, isolated profile)`；这是基线捕获完成标记，不是行为回归或新设计通过。基线中的待保存提示如实保留。

问题：面板装饰、按钮轮廓和字级各自演化；选择与装备状态易混淆；小型设置、长文与结算缺少统一的密度和层级；异常状态没有统一容器。必须保留真实经济 / 成绩语义、悬浮式 HUD、一左四右输入布局、`ScreenLayout`、动态文字及输入生命周期。

## 设计约束与计划

- 1280×720 设计坐标，16:9 核心安全框；宽屏扩展背景，内容不横向拉伸。
- 通用触摸目标至少 48×48 设计 px；局内操作基准 96×96；安全区仍由 `ScreenLayout` 计算。
- 墨夜 / 月白 / 暖金 / 朱砂，细金边、低纹理墨面、月弧和驿灯纹样；减少重边框与大面积发光。
- 所有标题、名称、数值、锁定条件、冷却、生命、交易状态均由 Godot 绘制。
- 覆盖基础操作、导航表单、数据卡片、HUD、弹层、反馈状态及准备 / 地图 / 商店 / 结果 / 剧情帮助模板。
- 概念中的未实现功能只展示 UI 容器，明确标记为后续模板；不用示例值冒充真实成绩或新功能。

## 概念与审核

- 概念目录：`art/concepts/ui/common/v01/`。
- 提示词目录：`art/prompts/ui/common/v01/`。
- 已交付：[10 张概念板](../../../../concepts/ui/common/v01/README.md)、[离线图册](../../../../concepts/ui/common/v01/index.html)、[统一设计规范](../../../../../docs/UI_DESIGN_SYSTEM.md)。
- 61 类控件设计、12 组模板；[参数](../../../../concepts/ui/common/v01/design_tokens.json) 为设计参考，未被运行时代码加载。
- 生成：内置 `image_gen.imagegen`，10 次独立请求，02～10 共用 01 视觉锚点；模型版本未报告，无 CLI 回退。
- [实际提交提示词](../../../../prompts/ui/common/v01/generation.prompt.md)、[来源 / 尺寸 / SHA-256](../../../../concepts/ui/common/v01/manifest.json) 已保留；原始 PNG 逐字节复制，未编辑像素。
- 参考：本页七张实际截图、`art/concepts/ui/shop/v02.png`、已确认的 `art/concepts/ui_top_hud_open_v01.png`。
- 用户概念审核：**通过**。日期：2026-11-06；原话：**“可以审核通过按照这个来吧”**。范围为整套概念方向与后续复用 / 扩展，不包括运行时和 Android 验收。
- 已按审核方向用原生 Godot 主题与控件制作简单几何 / 文字 / 状态；需要的新纹理 / 图标留待对应切片单独制作候选资源。

## 初次设计交付边界（审核与开发之前）

- 分层 / 运行时资源：本轮无。
- Godot 新设计拼装、自动行为回归、运行时截图、用户运行时视觉、Android：本轮均未完成。
- 本轮进行原图可读性、参考一致性、文档链接、资源路径、导出边界和 `git diff --check` 检查。
- 历史商店 / 地图 / HUD 审核记录分别保留；本版概念通过依据为上文用户明确回复，不能据此改记运行时验收。
- 已识别的色号、示例文案、星数、首领状态组合和教学侧别偏差记录在设计规范第 9 节；概念图只定义外观，不改玩法或数据规则。

## 初次设计交付检查 · 2026-11-06

- [验证摘要](validation.json)、[最终基线捕获日志](baseline_capture.log) 已保留。
- 10 张概念原图与内置工具返回 PNG 的 SHA-256 一致；10 张概念 + 7 张基线的 PNG 分块 CRC、IDAT 解压和扫描行结构检查通过。
- 61 类控件 ID 无重复，参数值与规范一致；图册 10 项、图片 / 文档本地链接有效；图册脚本 `node --check` 通过。
- Windows / Android 两个预设的排除规则覆盖本轮概念、提示词和验证材料；正式 `scripts / scenes / data` 无本轮概念依赖。
- `python3 -m unittest discover -s tests -p test_ci_export.py`：5 项通过。`git diff --check`：通过。
- 内嵌浏览器安全策略不允许打开本地 `file://`，图册未做浏览器渲染 / 交互验收；未启动替代服务器绕过策略。离线 HTML 已保存，原始 PNG 在图册 Markdown 中也可查看。
- 临时基线捕获脚本已删除，隔离档案清理已检查；未新增 `.tscn`、运行时脚本或正式贴图。
- 本轮为设计交付，未运行 GDScript 行为回归、远端 CI 或 Android 检查；不将基线捕获、原图结构或 JS 语法检查记为新设计运行时通过。

## 概念通过后的首批实现 · 2026-11-06

- 运行时入口、组件 API 与未实现目录项：[统一规范第 10 节](../../../../../docs/UI_DESIGN_SYSTEM.md#10-首批原生控件与接入边界)。
- 已实现 `UITokens / PaintedTheme / UIActionButton / UIToggleRow / UIStatusChip / UIConfirmDialog`；商店按钮、面板、分类、确认和待保存 / 只读标识共用这些基础。设置复用整行开关、状态与按钮，增加居中布局及阻断底层触摸的遮罩。
- 旧准备、暂停与 HUD 面板通过兼容入口获得统一基础样式；这些页面的完整构图、新图标和其他 61 类目录项尚未全部实现，不提前接入角色选择、剧情等业务。
- 未制作或替换正式位图，无新 PSD、候选 PNG 或 `.tscn`；本切片的几何 / 状态均适合原生绘制。原概念图片和示例偏差保持可追溯。
- 验收入口：F5 → **山路行商** 查看统一商店 / 购买确认；F5 → **设置 F2** 查看开关、保存状态和遮罩；局内暂停仍共用同一设置面板。
- 自动回归：19 套串行全部退出 0、找到各套 PASS 且无错误；跨进程隔离档案先写后读通过；5 项 Python 导出检查通过。完整摘要：[foundation_regressions.json](foundation_regressions.json)。CI 已加入 `ui_components`，远端 CI 未运行。
- 图形专项：退出 0、`UI_COMPONENTS_PASS`，无错误；共 9 张真实截图，覆盖 1280×720、1600×720 及 `Rect2(60,24,1480,648)` 安全区。助手已检查控件状态、商店 / 确认、保存失败、正常设置、准备、暂停和 HUD；无明显边界溢出、邻格污染、文字裁切，基础样式与首批规范一致。截图：[运行时首批图册](runtime/README.md)。
- 导入过程退出 0、未报脚本解析错误，但编辑器退出记录了 `EditorSettings not instantiated yet ... shutdown_adb_on_exit`；图形与全部运行时回归日志未出现该错误，不将其写成无错误的导入记录。
- 临时测试使用 `TestProfileScope`，结束清理；图形入口复用公共组件回归，没有临时脚本 / 新测试场景。正式档案未读写。
- **用户概念审核：通过；首批自动回归 / 助手图形检查：通过；首批用户运行时视觉：待审核；Android：待验收。** 其余控件 / 模板按规范逐步建设。

## 第二批：通用卡片与准备页 · 2026-11-06

- 已新增 `UISelectCard / UITabBar / UIDetailPanel`，扩展 `UIStatusChip.preview`；正式准备页标题改为“行前准备”，采用统一角色 / 武器卡片、四页签、滚动详情与固定底部操作。旧首批截图和日志保留历史。
- 实现范围、与概念 03 的功能适配、实际状态和待办集中记录于 [准备页任务卡](../../character_setup/v01/README.md)，组件 API 见 [规范第 11 节](../../../../../docs/UI_DESIGN_SYSTEM.md#11-第二批卡片页签与行前准备)。
- 保留武器明确装备、原有三种模式 / 存档 / 经济事务；秘卷 / 补给只读摘要与行商入口不增加重复购买或开局消费。
- 复用公共 `ui_components` 专项，加入卡片标签 / 图片边界、锁定可查看、页签触摸 / 键盘、预览 / 装备独立、状态保留、真实库存和只读验证；设置补焦点转入 / 循环 / 恢复，防止底层 Enter。
- [第二批实际截图](runtime/preparation/README.md)、[验证摘要](preparation_validation.json)、[完整本地回归](preparation_regressions.json) 与首批分开保存。用户运行时视觉 / Android 仍待验收，远端 CI 未运行。
- 无新增 `.tscn`、正式位图或临时测试入口；公共回归和正式场景长期保留，隔离档案结束清理。

## 第三批：关卡选择运行时控件迁移 · 2026-11-07

关卡选择页继续复用已审核的路线背景、关卡卡面和锁定图层，动态按钮迁移到 `UIActionButton`，纪录筛选迁移到 `UITabBar`，铜钱旁加入 `UIStatusChip` 的待保存 / 只读状态，动态面板使用 `PaintedTheme`。实现、回归和人工验收边界见 [关卡选择页 v02 任务卡](../../level_select/v02/README.md)；本批自动回归已通过，用户运行时视觉 / Android 仍待验收。

2026-11-09 已补关卡选择 v02 的 9 张真实图形截图并检查，修复新按钮与旧图层重叠；历史启动失败记录保留，用户运行时视觉 / Android 仍待验收。

## 第四批：暂停与结算 · 2026-11-09

`UIRunPanel / UIStarRating` 接入正式场景及继承练习场景，统一滚动内容、固定操作、三星 / 独立无伤和持久存档状态；新增设置子窗输入阻断和键盘焦点回归。完整范围、11 张实际截图、回归及剩余边界集中于[暂停 / 结算任务卡](../../run_overlay/v01/README.md)。用户视觉 / Android 待验收。

## 第五批：完整战斗 HUD · 2026-11-09

正式全关与两个练习场景改用 `UIBattleHUD / UICombatAction / UIBossStatus / UIThreatNotice` 及通用生命 / 环形进度；路线、首领阶段、身法额度、真实消费补给与键盘 / 触屏动作共用运行时绑定。删除旧 HUD 节点及失去用途的适配脚本，保留候选触屏预览和旧证据。组件 API 见[规范第 14 节](../../../../../docs/UI_DESIGN_SYSTEM.md#14-第五批完整战斗-hud)，17 张实际截图、回归和验收状态集中于[战斗 HUD 任务卡](../../battle_hud/v01/README.md)。用户视觉与 Android 待验收，灰盒角色专属美术未新增。

## 第六批：关卡选择完整布局 · 2026-11-11

按已审核的 04 设计板补齐列表 / 中央驿灯 / 右侧详情 / 固定动作底栏，复用通用卡片、面板、页签、星级和弹层；新关卡卡片变体与路线组件由正式目录 / 纪录驱动。此前 v02 只有控件迁移。范围、当前截图、回归和待人工项见[关卡 v03 任务卡](../../level_select/v03/README.md)，用户运行时视觉 / Android 尚待验收。
