# 正式美术首版 · 2026-10-27

默认流程的正式美术首版已接入，包含 32 张运行时纹理；用户视觉验收、最终细化及 Android 实机验证待进行。

- `ui/`、`collectibles/`：16 张按钮 / 图标 / 头像 / 面板 / 影晶，使用原模型 RGBA。冷却、文字、触点和禁用状态由真实游戏状态驱动。
- `characters/shadow_runner_v01.png`：1280×1024 RGBA 图集，20 个 256×256 帧。8 帧奔跑、4 帧挂绳、各 1 帧跳跃 / 下落 / 受击 / 死亡、各 2 帧翻绳 / 影步。来源、缩放、原点和边界见同名 JSON。
- `environments/fog_ridge_sky_v01.png`：独立天空及远山，1774×887 RGB，保留原始 PNG。单张覆盖屏幕，月亮不会重复。
- `environments/fog_ridge_middle_v01.png`：1582×887 RGBA 独立中景。192px 余弦接缝在预乘 Alpha 空间处理，清除 Alpha≤2 的空白噪点，端点像素一致，无镜像；随相机以 0.11 系数循环。
- `obstacles/steel_spike_v01.png`：256×256 RGBA。原生两次输出均为 RGB；最终从原画的直线三角轮廓制作遮罩并缩放，未声称原图拥有 Alpha。按实际机关宽高显示，下侧垂直翻转机关。
- `environments/fog_ridge_foreground_v01.png`：独立透明低位松石近景，可循环，位于游戏路线下方。原图为 RGB，连通外部底色遮罩后压缩高度 50%，不宣称原生透明。
- `combat/`：10 张首领 / 武器 / 哨兵 / 箭镖贴图。首领护甲与金色核心按真实弱点状态选择，强化不绕过护甲；碰撞与攻击时间不变。来源 RGB 经过连通外部中性色遮罩，保留封闭金属高光并缩放。
- `application/app_icon_v01.png`：原生头像缩放为 1024 方形图标，已在项目中配置。
- 特效采用程序绘制的渐细月弧、金色尾迹和碎屑，保持反馈开关与容量限制。
- 钢索使用编织、边光和暗部绘制，细节限制在镜头附近，首领长距离追逐不会累计全关纹理指令。

旧 `fog_ridge_panorama.png` 保留来源记录，`runtime_enabled=false`，已排除正式导出。`*_sources_20261027/` 和 `recovered_20261027/` 是原始结果与诊断，具有 `.gdignore`，亦排除导出。

角色保留实际绘制的不同姿态，通过统一原点对齐，没有把单个静态跑姿变形为动画，也没有倒置角色替代挂绳。原点 `(144,126)`，按 1/3 缩放。上侧脚底帧内 y=228，对应身体中心下方 34px；挂绳双手 y=24，对应身体中心上方 34px。腾空帧允许脚离绳。下侧影步继续使用挂绳姿态；碰撞、速度、跳数和技能时间不变。

## 来源与重建

新增 11 次请求使用内置 `image_gen`，结果从本地会话原生 `image_generation_call.result` 解码，未使用 CLI/API 回退。[角色 / 场景提示词](../prompts/p1_player_environment_20261027.md)、[战斗 / 图标提示词](../prompts/p2_combat_finishing_20261027.md)与原始来源 JSON 已保留。原来的 5 次空显示已独立 [诊断并恢复](recovered_20261027/diagnosis.md)。

```sh
python3 tools/art/export_production_art.py
python3 tools/art/verify_production_art.py
```

需要 Pillow、NumPy；UI 重建还需既有 workbench 源文件。角色、场景和机关也可分别运行 `build_player_art.py`、`build_environment_art.py`、`build_interaction_art.py`、`build_combat_art.py`、`build_finishing_art.py`。重建保留诊断和请求状态。触屏布局使用 `scripts/ui/touch_art_layout.gd`，运行时不依赖 JSON。

## 验证与待办

最新截图、逐帧检查、实际游戏奔跑动画及回归结果位于 `art/validation/p1_player_20261027/`；最终 `art/validation/p2_combat_20261027/validation.json` 汇总 12 套回归与独立 PCK 检查结果。原首批界面证据保留在 `p1_20261027/`。

导出检查使用 `--export-pack 'Windows Desktop'` 生成独立 PCK，再从空工作目录运行 `tools/art/check_exported_art.gd`，检查角色、界面、独立场景、机关、准备页，以及源图 / JSON 的隔离。通过标识为 `EXPORTED_ART_PASS`。

剩余：用户视觉评审、最终动作 / 画面细化和 Android 实机验证。详见 [美术进度](../../docs/ART_PROGRESS.md)。
