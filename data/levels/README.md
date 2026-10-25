# 钢索关卡编辑

当前主场景的 `Level` 节点读取 `fog_ridge_60s.tres`。该资源使用 Godot 自定义 `Resource`，可在检查器中直接展开修改；`main.gd` 不再保存机关或影晶坐标。

F5 准备页选择完整关卡后，`scenes/main.tscn` 配置 `Boss Data=res://data/enemies/bridge_kite.tres`，在这条 60 秒路线之后进入约 40 秒首领追逐战。`scenes/practice.tscn` 将 `Boss Data` 设为空，保留原终点；`scenes/boss_practice.tscn` 直接进入首领。首领参数、攻击窗口与评级说明见 [小型首领](../../docs/BOSS_ENCOUNTER.md)。

## 当前路线

按 320 px/s 基础跑速计算，不使用影步约 60 秒。起点 X=160，终点 X=19360，总长度 19200 px。

| 时间 | 段落 ID | 名称 | 长度 | 机关 | 影晶 | 哨兵 | 右侧来袭 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0～10 秒 | `tutorial` | 钢索入门 | 3200 px | 3 | 7 | 0 | 0 |
| 10～25 秒 | `alternating` | 上下交替 | 4800 px | 7 | 14 | 2 | 1 |
| 25～45 秒 | `combinations` | 连续机关 | 6400 px | 13 | 18 | 2 | 1 |
| 45～60 秒 | `sprint` | 冲刺收尾 | 4800 px | 6 | 11 | 1 | 0 |

最后约 5 秒为奖励与终点缓冲区。全关仅上下翻绳即可完成；影步为可选操作，组合段另支持单跳和二段跳跨越机关。

## 编辑步骤

1. 在 Godot 文件系统中打开 `res://data/levels/fog_ridge_60s.tres`。
2. 展开 `Segments`，选择段落，修改 `Title`、`Hint` 和 `Length Px`。时间以世界位置触发，不依赖计时器，使用影步后提示仍跟随所在段落。
3. 展开段落的 `Hazards`：`Offset X` 是相对本段起点的横向距离；`Cable Side` 为上侧或下侧；`Size` 控制机关宽高。
4. 展开 `Pickups`：只设置 `Offset X` 和 `Cable Side`。影晶高度由角色的 `rope_offset` 决定，关卡数据不提供纵向偏移，防止超过身位。
5. 展开 `Enemies`：`Enemy Type=sentry` 使用 `Offset X` 放置普通接触哨兵，按 `Cable Side` 确定钢索侧别，`Health` 仅用于普通哨兵。`Enemy Type=shooter` 则把 `Offset X` 解释为开始右侧来袭的玩家进度，不生成钢索敌人；可编辑 `Screen Edge Offset`（48 px，正值在画外，负值在右边缘内）、`Screen Height Ratio`（屏幕高度比例）、`Windup Seconds`（0.8 秒）和 `Projectile Speed`（720 px/s）。`Fire Direction` 直接指定固定方向，不按玩家位置瞄准；`Volley Count` 控制并排数量（当前 3），`Volley Spacing` 控制弹道中心间距（当前 144 px）。`Cable Side` 仅提示主要危险侧，发射源的位置始终按屏幕计算。
6. 按 F5 运行并验收。关卡长度、背景钢索、相机右边界、进度、提示和评级基准都随数据更新。

资源中的默认跑速与 `res://data/control_tuning.tres` 的 `run_speed` 保持一致。修改基础跑速时同时调整 `Recommended Speed`，预警距离会按 `Warning Seconds` 换算；影步缩短实际通关时间。

## 摆放约束

- 每个段落 ID 唯一；机关和影晶的横坐标必须落在本段长度内。
- 相邻异侧危险物（机关或哨兵）扣除碰撞宽度和角色宽度后，至少保留 `Minimum Flip Window` 秒可翻绳空间，当前为 0.75 秒。
- 影晶与同侧危险物之间，扣除碰撞半宽和角色半宽后至少留 `Pickup Clearance`，当前为 80 px。
- 5 个普通哨兵均允许翻绳躲避或月蚀斩击破，不强制要求技能就绪。
- 两个右侧发射源分别在上下交替段 `offset_x=720` 触发下侧来袭、连续机关段 `offset_x=1680` 触发上侧来袭。下侧方向 `(-1, -0.04)`、高度 80%；上侧方向 `(-1, 0.12)`、高度 55%。它们没有钢索接触体，也不计入击破目标；两条无技能回放均经历 2 波、6 枚实际飞弹，仍能无伤全收集。
- 远程来袭必须保留至少 0.6 秒屏内预警，屏幕边缘偏移在 -96～128 px 之间，屏幕高度比例在 0.1～0.9 之间，飞弹速度大于基础跑速。方向须为有限非零向量，归一化后 X ≤ -0.85；数量 1～7 枚，多弹纵向中心间距至少 112 px。每枚飞弹的预计接触点均参与翻绳空间和影晶间隔校验；静态估算使用 1280×720，其他画幅与影步路线需要实际回放。
- 影晶位于对应侧的身体中心，不能跨钢索被另一侧拾取；不能用增大拾取范围掩盖摆放问题。
- 启动时检查以上数据约束，错误布局会显示加载失败。静态检查只负责基础间距；新的跳跃组合仍需实际输入回放和人工验收。

## 验证

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --log-file /tmp/ninja-level-route.log --fixed-fps 60 --script res://tests/test_level_route.gd
```

测试包括数据检查和四条跑酷练习无伤全收集路线：基础纯翻绳、基础二段跳 / 影步、冷却月蚀斩、三段跳 / 快速落绳 / 影步 / 技能；另回放两条包含真实首领击破的完整流程，检查分段提示顺序、暂停、重开和下侧终点。预期输出 `LEVEL_ROUTE_PASS`。5 处普通哨兵的技能命中另由 `tests/test_combat.gd` 回放，首领专项由 `tests/test_boss.gd` 验证。

投射物的固定方向、并排齐射、间隙躲避、完整飞行、单次接触、预警、无敌、高速碰撞与生命周期由 `tests/test_projectiles.gd` 验证，预期输出 `PROJECTILES_PASS`。完整规则见 [投射物与远程威胁](../../docs/RANGED_THREATS.md)。

影晶仅参与收集、评分和连击，不改变冷却；技能保护不清除机关。不要因加入三段跳抬高普通影晶，也不要编排必须依靠技能无敌才能通过的连续门槛。角色参数见 `data/characters/shadow_runner.tres` 和 `docs/CHARACTER_SKILL_DESIGN.md`。

调整机关与影晶后，应按新路线更新测试中的可选动作位置；纯翻绳路线和全部影晶位置从资源读取。
