# 行前准备 v02 · 已接入候选纹理

2026-11-12 按用户“可以实现”的概念审核接入；用户视觉 / 手感已于 2026-11-12 验收通过；Android 实机尚待验收。原图、PSD、透明边界、哈希与重建方式见[分层候选](../../../../layered/ui/character_setup/v02/README.md)。

- `shadow_runner_portrait.png`、`wind_scout_portrait.png`、`thunder_guard_portrait.png`：提取的圆形头像，按角色资源读取；烬锋保留灰度锁定状态。
- `wind_scout.png`：岚织预览立绘，直接模型 RGBA 放置层的逐字节复制。
- `shadow_runner.png`：内置生图的独立透明立绘下采样，仅用于准备页；不替换局内动作精灵。

来源与实际检查见[任务卡](../../../../validation/ui/character_setup/v02/README.md)。动态文字、锁定、状态、按钮、冷却继续由 Godot 绘制。原生导入 `.import` 由 Godot 管理，未手工改 UID。
