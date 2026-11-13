# 《影刃疾行》项目协作约定

本文件适用于整个仓库，供后续开发和验收收尾时使用。用户在当前任务中的明确要求优先；功能状态以实际代码、验证证据和对应文档为准。

## 开始工作与设计依据

- 先查看 `git status --short`，读取目标文件和相关设计。保留已有未提交修改；只修改本次任务需要的内容，不覆盖、回滚或格式化无关文件。
- 使用 [README](README.md) 了解运行入口，使用 [整体设计](docs/OVERALL_DESIGN.md) 和 [实现拆分](docs/IMPLEMENTATION_PLAN.md) 确定目标与阶段边界，再按功能阅读专项文档。历史版本说明不能代替当前实现检查。
- 按可运行、可验证的切片推进。将当前切片做到可验收，明确尚未实现的部分；不要仅因设计文档提到了后续系统就一次性提前接入。
- 常规实现、修复和已授权范围内的清理直接推进；需求冲突会影响玩法、存档兼容或验收结果时，说明具体冲突并确认必要信息。
- 用户可见文案、功能文档和交付说明默认使用简体中文；代码标识符沿用仓库英文命名。

| 工作内容 | 优先阅读 |
| --- | --- |
| 身法、角色、武器 | [角色身法](docs/MOBILITY.md)、[角色与技能](docs/CHARACTER_SKILL_DESIGN.md)、[角色与武器](docs/CHARACTER_WEAPON_DESIGN.md) |
| 关卡与首领 | [关卡编辑](data/levels/README.md)、[首领战斗](docs/BOSS_COMBAT_DESIGN.md)、[首领流程](docs/BOSS_ENCOUNTER.md) |
| 输入、布局、反馈 | [触屏操作](docs/TOUCH_CONTROLS.md)、[反馈系统](docs/FEEDBACK.md) |
| UI 设计与资源接入 | [通用 UI 设计系统](docs/UI_DESIGN_SYSTEM.md)、[UI 界面设计与开发工作流](docs/UI_DESIGN_WORKFLOW.md)、[美术方向](docs/ART_DIRECTION.md)、[美术流水线](docs/ART_PIPELINE.md) |
| 存档、美术、发布 | [存档](docs/SAVE_SYSTEM.md)、[美术方向](docs/ART_DIRECTION.md)、[美术流水线](docs/ART_PIPELINE.md)、[打包发布](docs/BUILD_RELEASE.md) |

## 项目结构与实现边界

- 引擎为 Godot 4.7，业务代码使用 GDScript，无需 .NET 编译。沿用现有制表符缩进、`snake_case` 文件 / 函数 / 变量及 `PascalCase` 类型命名。
- `data/` 的 `.tres` 保存静态配置，`scripts/` 实现运行时行为，`scenes/` 负责节点组装，`tests/` 和 `tools/` 承担回归及开发工具。优先扩展现有模块，避免让 `main.gd` 同时承担配置、经济、存档和 UI 业务。
- 角色、身法、武器和关卡差异优先数据化；通用 Player、关卡及 UI 读取标准接口，不按具体角色名称或 ID 编写特例。实现 ID 的分派放在所属运行时模块内。
- 共通移动参数放在 `data/control_tuning.tres`；身法参数由 `MobilityData` 定义，计时、额度和保护由 `MobilityRuntime` 管理。修改参数时同步对应行为验证和文档。
- 开局通过 `RunLoadout` 固定本局配置并深拷贝嵌套资源；局内和暂停时只读，重试保留配置、重新创建运行状态。不得将冷却和临时效果写回共享 `.tres`。
- 输入沿用 `RunInput`，触屏与键盘共用玩法语义；处理短点按、按住 / 松开、多指、暂停、失焦、失败和场景切换。当前 `dash` 是 `mobility` 的迁移别名，不再增加独立共享冲刺行为。
- 布局遵循 1280×720 设计坐标和 `ScreenLayout` 安全区，兼顾宽屏和移动设备。美术调整适配既有判定；玩法规则变化需作为明确的功能修改处理。
- 后续 UI 必须优先复用或扩展 [通用 UI 设计系统](docs/UI_DESIGN_SYSTEM.md) 的基础控件、组合控件与模板，不在页面内另做一套按钮、面板、色板和状态。该体系 v01 已于 2026-11-06 获用户概念审核通过，优先使用 `UITokens`、`PaintedTheme` 和 `scripts/ui/components/` 已实现控件；其余类型按切片建设，具体覆盖和运行时验收状态以规范为准。
- 新增资源校验必要字段、范围和非有限数。移动、伤害和碰撞变化检查物理帧边界、高速穿透、重复命中及保护结束时刻。
- 移动或删除资源前搜索代码、场景、工具和文档引用；保留 Godot 管理的 `.uid` / `.import` 对应关系，不手工篡改 UID 或提交 `.godot/` 缓存。

