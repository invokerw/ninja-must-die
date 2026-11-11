# 《影刃疾行》实现拆分

> 版本：0.2 · 2026-10-30
>
> 这是神话史诗整体设计进入开发后的技术拆分。它把任务排成可逐步验收的切片，各阶段是否完成以下方进度为准。设计基线见 [整体设计](OVERALL_DESIGN.md)。

## 当前进度 · 2026-11-09

- **阶段 A：代码与本地自动回归完成。** 统一 `MobilityData` / `MobilityRuntime`、角色注册表、三种身法资源、基础二段跳、点按 / 按住 / 松开输入、触屏状态、暂停 / 失焦 / 重试已接入；共用灰盒启动器可选择岚织 / 烬锋和三种模式，替代按角色复制的场景。Player 不按角色或身法 ID 分支。
- 三名角色都已回放当前第一关主路线：0 受击、50 / 50 影晶、约 95.90 秒击破首领。影刃另验证独立第三跳替代路线，雷闪补全沿途机关 / 拾取扫掠。
- 已生成并检查三名角色的触屏与暂停截图。两名灰盒角色暂用占位色、共用月蚀斩；正式角色选择和专属忍术表现尚未接入；岚织通关所有权已在奖励切片记录。Windows CI 已加入身法专项，Android 实机和真人手感验收待进行。
- **阶段 B 已开始实现。** 已加入 `LevelCatalog`、第一章前两关的稳定 ID / 前置关系、准备页到关卡选择页的入口、第二关 `wind_bamboo_85s` 的五段灰盒、五十颗影晶和落竹预警 / 生效 / 退场机关；三名角色 × 两把武器的基础 / 身法替代路线及正式 / 练习重试已补回归；通关发奖与所有权事务已接入；故事入口、固定弹道组合编排和第二关人工验收仍待后续切片。阶段 C 的成绩与奖励切片已实现，阶段 E 的成长 / 购买事务及独立商店已接入，故事及阶段 E 剩余玩法 / 验收见后文。
- 2026-11-04：关卡选择页已完成分层资源用户审核、正式场景拼装、关卡/触屏/UI 回归和图形截图检查；运行时用户视觉与 Android 验收仍待进行，证据见 [UI 任务卡](../art/validation/ui/level_select/v01/README.md)。

2026-11-05 提交前独立快照的 15 套 GDScript 回归、5 项 Python 导出测试及跨进程隔离存档写入 / 读取检查通过。具体边界、操作、资源与验证说明见 [角色身法](MOBILITY.md) 和 [关卡选择 UI 任务卡](../art/validation/ui/level_select/v01/README.md)。

