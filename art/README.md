# 资源生成状态

正式 UI 视觉和游戏图片必须使用图片生成工具制作，并遵循 `docs/GAME_DESIGN.md` 的第 9.3 节。

当前环境没有可调用的内置 `imagegen` 工具，因此控制切片暂时使用代码绘制的占位图形；这些图形不作为正式资源。

后续生成顺序：

1. `style_guide/style_anchor.png`：统一风格锚点。
2. `generated/characters/char_shadow_runner_v01.png`：玩家透明背景精灵。
3. `generated/environments/env_fog_ridge_bg_v01.png`：雾岭断桥背景。
4. `generated/ui/ui_panel_hud_v01.png`：HUD 面板底图。
5. 对应的 `.prompt.md` 存到 `prompts/`。

生成时保持墨夜、雾蓝、朱砂、暖金和月光色板，左上方月光，水墨轮廓与手绘 2D 风格。

