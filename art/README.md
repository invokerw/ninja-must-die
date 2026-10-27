# 美术设计与资源状态

正式 UI 视觉和游戏图片使用内置图片生成工具制作，遵循 [游戏设计第 9.3 节](../docs/GAME_DESIGN.md)。美术方向、玩法尺寸约束、资源拆分和制作顺序见 [正式美术设计](../docs/ART_DIRECTION.md)。

设计稿拆层与资源接入采用 [设计稿 → 分层 PSD → Godot 资源](../docs/ART_PIPELINE.md) 流程。UI v02 已于 **2026-10-26 18:36（上海时间）** 完成拆层：1672×941、40 层 PSD，其中 39 个非背景图层带透明区域。结构校验与实际 PSD 读回检查通过；视觉状态为 **needs_review，候选资源，待用户验收**。运行记录见 [pipeline_runs.json](pipeline_runs.json)。

候选文件为 [layers.psd](workbench/ui_touch_combat_v02_20261026_01/layers.psd)，图层 PNG 路径见 [layers.json](workbench/ui_touch_combat_v02_20261026_01/layers.json)。统一检查页为 [result.html](http://127.0.0.1:8925/ui_touch_combat_v02_20261026_01/result.html)，包含原图 / 合成叠加、递归过程、图层检查和 PSD 下载。

检查发现顶部进度条出现重复节点，钢索粗细和两端固定件与原图不同，按钮材质、图标及角色 / 背景细节存在模型重绘差异，详见 [视觉检查记录](workbench/ui_touch_combat_v02_20261026_01/inspection/visual_review.json)。结构通过不代表原图保真通过；本次保真状态为 `not_applicable`。原始 PSD 保留这些问题，候选结果保持 `runtime_ready: false`。

## UI 组件与 Godot 候选预览

2026-10-26 已整理 [UI v02 组件包](layered/ui_touch_v02_candidate/README.md)：10 张透明 PNG（五个按钮的独立底板与图标），均与原拆层文件逐字节一致；附完整 PSD、来源与校验清单。新增独立的 [Godot 预览场景](../scenes/art/ui_touch_preview.tscn)，复用真实触摸逻辑，以运行时颜色、缩放、圆弧和文字表现可用、按下、禁用与冷却状态。进度条使用 Godot 动态绘制，避免重复节点；钢索和场景仍沿用现有占位视觉。

候选预览通过全套触摸行为回归和底部安全区文字检查，首领回放为 36.10 秒、0 受击；已检查 1280×720 / 1600×720 原尺寸画面。默认主场景和正式导出未启用候选 UI，用户视觉验收及 Android 实机检查仍待进行。截图已加入上述统一检查页。

## 2026-10-26 首轮设计稿

本轮已取得并保存可查看的原始 PNG。以下三张用于方向评审，状态为 **已生成并检查，待用户评审，未接入运行时**。

| 图片 | 尺寸 | 用途 | 提示词 |
| --- | --- | --- | --- |
| [风格锚点](style_guide/style_anchor.png) | 1672×941 | 雾岭断桥环境、色板、光向和材质参考 | [设计输入](prompts/style_anchor.prompt.md) / [工具实际提示词](prompts/style_anchor.generated.prompt.txt) |
| [影刃角色设定 v01](concepts/char_shadow_runner_design_v01.png) | 1536×1024 | 角色外观与六种视图 / 姿态参考 | [设计输入](prompts/char_shadow_runner_design_v01.prompt.md) / [工具实际提示词](prompts/char_shadow_runner_design_v01.generated.prompt.txt) |
| [触屏战斗界面 v02](concepts/ui_touch_combat_design_v02.png) | 1672×941 | 两左三右按键与战斗画面的视觉组合 | [修订输入](prompts/ui_touch_combat_design_v02.prompt.md) / [工具实际提示词](prompts/ui_touch_combat_design_v02.generated.prompt.txt) |

界面 v02 修正了 v01 的双侧尖刺、过大的角色与过高的收集物排列，保留上下翻绳的安全路线。实际钢索高度、触摸按钮边距等仍以游戏的 1280×720 设计坐标与安全区布局为准。界面 v01 保存在 `concepts/ui_touch_combat_design_v01.png` 作为探索历史，不再用作后续制作参考。

生成方式为内置 `image_gen`，没有使用 CLI/API 密钥回退。文件保存的是工具返回的原始 PNG，没有把截图、重绘或放大结果冒充原图。`prompts/*.generated.prompt.txt` 记录本次工具实际使用的提示词；[资源清单](assets_manifest.json) 记录尺寸、SHA-256、生成标识和评审状态。

## 当前边界与后续制作

当前 `concepts/` 是设计参考，`style_guide/style_anchor.png` 是整体环境锚点；它们均不是已通过游戏内验收的生产资源。游戏继续使用现有占位视觉。

后续按正式美术设计中的 P1 → P2 → P3 制作：

1. 独立透明角色精灵、分层背景、钢索 / 机关 / 影晶、基础图标与按钮。
2. 角色动作、武器、敌人、首领和特效。
3. 准备页、设置、暂停、结算和正式应用图标。

生产资源放到 `generated/characters/`、`generated/environments/`、`generated/enemies/`、`generated/ui/`、`generated/fx/` 等目录；每个资源保留对应提示词及版本。当前正式生产资源尚未验收；`layered/ui_touch_v02_candidate/` 仅作为独立预览使用，不将设计稿或候选组件计为正式完成。

2026-10-23 的早期战斗图集请求未返回可访问文件，历史提示词保留在 [combat_atlas_v01.prompt.md](prompts/combat_atlas_v01.prompt.md)；该请求继续标记为未交付。
