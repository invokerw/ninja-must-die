# 影刃疾行

Godot 4.7 钢索控制切片原型。当前包含单根钢索自动奔跑、上下翻转、跳离/重新抓绳、松绳下落、影步、上下侧障碍预警、影晶收集、终点进度、计时、评级和失败重试。

## 运行

使用 Godot 打开 `project.godot`，按 F6/F5 运行主场景。此项目使用 GDScript，不需要 .NET 编译。

本机已检测到 Godot：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path .
```

## 操作

- `Space` / `W` / `↑`：钢索下翻回上方；钢索上跳离钢索；空中二段跳或重新抓绳
- `S` / `↓`：钢索上翻到下方；钢索下松绳下落
- `Shift`：影步
- `J` / `K`：为后续战斗切片预留，当前控制切片暂未启用
- `Esc`：暂停/继续
- `R` / `Enter`：重新开始

普通跳跃和二段跳下落时会自动落回钢索，无需再次按键抓绳；在钢索下方再次按 `↓` 才会主动松绳坠落。

普通影晶位于钢索上下两侧的角色身位内，翻到对应一侧后保持附着即可收集，钢索下的影晶无需松绳去追。

## 控制回归测试

覆盖单跳、二段跳、长按跳跃、快速下落、高速跨绳、上升穿绳、手动抓绳和上下翻绳/主动松绳。测试通过时输出 `ROPE_LANDING_PASS (8 scenarios)`。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --log-file /tmp/ninja-rope-landing.log --fixed-fps 60 --script res://tests/test_rope_landing.gd
```

影晶收集测试遍历实际关卡的全部影晶，验证正确侧能收集、另一侧不能收集，且不需要跳跃或松绳。通过时输出 `ROPE_PICKUPS_PASS`。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --headless --path . --log-file /tmp/ninja-rope-pickups.log --fixed-fps 60 --script res://tests/test_rope_pickups.gd
```

## 当前范围

这是 20～30 秒钢索控制切片，地图使用代码绘制的占位视觉，正式资源按 `docs/GAME_DESIGN.md` 的 imagegen 规范替换。当前没有敌人、首领、存档和移动端触屏控件。障碍接近时会在机关旁显示脉冲预警，HUD 同时显示下一处机关的上下侧和预计到达时间。

## 文档

- [游戏设计文档](docs/GAME_DESIGN.md)
- [资源生成状态](art/README.md)