2026-11-05 第二关收尾：修复重试丢失所选关卡、落竹预警误标退场；扩展 12 次正式路线回放与落竹各阶段暂停验证。关卡选择、美术预览、第二关专项加入打包工作流的串行回归。本地串行 15 套 GDScript、5 项 Python 导出测试及跨进程隔离存档写入 / 读取均通过（退出 0、对应 PASS）；日志 `/tmp/ninja-closure-*.log`。本机 Godot 启动仍输出既有 macOS 系统证书读取错误 `get_system_ca_certificates`，未出现新增脚本错误；未执行远端 CI 或 Android 检查。路线结果、入口及仍待验收项统一见 [第二关灰盒](../data/levels/README.md#第二关灰盒风竹渡)。此为奖励切片之前的验证记录。

2026-11-05 阶段 C 成绩切片：正式主线接入三星与独立无伤印，保存最高分 / 最快 / 首次无伤的完整单局快照、各角色纪录和稳定 run_id 去重；地图支持全角色 / 当前角色视图，准备页与结算读取新纪录。旧成绩原样保留、旧通关仍满足关卡前置，不从旧评级推算星级；存档提前升至 v2，阻止旧程序覆盖新数据。当时真实奖励 C2 与经济事务尚未接入；后续进度以下方奖励切片为准。规则与迁移见 [存档文档](SAVE_SYSTEM.md)，截图与验收边界见 [成绩切片证据](../art/validation/progress/stars_v01/README.md)。

2026-11-05 奖励切片：`RewardService` 为成功正式局计算基础 / 收集 / 首通 / 新星 / 首次无伤 / 章节里程碑，并在同一档案事务中提交余额、成绩、领取账本及角色 / 关卡所有权。保存失败保留一次待保存草稿，阻止新正式奖励局并保留免费练习；重试只写入、不重算。v1/v2→v3 迁移补一次性权益、不追溯重复奖励。当前两关可实际达到 6 星里程碑，10 / 15 星为后续关卡规则；外观发放仍未实现；商店购买、成长效果、秘卷、补给事务已接入功能回归，正式视觉与真人 / Android 仍待验收。功能与 UI 验收入口见 [存档](SAVE_SYSTEM.md)，真人 / Android 统一待验收。

2026-11-06 阶段 E 功能占位与事务补测：成长、购买、库存和正式局补给已接入；修复 JSON 库存回读误判损坏、待保存交易被新购买覆盖、重复 run_id 扣库存及空补给标记污染无道具快照。新增经济专项与跨进程覆盖，并加入 CI 串行清单。尚未完成的玩法 / 交互及验收边界集中记录于 [成长与消费](ECONOMY.md)，不能将此前奖励回归通过视为商店整体验收完成。

2026-11-06 商店独立界面切片：准备页覆盖层已移除，新增 `scenes/ui/shop.tscn` 与 `shop_screen.gd`，按用户通过的 v02 概念接入分类货架、原生详情 / 确认、透明商品图集、秘卷装备与补给携带。真实档位价格、上限、锁定、库存、余额和保存失败均已展示；经济专项补触摸 / 键盘 / 过期确认与导航回归，完整本地回归已通过。最终用户视觉和 Android 待验收，阶段 E 其余玩法缺口继续以 [成长与消费](ECONOMY.md) 为准。

2026-11-06 通用 UI 切片：10 张“月下墨金”概念板及 61 类控件 / 12 组模板已获用户审核通过，后续界面必须复用或扩展该体系。`UITokens / PaintedTheme` 和首批原生按钮、开关、状态标识、确认弹层已接入商店与设置；兼容入口统一既有按钮和面板基础样式，未完成其余模板重构。新增组件回归、商店取消焦点与设置遮罩防穿透覆盖，19 套串行回归、跨进程隔离档案写读和 5 项导出检查通过，9 张实际图形截图已检查。用户运行时视觉、Android 和后续控件仍待进行；范围与证据见 [通用 UI 设计系统](UI_DESIGN_SYSTEM.md)，不把本切片计为阶段 F 全部完成。

2026-11-06 通用 UI 第二批：`UISelectCard / UITabBar / UIDetailPanel` 已接入正式“行前准备”，将真实武器预览 / 装备、秘卷 / 补给摘要与原有模式纪录组织到页签，底部保留关卡与免费练习入口。新增卡片图像 / 标识边界、切页保留预览、库存不消耗、只读与设置键盘焦点隔离回归；未启用未完成角色 / 大立绘、未新增测试场景或正式位图。当前代码 / 桌面截图与验收状态见 [准备页任务卡](../art/validation/ui/character_setup/v01/README.md)，不将概念通过或本地回归当作用户运行时 / Android 验收完成。

2026-11-07 通用 UI 第三批：关卡选择页保留已审核的关卡卡面、路线背景和锁定逻辑，将返回、重试保存、挑战 / 练习 / 剧情、卡片命中区迁移到 `UIActionButton`，纪录视图迁移到 `UITabBar`，铜钱旁加入 `UIStatusChip` 的待保存 / 只读状态，动态面板复用 `PaintedTheme`。`level_select`、`stars_records`、`reward_transactions` 回归通过；新批次用户运行时视觉和 Android 仍待验收，证据见 [关卡选择 v02 任务卡](../art/validation/ui/level_select/v02/README.md)。

2026-11-09 通用 UI 第四批：`UIRunPanel / UIStarRating` 接入正式暂停、成功 / 失败和两种练习结算，固定操作区、滚动统计 / 奖励、只读当局配置、三星与独立无伤、持久保存状态共用主题和按钮；补焦点循环、设置子窗阻断后台重试 / 触屏暂停、宽屏全屏遮罩。关卡选择 v02 补齐真实图形检查并移除重叠旧按钮图层。实际检查和未完成边界见[暂停 / 结算任务卡](../art/validation/ui/run_overlay/v01/README.md)；用户视觉和 Android 仍待后续。

2026-11-09 通用 UI 第五批：完整战斗 HUD 改用 `UIBattleHUD / UICombatAction / UIBossStatus / UIThreatNotice` 与通用生命 / 环形进度，`BattleHUDPresenter` 绑定真实运行时。路线节点读取段长，首领阶段与强化独立，被动补给显示实际消费 / 触发；键盘和触屏共用动作展示，原输入与命中区保持一致。删除旧 HUD 节点和失去用途的适配脚本；候选触屏预览保留既有用途。实现、17 张实际截图和检查记录见[战斗 HUD 任务卡](../art/validation/ui/battle_hud/v01/README.md)，用户视觉 / Android 待验收，灰盒角色专属美术未新增。

2026-11-11 通用 UI 第六批：补齐已审核概念 04 的关卡选择完整布局；列表复用通用卡片，目录驱动中央驿灯路线，详情和触摸出战快照使用通用面板 / 页签 / 弹层，底栏固定挑战和练习。仅复用已审核背景 / 插图 / 驿灯，保留锁定、旧纪录、只读和存档事务边界，未接入剧情。入口、验证与待人工项见[关卡 v03 任务卡](../art/validation/ui/level_select/v03/README.md)。

## 1. 实现原则

1. 每一步都保持当前 `fog_ridge_60s` 可启动、可重试、可保存；新功能通过灰盒入口接入，不先拆掉现有流程。
2. 角色差异集中在角色模块。关卡、首领和 UI 读取标准化的 `RunLoadout` 与身法接口，不在脚本里判断“影刃 / 岚织 / 烬锋”。
3. 星级、无伤印、最高分、最快时间和铜钱分开发放与保存；结算动画不能承担业务计算。
4. 所有影响本局的角色、武器、成长、秘卷和道具在开始正式计时前生成快照。暂停中不能修改快照。
5. 任何新关卡都先满足基础二段跳的主路线，再加入角色专属路线、收集分叉和精通目标。
6. 本地存档更新使用一次事务：扣钱、增加库存、更新进度、发奖和账本必须一起成功或一起保留待保存状态。
7. 遵循 [测试场景规范](TEST_SCENES.md)：优先复用真实场景与参数化测试入口；用户验收通过后清理失去用途的临时场景及引用，保留必要回归和验收证据。
8. UI 复用 / 扩展 [通用 UI 设计系统](UI_DESIGN_SYSTEM.md)，并遵循 [UI 界面设计与开发工作流](UI_DESIGN_WORKFLOW.md)：当前 UI 取样 → AI 概念图 → 用户审核 → 抠图 / 分层 → Godot 拼装 → 功能接入 → 分层验收。

## 2. 现有模块与目标边界

| 现有模块 | 下一阶段职责 | 需要的改动 |
| --- | --- | --- |
| `scripts/player.gd` | 统一移动、翻绳、跳跃、落绳和专属身法运行时 | 移除共享 `dash` 分支；接入 `MobilityRuntime`；保留基础二段跳和现有落绳回归 |
| `scripts/player_tuning.gd` | 共通移动参数 | 保留跑速、重力、二段跳；把身法参数移至角色资源，避免全角色共享冲刺 |
| `scripts/characters/character_data.gd` | 角色静态定义 | 增加 `mobility`、角色 K 忍术 ID、解锁条件和故事身份；旧 `passive` 兼容迁移 |
| `scripts/characters/passive_data.gd` | 旧版额外跳跃配置 | 首轮迁移到身法资源；旧存档只读兼容，不再给新角色强制 `EXTRA_AIR_JUMPS` |
| `scripts/characters/run_loadout.gd` | 当局配置快照 | 增加成长、秘卷、消耗品和规则版本；全部字段深拷贝 |
| `scripts/input/run_input.gd` | 键盘与触屏输入桥 | `dash` 改为语义中立的 `mobility`；统一点按 / 按住 / 释放事件 |
| `scripts/ui/touch_controls.gd` | 四个右侧战斗按钮 | 原影步按钮改为身法按钮；文字和冷却由角色运行时提供 |
| `scripts/combat/run_result.gd` | 单局结果计算 | 增加星级、无伤印、计分版本和奖励摘要；保留旧 rank 供迁移 |
| `scripts/progress/run_history.gd` | 历史记录 | 记录每关最高星、最高分、最快时间、无伤印、最佳配置和完成次数 |
| `scripts/characters/player_profile.gd` | 玩家档案 | 加入章节进度、角色解锁、铜钱、成长、秘卷、道具库存与发奖账本 |
| `scripts/persistence/profile_store.gd` | 原子存档和备份 | 升级版本，保留未知字段；支持待提交经济事务 |
| `scripts/ui/character_setup.gd` | 当前角色 / 武器准备页 | 拆出角色选择入口和关卡选择入口，保留装备预览 |
| `scripts/ui/run_navigation.gd` | 场景跳转与出战快照 | 支持从关卡详情进入任意已解锁关卡，传递完整 `RunLoadout` |
| `scripts/level/rope_level_data.gd` | 关卡路线资源 | 增加章节、解锁、故事、无伤挑战和星级配置字段 |
| `scripts/level/rope_level_controller.gd` | 运行时加载关卡 | 使用关卡目录解析目标；保持现有段落和机关校验 |
| `scripts/main.gd` | 单局计时、结算和奖励入口 | 将结果计算 / 发奖移到独立服务，主场景只负责信号和展示 |

## 3. 新增资源与服务

建议新增以下文件，名称保持稳定，便于后续角色和章节扩展：

```text
scripts/characters/
├── mobility_data.gd             # 影刃 / 岚织 / 烬锋的静态身法定义
├── mobility_runtime.gd          # 当局冷却、滑翔时长、使用资格和保护
└── character_registry.gd        # 稳定 ID → 角色资源
scripts/progress/
├── level_catalog.gd             # 章节 / 关卡目录与解锁规则
├── level_progress.gd            # 单关星级、无伤印、纪录和奖励状态
├── reward_service.gd            # run_id 去重、首通、新星、无伤印和里程碑
└── economy_service.gd           # 铜钱、购买、库存和事务校验
scripts/story/
├── story_beat_data.gd           # 关卡前 / 后 / 首领 / 地图故事片段
└── story_runtime.gd             # 已读状态、跳过和展示队列
scripts/ui/
├── level_select.gd              # 驿灯地图、星级、无伤印和解锁
├── level_detail.gd              # 关卡详情、目标、历史纪录和开始 / 练习
├── progression_screen.gd        # 成长与秘卷
├── shop_screen.gd               # 商店与购买确认
└── result_rewards.gd             # 星级、无伤印、铜钱和解锁动画
data/
├── characters/shadow_runner.tres
├── characters/wind_scout.tres
├── characters/thunder_guard.tres
├── levels/wind_bamboo_85s.tres
├── levels/level_catalog.tres
├── story/chapter_01.tres
└── shop/chapter_01_shop.tres
scenes/ui/
├── level_select.tscn
├── level_detail.tscn
├── progression.tscn
└── shop.tscn
```

第一轮可以让 `CharacterRegistry` 和 `LevelCatalog` 使用脚本常量预加载资源，等数据稳定后再迁移到 `.tres` 目录。UI 不应自行扫描文件夹决定解锁内容。

## 4. 阶段 A：角色身法底座

目标是把当前共享影步替换成统一身法接口，先只让影刃可玩，再加入两个灰盒角色。

### A1. 数据模型

`MobilityData` 建议字段：

```text
mobility_id: StringName       # third_jump / glide / burst
display_name: String
description: String
input_mode: enum              # EDGE / HOLD
cooldown_seconds: float
air_use_limit: int            # 影刃 / 岚织每次离绳 1，烬锋按冷却
invulnerability_seconds: float
parameters: Dictionary        # 各实现私有参数，加载时做范围校验
```

运行时统一提供：`try_start(input)`, `tick(delta)`, `release()`, `can_use()`, `remaining_text()`、`reset_on_rope_attach()`。Player 只读取结果，不知道具体实现名称。

### A2. 输入与玩家迁移

- 在 `project.godot` 增加 `mobility`，旧 `dash` 只保留一个版本迁移别名，避免旧测试和旧输入映射立即失效。
- `RunInput` 区分 `mobility_just_pressed`、`mobility_pressed`、`mobility_just_released`。
- `PlayerController` 的 `DASH` 状态拆为 `MOBILITY`；雷闪的水平位移、保护和冷却由 runtime 写入，普通角色不走冲刺代码。
- 身法优先级：基础跳跃输入先消费，只有明确的身法边沿才发动专属身法；御风按住不刷新时长；雷闪一次输入只消费一次。
- 暂停、失焦、死亡、终点和重试清理按住状态、滑翔时长、冷却队列和保护计时。
- `painted_hud.gd` 与 `touch_controls.gd` 显示“身法”及角色名称，不再固定显示“影步”。

### A3. 角色资源

保留 `shadow_runner.tres` 的角色和武器 ID，增加：

```text
mobility = res://data/characters/mobility/third_jump.tres
unlock_id = "starter"
story_name = "影刃"
```

岚织和烬锋先使用同一角色场景和占位颜色，不要求立即制作最终立绘。所有角色初始使用同一套基础二段跳和生命参数。

### A4. 验收

- 影刃必须用“跳、跳、身法”完成第三跳；第三次按跳跃无效。
- 岚织滑翔只在下降段减速，按住不刷新本次时长，空中快落会结束滑翔。
- 烬锋在钢索和空中都能点按雷闪，保护与冷却正确，身法不会刷新跳跃。
- 三人均能用基础二段跳通过当前第一关灰盒；旧落绳、拾取、暂停、失焦和触屏回归继续通过。
- 新增 `tests/test_mobility.gd`，覆盖三种身法的边界和同帧跳跃 / 身法输入。

## 5. 阶段 B：第一章关卡目录与第二关

### B1. 关卡目录

`LevelCatalog` 负责：稳定关卡 ID、章节排序、前置关卡、故事 ID、正式 / 练习场景、总影晶、星级规则版本和首通奖励。解锁判断只能通过目录读取，不写在地图按钮里。

推荐第一章资源：

```text
fog_ridge_60s      # 迁移为 chapter_01_01_fog_ridge
wind_bamboo_85s    # 新增第二关
relay_station_90s  # 占位目录，后续实现
machine_waterway   # 占位目录，后续实现
dark_lamp_120s     # 占位目录，章节首领
```

旧 `fog_ridge_60s` 的 ID 不直接删除；目录增加 `legacy_level_id` 或别名，保证旧纪录和旧存档仍可读取。

### B2. 第二关灰盒

- 新增 `data/levels/wind_bamboo_85s.tres`，沿用 `RopeLevelData`、段落、机关、影晶和敌人资源。
- 新增 `RopeHazardData` 的 `falling_bamboo` 类型或独立 `RopeThreatData`，包含预警、停留、退场和安全侧。
- 预警与实际碰撞共用一个实例状态，暂停时同时冻结；不允许只显示预警线而不生成实际危险。
- 采用五十颗普通影晶，主路线至少可收集四十四颗，额外六颗放在全收集路线。
- 每组组合先验证基础二段跳，再验证踏影、御风和雷闪路线；角色身法只提供替代路线，不是通关门槛。

### B3. 验收

- 新机关先独立出现，再与尖刺、固定弹道组合，最后进入综合段。
- 三名角色、两把武器、零强化、无道具都能通关。
- 每一处相反侧危险满足实际身宽、翻绳锁定、预警和输入误差后的最低窗口。
- 新增 `tests/test_wind_bamboo.gd`，至少包含基础二段跳通关、三名角色替代路线、五十颗影晶可达性和暂停 / 重试冻结。

## 6. 阶段 C：星级、无伤印与历史纪录

### C1. 结果模型

扩展 `RunResult`：

```text
level_id, mode, run_id
elapsed_seconds, damage_count, collected, collectible_total
score, stars, flawless, score_rule_version
character_id, weapon_id, growth_snapshot, item_snapshot
```

星级规则采用设计基线：

```text
C = collected / collectible_total
P = 1000 + floor(1000 × C) + max(0, 1000 - 150 × damage_count)
1 星：P < 2200
2 星：2200 ≤ P < 2600
3 星：P ≥ 2600
无伤印：damage_count == 0
```

`RunHistory` 对每个 `level_id + mode` 保存最高星、最高分、最快时间、最佳收集、无伤印、完成次数和配置快照。三颗星与无伤印必须是两个独立字段，不能从 rank 字符串推断。

### C2. 发奖

`RewardService.complete_run(result)` 只接受已成功结束的正式局：

1. 校验 `run_id` 没有结算过；
2. 计算本局星级、无伤印和新增星数；
3. 计算基础通关、收集、首通、新星、无伤印和章节里程碑奖励；
4. 更新历史、关卡解锁、章节进度和发奖账本；
5. 交给 ProfileStore 一次提交；
6. 返回不可变的结算摘要，UI 只播放摘要。

失败、练习、主动退出、加载失败和重复 finish 信号都不能进入发奖服务。

### C3. 验收

- 80% 收集、1 次受击可得三星；100% 收集、2 次受击可得三星；无伤单独产生无伤印。
- 护身符挡伤、回春和额外生命不产生无伤印，但可正常获得星级。
- 重复 finish、保存重试、暂停恢复和场景重载都不重复发奖。
- 新增 `tests/test_stars_rewards.gd`，覆盖整数边界、历史星级不回退、无伤印一次奖励和 run_id 去重。

## 7. 阶段 D：关卡选择与故事入口

### D1. 关卡地图

新增 `scenes/ui/level_select.tscn` 与 `scripts/ui/level_select.gd`，从角色准备页进入。第一章先做一条沿山上行的驿灯路线：五个节点分别对应五关，已通关节点点亮，未解锁节点显示具体前置条件。

详情面板显示：关卡简介、故事片段入口、最高星级、无伤印、最高分、最快时间、最高收集、受击次数、当前角色纪录和开始 / 练习按钮。星级和无伤印不互相覆盖。

### D2. 故事数据

`StoryBeatData` 使用稳定 ID 与关卡绑定：

```text
story_id, beat_id, speaker_id, text, portrait_id
trigger = BEFORE_RUN / BOSS_INTRO / AFTER_CLEAR / MAP_UNLOCK
once_only, skippable, next_beat_id
```

首章先实现四类片段：1-1 开场送灯、1-1 结尾救出岚织、1-3 结尾烬锋加入、1-5 结尾看到第十盏灯。剧情播放完才写入已读状态，重试默认跳过已读片段。

### D3. 验收

- 新启动流程为“角色与武器 → 关卡选择 → 关卡详情 → 出战”。现有 F6 直接场景入口继续有效。
- 完成第一关一星即可解锁第二关和岚织；练习不解锁、不发奖。
- 触屏能完成节点选择、详情打开、开始、返回和重看剧情。
- 地图历史纪录使用当前选择角色和全角色最高纪录两种视图，不混淆练习纪录。

## 8. 阶段 E：成长、商店与存档 v2

### E1. 存档结构

成绩切片曾升至 v2，奖励切片已升至 v3，加入真实 `coins`、`reward_ledger`、角色 / 关卡所有权及待保存事务。2026-11-06 已补入成长、秘卷、补给库存、购买账本和正式出战消费；旧 v3 存档缺少这些字段时按空成长 / 空库存迁移：

```json
{
  "version": 3,
  "coins": 120,
  "unlocked_character_ids": ["shadow_runner"],
  "unlocked_level_ids": ["chapter_01_01_fog_ridge"],
  "level_progress": {},
  "growth": {"weapon_training": 0, "body_training": 0},
  "scroll_ids": [],
  "selected_scroll_id": "",
  "item_inventory": {"guard_charm": 0, "spring_potion": 0},
  "reward_ledger": {},
  "pending_transaction": null
}
```

迁移规则：旧档影刃、两把武器、设置、历史纪录全部保留；旧完整关纪录只用于承认第一关已通关，不伪造星级与无伤印；首次赠送和首通奖励用稳定 ID 防止重复领取。

### E2. 经济 API

`EconomyService` 提供：

- `can_afford(cost)`、`purchase(item_id)`；
- `add_coins(amount, reason, transaction_id)`；
- `consume_item(item_id, run_id)`；
- `get_inventory(item_id)`、`get_growth_level(id)`；
- `commit_pending_transaction()`。

购买前校验商品、价格、前置、库存上限和档案版本。扣钱和获得物品在同一个 `pending_transaction` 中提交。UI 不能直接修改 `profile.coins`。

### E3. 界面顺序

先实现功能清晰的列表界面，再接水墨美术：

1. 结算页显示星级、无伤印、铜钱和解锁；
2. 成长页显示当前值、升级后值和累计上限；
3. 商店页显示铜钱余额、商品说明和购买确认；
4. 出战详情选择最多一种消耗品，重试不自动续带。

### E4. 验收

- 首通、新星、无伤印和章节里程碑各自只发一次。
- 买商品不会出现扣钱成功但物品缺失；保存失败保留待提交事务并提供重试。
- 零成长、零道具能完成正式关；成长只提供少量容错和输出提升。
- 新增 `tests/test_economy.gd` 和 `tests/test_reward_transactions.gd`，覆盖重复购买、重复结算、损坏存档、较新版本和跨进程读取。

## 9. 阶段 F：美术、音频与移动端

功能稳定后再把灰盒替换为神话史诗视觉：

- 鸣灯域：雾蓝山脊、断桥、竹林、祭灯台和异常第二月亮；
- 天灯：暖金火种与墨黑裂纹，所有神迹使用几何符号而不是文字解释；
- 折灯者：折断的灯笼骨、反向火焰和被擦除的神相纹；
- 地图：五盏驿灯串成上行路线，章节外的八域保持半透明剪影；
- 角色：三人轮廓和身法拖尾承担识别，危险仍使用朱砂和固定形状。

每个新视觉资源都要通过现有导入、透明、宽屏和实际路线检查。Android 实机在关卡选择、剧情、商店和触屏身法都接入后再做完整性能验收。

## 10. 推荐开发顺序

```text
A 角色身法底座
  ↓
B 关卡目录 + 第二关灰盒
  ↓
C 星级 / 无伤印 / 发奖结果
  ↓
D 关卡地图 + 故事入口
  ↓
E 成长 / 商店 / 存档 v2
  ↓
F 神话史诗美术、音频、Android 验收
```

每个阶段都要先补测试，再接下一个阶段。A 和 C 是逻辑基础；本轮提前落实 E 中的奖励存档事务，因此 C 可以接真实铜钱；购买、库存与消费仍需独立实现和验收；F 等所有状态字段稳定后再制作最终 UI 和剧情动画。

## 11. 第一批可直接创建的任务

1. 新增 `MobilityData` / `MobilityRuntime`，把 `PlayerController` 的共享 `dash` 改成 `mobility`。
2. 新增 `wind_scout.tres`、`thunder_guard.tres` 和三种身法占位资源。
3. 新增 `tests/test_mobility.gd`，先让影刃新输入通过，再接岚织和烬锋。
4. 新增 `LevelCatalog` 和 `wind_bamboo_85s.tres`，实现落竹灰盒与 50 颗影晶。
5. 扩展 `RunResult` / `RunHistory`，加入星级、无伤印和规则版本，保持旧 rank 迁移。
6. 新增 `RewardService`，先用日志结算摘要，再接真实铜钱。
7. 新增 `level_select.tscn`，先显示五个驿灯节点和第一关历史纪录。

## 12. 阶段完成定义

当以下条件同时满足，才可以从“设计拆分”进入“正式实现”：

- 角色身法输入和触屏语义已经统一；
- 第二关有基础二段跳主路线和三名角色替代路线；
- 星级与无伤印可从原始结果确定性复算；
- 发奖和商店有稳定 transaction ID，不依赖 UI 动画；
- 旧存档能读取、迁移、备份和重试保存；
- 关卡选择、剧情已读、角色解锁和练习模式边界明确；
- 每阶段新增回归加入 Windows 全套测试，并在 Android 上验证触屏与性能。
