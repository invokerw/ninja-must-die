# 影刃疾行

Godot 4.7 控制切片原型。当前包含自动奔跑、跳跃、二段跳、影步、基础障碍、影能收集、计时、评级和失败重试。

## 运行

使用 Godot 打开 `project.godot`，按 F6/F5 运行主场景。此项目使用 GDScript，不需要 .NET 编译。

本机已检测到 Godot：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path .
```

## 操作

- `Space` / `W` / `↑`：跳跃，空中再次按下二段跳
- `S` / `↓`：快速下落
- `Shift`：影步
- `J` / `K`：为后续战斗切片预留，当前控制切片暂未启用
- `Esc`：暂停/继续
- `R`：重新开始

## 当前范围

这是 20～30 秒控制切片，地图使用代码绘制的占位视觉，正式资源按 `docs/GAME_DESIGN.md` 的 imagegen 规范替换。当前没有敌人、首领、存档和移动端触屏控件。

## 文档

- [游戏设计文档](docs/GAME_DESIGN.md)
- [资源生成状态](art/README.md)

