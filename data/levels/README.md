# 钢索关卡编辑

当前主场景的 `Level` 节点读取 `fog_ridge_60s.tres`。该资源使用 Godot 自定义 `Resource`，可在检查器中直接展开修改；`main.gd` 不再保存机关或影晶坐标。

## 当前路线

按 320 px/s 基础跑速计算，不使用影步约 60 秒。起点 X=160，终点 X=19360，总长度 19200 px。

| 时间 | 段落 ID | 名称 | 长度 | 机关 | 影晶 | 哨兵 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 0～10 秒 | `tutorial` | 钢索入门 | 3200 px | 3 | 7 | 0 |
| 10～25 秒 | `alternating` | 上下交替 | 4800 px | 7 | 14 | 3 |
| 25～45 秒 | `combinations` | 连续机关 | 6400 px | 13 | 18 | 3 |
| 45～60 秒 | `sprint` | 冲刺收尾 | 4800 px | 6 | 11 | 1 |

最后约 5 秒为奖励与终点缓冲区。全关仅上下翻绳即可完成；影步为可选操作，组合段另支持单跳和二段跳跨越机关。

## 编辑步骤

1. 在 Godot 文件系统中打开 `res://data/levels/fog_ridge_60s.tres`。
2. 展开 `Segments`，选择段落，修改 `Title`、`Hint` 和 `Length Px`。时间以世界位置触发，不依赖计时器，使用影步后提示仍跟随所在段落。
3. 展开段落的 `Hazards`：`Offset X` 是相对本段起点的横向距离；`Cable Side` 为上侧或下侧；`Size` 控制机关宽高。
4. 展开 `Pickups`：只设置 `Offset X` 和 `Cable Side`。影晶高度由角色的 `rope_offset` 决定，关卡数据不提供纵向偏移，防止超过身位。
5. 展开 `Enemies`：设置 `Offset X`、`Cable Side` 和 `Health`。哨兵固定在对应身体高度，当前默认 1 生命；接触伤害为 1。月蚀斩伤害为 3，冷却 12 秒；没有普通近身攻击。
6. 按 F5 运行并验收。关卡长度、背景钢索、相机右边界、进度、提示和评级基准都随数据更新。

资源中的默认跑速与 `res://data/control_tuning.tres` 的 `run_speed` 保持一致。修改基础跑速时同时调整 `Recommended Speed`，预警距离会按 `Warning Seconds` 换算；影步缩短实际通关时间。

## 摆放约束

- 每个段落 ID 唯一；机关和影晶的横坐标必须落在本段长度内。
- 相邻异侧危险物（机关或哨兵）扣除碰撞宽度和角色宽度后，至少保留 `Minimum Flip Window` 秒可翻绳空间，当前为 0.75 秒。
- 影晶与同侧危险物之间，扣除碰撞半宽和角色半宽后至少留 `Pickup Clearance`，当前为 80 px。
- 哨兵必须允许翻到另一侧躲避，不强制要求技能就绪。当前 7 处遭遇均已验证可用月蚀斩安全击破，基础二段跳无技能路线也能无伤全收集。
- 影晶位于对应侧的身体中心，不能跨钢索被另一侧拾取；不能用增大拾取范围掩盖摆放问题。
- 启动时检查以上数据约束，错误布局会显示加载失败。静态检查只负责基础间距；新的跳跃组合仍需实际输入回放和人工验收。

## 验证

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --log-file /tmp/ninja-level-route.log --fixed-fps 60 --script res://tests/test_level_route.gd
```

测试包括数据检查和四条无伤全收集路线：基础纯翻绳、基础二段跳 / 影步、冷却月蚀斩、三段跳 / 快速落绳 / 影步 / 技能；另检查分段提示顺序、暂停、重开和下侧终点。预期输出 `LEVEL_ROUTE_PASS`。7 处哨兵的技能命中另由 `tests/test_combat.gd` 回放。

影晶仅参与收集、评分和连击，不改变冷却；技能保护不清除机关。不要因加入三段跳抬高普通影晶，也不要编排必须依靠技能无敌才能通过的连续门槛。角色参数见 `data/characters/shadow_runner.tres` 和 `docs/CHARACTER_SKILL_DESIGN.md`。

调整机关与影晶后，应按新路线更新测试中的可选动作位置；纯翻绳路线和全部影晶位置从资源读取。