## 场景复用与验收后清理

具体规则遵循 [测试场景规范](docs/TEST_SCENES.md)：

- **不为每个功能、角色或参数组合新建场景。** 自动回归实例化正式场景并注入资源 / `RunLoadout`；人工灰盒复用 `tools/run_sandbox.gd`。
- 正式入口为 `scenes/ui/character_setup.tscn`；`main.tscn`、`practice.tscn`、`boss_practice.tscn` 分别承载完整关卡和正式练习功能，不因名称含 `practice` 就清理。
- 只有节点结构、独立渲染环境或长期测试台确有需要时才新增测试场景。在对应功能文档记录路径、用途、启动方式、依赖测试、验收状态和清理条件 / 保留理由。
- 自动回归通过、助手截图检查、用户视觉 / 手感验收及 Android 实机验收分别记录。不得把前两项写成用户验收完成。
- 用户明确验收通过后，在同一切片收尾中删除失去用途的临时场景、脚本和引用，同步入口文档及导出配置；将有价值的验证迁入共用回归，保留必要截图和结论。
- 未完成人工验收的美术预览或仍被测试 / 工具使用的场景继续保留用途记录。清理前判断实际依赖，不按 `preview`、`test` 等名称批量删除。
- `tests/*`、`tools/*`、`scenes/art/*`、`scripts/art/*` 已排除正式导出；新增调试目录时同步核对 Windows 和 Android 两个预设。正式运行路径不得依赖导出排除的资源。

## 运行与手工验证

以下命令从仓库根目录执行。macOS 当前可用引擎路径如下；其他环境使用已安装的 Godot 4.7 替换，CI 命令见 `.github/workflows/package.yml`。

```sh
godot_bin=/Applications/Godot_mono.app/Contents/MacOS/Godot
"$godot_bin" --path .
```

编辑器 F5 进入正式准备页，F6 运行当前场景。测试指定角色和模式使用隔离档案的共用启动器：

```sh
"$godot_bin" --path . --script res://tools/run_sandbox.gd -- --character=wind_scout --mode=parkour --touch
```

`--character=` 支持 `shadow_runner` / `wind_scout` / `thunder_guard`，`--mode=` 支持 `parkour` / `boss` / `full`。`--touch` 显示触屏控件，F3 可切换；详细参数使用 `--help`。启动器正常退出清理临时档案；强制终止留下的文件按测试场景规范处理。

## 自动验证与测试选择

- 按改动选择有意义的行为回归。修复问题时覆盖原先会失败的边界，优先扩展现有测试；不为低影响的文档 / 格式修改新增游戏测试。
- 新增全局类型或资源后，如导入缓存缺失，先执行 `"$godot_bin" --headless --path . --editor --import --quit --log-file /tmp/ninja-import.log`。不要用删除整个缓存作为常规修复手段。
- 无显示回归固定为 60 FPS，显式指定日志路径。检查退出码、对应 `*_PASS` 和错误日志；进程启动成功不能代替测试通过。
- 同一套测试不要并发运行。`touch_controls` 与继承它的 `ui_art_preview` 共用 `touch` 档案，必须串行；跨进程存档的写入和读取也必须串行。

| 改动范围 | 优先运行的测试套件 |
| --- | --- |
| 移动、翻绳、落地、影晶、路线 | `rope_landing`、`rope_pickups`、`level_route`；涉及身法加 `mobility` |
| 身法、输入和生命周期 | `mobility`、`touch_controls`；影响路线时加 `level_route` |
| 战斗、弹体、首领、武器 | 按影响选择 `combat`、`projectiles`、`boss`、`weapons` |
| 档案、成绩、设置、重试装备 | `save`、`stars_records`、`reward_transactions`、`weapons`，并执行跨进程存档写入 / 读取 |
| 触屏、HUD、角色美术、反馈 | 按影响选择 `ui_components`、`touch_controls`、`ui_art_preview`、`player_art`、`feedback`；布局与视觉变化补实际图形检查 |
| 导出元数据和打包配置 | Python 导出测试，核对两个导出预设及资源排除规则 |
| 仅修改文档 | 核对引用、路径、命令及状态描述，并运行 `git diff --check` |

