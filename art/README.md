# 资源生成状态

正式 UI 视觉和游戏图片必须使用图片生成工具制作，并遵循 `docs/GAME_DESIGN.md` 的第 9.3 节。

2026-10-23 的基础战斗阶段已通过内置图片生成工具发起两次风格图集生成，但工具响应均未返回可访问的图片或本地文件。本轮没有可检查、可导入的正式 PNG；不能将生成请求视为已交付资源。当前继续使用代码绘制的占位图形，不能作为正式资源发布。

本轮提示词保存在 `prompts/combat_atlas_v01.prompt.md`，目标为同风格的角色、哨兵、月蚀斩图标和 HUD 底图。状态：**待取得生成结果并检查**。未切换到需要单独 API 密钥的 CLI 工作流。

后续生成顺序：

1. `style_guide/style_anchor.png`：统一风格锚点。
2. `generated/characters/char_shadow_runner_v01.png`：玩家透明背景精灵。
3. `generated/environments/env_fog_ridge_bg_v01.png`：雾岭断桥背景。
4. `generated/ui/ui_panel_hud_v01.png`：HUD 面板底图。
5. 对应的 `.prompt.md` 存到 `prompts/`。

生成时保持墨夜、雾蓝、朱砂、暖金和月光色板，左上方月光，水墨轮廓与手绘 2D 风格。