单套回归示例：

```sh
suite=mobility
"$godot_bin" --headless --path . --fixed-fps 60 --log-file "/tmp/ninja-$suite.log" --script "res://tests/test_$suite.gd"
```

修改共通基础设施或准备发布时运行完整回归；套件清单随测试演进维护，发布要求以工作流为准，美术预览另按影响补测：

```sh
for suite in rope_landing rope_pickups level_route mobility combat projectiles boss feedback weapons save stars_records reward_transactions economy ui_components touch_controls player_art ui_art_preview level_select wind_bamboo; do
    "$godot_bin" --headless --path . --fixed-fps 60 --log-file "/tmp/ninja-$suite.log" --script "res://tests/test_$suite.gd" || exit $?
done
python3 -m unittest discover -s tests -p test_ci_export.py
```

跨进程存档检查（前一步成功后再执行下一步）：

```sh
"$godot_bin" --headless --path . --log-file /tmp/ninja-profile-write.log --script res://tests/test_profile_persistence.gd -- --write
"$godot_bin" --headless --path . --log-file /tmp/ninja-profile-read.log --script res://tests/test_profile_persistence.gd
```

## 存档与资源保护

- 测试默认使用 `TestProfileScope`，专项持久化测试使用显式隔离路径；不得读写或重置玩家正式 `user://save.json`。作用域在结束时关闭，恢复共享状态并清理测试文件。
- 修改存档保持稳定 ID、旧字段和未知扩展字段的兼容，校验损坏数据与较新版本保护；格式升级需有明确迁移规则和回归。保留原子写入、备份恢复和保存失败重试行为。
- 成绩按关卡和模式隔离；重复终点信号、重试保存、失败或中途退出不能重复记录完成或发放奖励。后续经济 / 奖励修改遵循实现拆分中的事务和去重要求。
- 美术按 `art/concepts/` → `art/layered/` → `art/generated/` 管理来源和版本，`art/workbench/` 留作被忽略的原始工作目录，`art/validation/` 保存必要验收证据。清理测试场景不等于删除原始素材和证据。
- 候选素材按清单记录来源、尺寸、透明边界和验收状态；未经对应验收的候选资源不直接覆盖正式贴图，不修改报告制造通过状态。
- PSD 拆层默认使用项目内 `tools/art/s2p/cli.cjs`，安装 / 配置 / 检查见 [工具说明](tools/art/s2p/README.md)；不再要求外部源码仓库或全局拆层 skill。私有配置不提交，输出放在 `art/workbench/`。
- 每个新 UI 界面先参考当前界面生成概念图，用户审核通过后才进入抠图 / 分层和 Godot 拼装；概念审核、自动回归、截图检查、用户视觉审核和 Android 实机审核分开记录，具体顺序见 [UI 界面设计与开发工作流](docs/UI_DESIGN_WORKFLOW.md)。
- 动态文字、冷却、生命和进度交给 Godot 绘制；资源接入检查透明边缘、缩放、图集边界和实际画面。无显示测试无法证明视觉效果或 Android 手感。
- 私有模型配置、密钥、签名文件及本地产物不进入仓库；导出和签名流程见打包文档。

## 收尾与交付

- 完成后运行 `git diff --check`，检查此次涉及的新增 / 删除文件、引用和导出边界，避免遗留临时场景、测试档案或调试入口。
- 行为、参数、入口或阶段状态变化时，同步最相关的 README / 专项文档 / 实现拆分；避免在多个文档复制容易过期的完成清单。
- 简要说明做了什么、验收入口、实际运行的检查和仍待人工 / 实机验证的项目。没有运行的测试、远端 CI 或设备检查不得记为通过。
- 提交、推送、创建发布 tag 和发布按用户授权范围执行；未经要求不顺带触发发布流程。创建分支时默认使用 `codex/` 前缀。
