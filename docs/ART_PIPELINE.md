# 设计稿 → 分层 PSD → Godot 资源

2026-10-26：本机已安装 `extract-layered-psd` skill，使用现有 `screenshot-to-psd` 源码引擎。用户授权的 UI v02 拆层任务于 **18:36:48（上海时间）** 完成，生成 **1672×941、40 层 PSD**，其中 39 个非背景图层带透明区域。结构校验和实际 PSD 读回检查通过；助手视觉检查发现进度条重复节点、钢索连接及重绘细节差异，结果保持 **候选 / needs_review / runtime_ready: false**，等待用户视觉验收。

统一入口：[本地 result.html 检查页](http://127.0.0.1:8925/ui_touch_combat_v02_20261026_01/result.html)。候选 PSD、透明 PNG、模型原始响应和全部失败记录保留在原任务目录；自动续跑已完成退出，候选交付检查后已删除 `ui-psd` 心跳。本地预检及历史失败过程见下文，不再代表当前交付状态。

## 制作流程

1. **生成设计稿。** 使用内置图片生成工具，参照 [美术方向](ART_DIRECTION.md) 和角色 / 环境参考。保留原始 PNG、提示词、版本和资源清单。先确定布局与视觉方向，再制作资源。
2. **拆成 PSD。** 将选定设计稿交给 `extract-layered-psd`。它通过用户本地配置的模型服务提取透明对象、补全被遮挡的底图，导出 PSD、图层 PNG 和检查报告。每次新转换使用独立空目录。
3. **检查并修整。** 在统一 `result.html` 中叠加原图和合成图，逐层查看按钮、图标、面板、角色和背景。检查漏件、边缘杂色、比例、透明度和遮挡顺序。结构校验通过只说明 PSD 与导出图层一致，不证明与原图一致。
4. **导出候选资源。** 将选中的透明 PNG、PSD 和导出清单放在版本目录，记录原图、拆层任务、图层名、尺寸、透明边界和实际检查结果。未经评审的图层保持 `runtime_ready: false`，不直接覆盖运行时贴图。
5. **接入游戏。** 按 1280×720 设计坐标、安全区和现有判定配置定位贴图，制作按钮状态与面板拉伸。生命、影晶数、进度、文字和冷却交给 Godot 节点绘制。完成实际画面和相关玩法验证后才更新资源状态。

PSD 中的模型文字也是栅格图层，不能按可编辑字体交付。遮挡后的形状与半透明材质无法由一张图唯一恢复；拆层结果是资源制作的候选输入，缺失动作、无缝背景和按钮状态需要继续制作。

完整战斗构图用于方向评审和本次流程验证。后续可复用 UI 单独出组件稿，清楚展示五个操作按钮、图标、通用底板和 HUD 面板，减少与场景、角色的遮挡；角色动作和场景图层分别制作。组件稿不把动态数值或冷却效果画入常态贴图。

## 本机调用

Skill 安装在 `~/.codex/skills/extract-layered-psd`。可以在后续对话中说：

> 使用 $extract-layered-psd 将指定的界面设计稿拆成分层 PSD，检查图层和原图差异，再导出通过检查的 UI 候选 PNG。

本机采用源码模式，保留工具仓库及其私有配置。系统默认 Node 为 12，执行时指定已通过预检的 Node 24；如果工作区运行时路径改变，重新定位 Node 20+。以下命令在本项目根目录运行：

```sh
PSD_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
PSD_SKILL="$HOME/.codex/skills/extract-layered-psd"
PSD_ENGINE="$HOME/code/github/screenshot-to-psd"
PSD_SOURCE="$PWD/art/concepts/ui_touch_combat_design_v02.png"
PSD_OUT="$PWD/art/workbench/ui_touch_combat_v02_$(date +%Y%m%d_%H%M%S)"

"$PSD_NODE" "$PSD_SKILL/scripts/run.cjs" preflight \
  --project "$PSD_ENGINE" --config "$PSD_ENGINE/config.json"

"$PSD_NODE" "$PSD_SKILL/scripts/run.cjs" run \
  --project "$PSD_ENGINE" --config "$PSD_ENGINE/config.json" \
  --source "$PSD_SOURCE" --output "$PSD_OUT" \
  --visual-window 3 --local-detection-inputs --combined-detection \
  --serve --port 8925
```

`run` 会把设计稿及中间图发送到现有配置的模型服务，并产生模型调用。本次 UI v02 验证已获用户明确授权并执行，结果见下方实测记录。不得将私有 `config.json`、`.env.local` 或密钥复制到本项目。

已有结果可通过 `report` 重开检查页，不调用模型：

```sh
"$PSD_NODE" "$PSD_SKILL/scripts/run.cjs" report \
  --project "$PSD_ENGINE" --output "$PSD_OUT" --serve --port 8925
```

任务中断时只在源图、引擎和参数保持一致的情况下，用原命令追加 `--resume`；不要修改 manifest 绕过身份检查。工具源码有本地修改，本安装使用当前源码与依赖，不是固定版本的便携发布包。

## 目录与交付

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `art/concepts/` | 原始界面 / 角色设计稿 | 保留版本与来源 |
| `art/workbench/` | CLI 原始任务、模型响应、代码快照、诊断图、PSD 和报告 | 本地工作文件，Git 忽略；`.gdignore` 防止 Godot 批量导入 |
| `art/layered/<设计版本>/` | 整理后的 PSD、候选图层与导出清单 | UI v02 已整理 10 张候选 PNG 与完整 PSD，供独立 Godot 预览 |
| `art/generated/ui/` 等 | 完成制作并按游戏规格整理的资源 | 接入前单独验收；当前尚未生成 |

首个拆层样本采用 `ui_touch_combat_design_v02.png`。重点检查左侧跳跃和翻绳两个独立按钮、右侧影步 / 武器 / 忍术三个按钮，以及顶部 HUD。下侧跳跃禁用、空中翻绳键快速下落等状态由运行时代码控制，不能从一张静态设计稿推定已经制作齐全。

本次已核对 `run_result.json`、`verification.json`、`fidelity_verification.json`，并将实际 PSD 读回结果及助手视觉检查记录保存在 `inspection/`。原始 `workbench` 证据保留；后续整理的 UI 组件和完整 PSD 位于 `art/layered/ui_touch_v02_candidate/`，仅用于独立美术预览，未启用到默认游戏或正式导出。

## 2026-10-26 UI 组件预览

用户要求继续下一步后，选择五个操作按钮的底板和图标，逐字节导出 10 张 PNG。`tools/art/export_ui_candidate.py` 验证原始 PSD 和每张源图的哈希，保留 native 尺寸、透明通道和图层坐标；[组件清单](../art/layered/ui_touch_v02_candidate/manifest.json) 记录一对一来源。没有新模型请求、像素修复或对原任务 manifest 的改写。

`scenes/art/ui_touch_preview.tscn` 和 `ui_touch_boss_preview.tscn` 是独立的 Godot 候选预览，复用 `TouchControls` 的输入、生命周期和安全区布局；新增脚本只负责候选皮肤、动态文字 / 冷却与预览入口。下侧跳跃真实禁用，翻绳键按当前状态显示方向提示；冷却由实际玩法计时驱动。贯星矛继续使用既有矢量图形，避免把弦月轮图标误用于另一把武器。进度线与四个节点由单个 Godot 控件绘制，原 PSD 中的问题图层不参与预览。

验证包括复用全套触摸回归、36.10 秒无伤首领回放、新增底部安全区文字边界检查，以及 1280×720 / 1600×720 图形渲染。可在 Godot 打开预览场景按 F6；macOS 命令与状态边界见 [组件说明](../art/layered/ui_touch_v02_candidate/README.md)。截图和原尺寸控件对比加入同一 `result.html`，验证摘要在 [preview_validation.json](../art/layered/ui_touch_v02_candidate/preview_validation.json)。

当前 `preview_ready: true`、`runtime_ready: false`；尚待用户视觉验收和 Android 实机检查。默认主场景未引用候选皮肤，Windows / Android 导出配置排除了 `art/layered/*`、`scenes/art/*` 和 `scripts/art/*`。预览通关不写入正式成绩；原始钢索、角色、场景和 HUD 面板等后续资源继续单独制作。

## 2026-10-26 完成与候选验收

- 自动续跑第 **15 轮** 使用原有成功缓存完成剩余拆层，进程于 **18:36:51** 正常退出；没有重建已成功图集或修改 manifest 绕过身份检查。
- 3 轮视觉提取共得到 38 个视觉图层，加上 1 个栅格文字图层和 1 个背景，共 **40 层**。PSD 文件为 **9,769,811 字节**。
- 重新读取实际 PSD：40 层的名称、位置、尺寸和 RGBA 与导出 PNG 一致；PSD 合成与最终合成一致。39 个非背景图层含透明像素；模型放置未发现放大。
- `verification.json` 为 `passed`；`psd_layer_rgba_exact`、`psd_composite_exact`、`loop_inputs_byte_identical` 均为 `true`。这些检查证明导出结构一致。
- `fidelity_verification.json` 为 `not_applicable`，原图不透明像素检查数为 0。本轮直接使用模型 RGBA 并下采样，不宣称与原图像素一致。
- 助手已查看整图、原模型裁切、放置图层、合成图及关键按钮边缘；视觉状态为 `needs_review`，用户验收为 `pending`，`runtime_ready` 为 `false`。

需要后续处理的视觉问题：顶部进度横轨的模型返回仍带圆点，叠加独立节点后出现重复圆点和线段，部分节点变窄；钢索变细，两端固定件的形状与连接位置改变；按钮边框、铆钉、图标倒角及角色 / 背景细节存在重绘差异。已检查的主要按钮裁切未见明显矩形背景或邻接按钮碎片，但不能据此宣称所有边缘完美。所有观察和原尺寸对比保存在 [visual_review.json](../art/workbench/ui_touch_combat_v02_20261026_01/inspection/visual_review.json)。本次没有自动修图或覆盖原始证据。

| 交付 / 证据 | 路径 |
| --- | --- |
| 候选 PSD | [layers.psd](../art/workbench/ui_touch_combat_v02_20261026_01/layers.psd) |
| 透明图层路径与位置 | [layers.json](../art/workbench/ui_touch_combat_v02_20261026_01/layers.json) |
| 最终合成 | [recomposed.png](../art/workbench/ui_touch_combat_v02_20261026_01/recomposed.png) |
| 运行与结构 / 保真结果 | [run_result.json](../art/workbench/ui_touch_combat_v02_20261026_01/run_result.json)、[verification.json](../art/workbench/ui_touch_combat_v02_20261026_01/verification.json)、[fidelity_verification.json](../art/workbench/ui_touch_combat_v02_20261026_01/fidelity_verification.json) |
| 实际 PSD 读回与图像哈希 | [artifact_readback.json](../art/workbench/ui_touch_combat_v02_20261026_01/inspection/artifact_readback.json) |

`run_result.elapsed_seconds = 24281.626` 是从最初开始到最终完成的累计墙钟时间，包含失败、暂停和恢复；不能当作一次成功请求耗时。最后一轮续跑耗时 570.124 秒，复用了此前成功缓存，也不代表完整拆层的独立耗时。

### 超时修复与真实请求验证

用户提供的 Nginx 排查显示：16:52 将实际 `proxy_read_timeout` 调整为 3000 秒后，早先约 300 秒的 504 转为客户端先断开的 499。客户端检查发现 SDK 已配置 1800000 毫秒，但 Node 24 的底层 Undici 还有独立的 300000 毫秒响应头 / 响应体等待限制。本地回环探针复现了底层 `UND_ERR_HEADERS_TIMEOUT` 被 SDK 转成通用 `Request timed out`；历史线上失败未直接捕获这个原始错误码，因此这是结合日志和探针得到的诊断。

本任务在 `supervisor/transport-preload.cjs` 中通过公开 dispatcher API，仅为现有 `api.ergou.vip` 设置 1800000 毫秒的头 / 体超时；没有更改源图、模型配置或引擎身份。5 项本地传输检查与 11 项引擎离线检查通过。修复后的真实底图补全请求持续 **826.661 秒（13 分 47 秒）** 后返回 HTTP 200，证明请求可以跨过 300 秒。之后第二视觉轮曾收到上游 502，第 15 轮恢复缓存后成功完成。

诊断证据见 [timeout_analysis.md](../art/workbench/ui_touch_combat_v02_20261026_01/supervisor/diagnostics/timeout_analysis.md)、[传输修复检查](../art/workbench/ui_touch_combat_v02_20261026_01/supervisor/diagnostics/transport_fix_checks_result.json)。模型仍为控制 `gpt-6.1-sol` / 图像 `gpt-image-2.5-sunburst`；私有配置和密钥留在原工具目录。

## 2026-10-26 初次失败记录（历史）

- 任务：`ui_touch_combat_v02_20261026_01`，输入原始 UI v02（1672×941）。
- 安装与本地检查：skill 官方校验通过，安装后 runner 帮助与预检通过，使用 Node v24.22.1；本地配置与密钥没有复制进项目。
- 当前控制模型为本地配置的 `gpt-6.1-sol`，图像模型为 `gpt-image-2.5-sunburst`；本次保留原配置。
- 在线结果：耗时 **608.505 秒（约 10 分 9 秒）**，7 个文字检测区域保存了 4 个响应；其余请求在工具自带的一次传输重试后仍出现 HTTP 504 / 超时，`loop1_text_bbox` 失败。
- 没有进入视觉拆层，没有生成 PSD、透明图层或最终合成图，结构与保真检查均为 `not_checked`。本次不证明后续拆层和导出能够完成。
- 原始日志与统一检查页保留在 `art/workbench/ui_touch_combat_v02_20261026_01/`；本地报告服务端口为 8925。可移植的摘要见 [pipeline_runs.json](../art/pipeline_runs.json)。

当时采用同一原任务追加 `--resume`，按身份规则复用有效检测响应，未更换模型。若更改控制模型、引擎或其他受检查参数，应使用新的空目录，不修改旧 manifest。当前任务已经完成，不需要再次启动转换。

## 2026-10-26 恢复实测（历史）

用户要求恢复原任务后，使用完全相同的源图、引擎、模型配置和参数再次运行。第二次运行从 2026-10-26 13:40（上海时间）开始，约 **10 分 7 秒** 后仍在 `loop1_text_bbox` 收到 504 / 请求超时，工具自带重试后失败。任务没有产生 PSD、透明图层或视觉轮次。第二次结果追加记录在 [pipeline_runs.json](../art/pipeline_runs.json)；原任务目录和本地结果页继续保留，等待网关恢复后再按相同身份恢复。

## 2026-10-26 第二次恢复实测（历史）

按用户要求，保持原任务身份再次恢复。执行时间为 **14:27:07 至 14:37:13（上海时间）**，本次耗时 **606.037 秒（约 10 分 6 秒）**。`roi_3` 和 `roi_5` 成功返回并保存，文字检测进度从 4/7 推进到 **6/7**；仅 `roi_2` 在内置传输重试后仍请求超时，任务终止于 `loop1_text_bbox`。

本次未进入视觉拆层，尚无 PSD 或透明图层。原任务及六个有效区域响应保留，下次恢复可按身份规则复用。CLI 的总墙钟耗时包含各次执行之间的暂停；[pipeline_runs.json](../art/pipeline_runs.json) 现分别记录单次执行耗时和含暂停的累计墙钟耗时，避免混淆。

## 持续自动续跑（已完成）

2026-10-26，用户明确要求持续重试直到成功，随后启动本地串行续跑进程，使用原始输入、引擎、模型配置和参数，从剩余 `roi_2` 开始恢复。进程最终在第 15 轮验证完成后自动退出。以下为保留的续跑策略和过程：

- 临时网络、504 / 超时等错误：等待 60 秒后恢复，连续无进展时逐步延长到最多 300 秒；新进展会重置等待间隔。没有总重试次数上限，不同时启动两次转换。
- 配置、身份、权限或确定的处理错误：记录为 `needs_attention`，交由检查任务诊断；不修改原 manifest 绕过检查。
- 停止条件：CLI 完成、独立结构验证通过，并确认 PSD 文件存在且格式头有效；随后检查实际图层与原图差异，记录候选资源状态。
- 运行状态和每轮日志位于原任务的 `supervisor/`；`retry_status.json` 记录当前轮次、活动状态及下次重试时间，`attempts.jsonl` 保留开始 / 结束记录。
- 续跑期间使用每 5 分钟检查一次的线程心跳 `ui-psd`：运行或等待时保持单个工作进程，仅在有新进展、完成或需用户处理时通知。候选交付检查完成后已删除该心跳，关闭状态记录在 `pipeline_runs.json`。

续跑器没有修改转换引擎，也没有更换模型或 key。模拟检查已验证：暂时失败后恢复、避免重复启动、验证完成后停止、权限错误不循环重试、源图身份改变时不发送请求。模拟检查不等同于本次在线转换成功。

### 文字检测完成

2026-10-26 上海时间 15:16，自动续跑第 2 轮取得剩余 `roi_2` 的有效响应，文字检测达到 **7/7**，随后进入文字图层提取及无文字底图补全。这是历史中间里程碑；最终 PSD 已于 18:36 完成，见本页的候选验收记录。

## 2026-10-27 部分资源接入

选用已有模型 RGBA 图层，复制出独立运行时 UI、头像、面板与影晶；不重新启动 PSD 拆层，不修改原始 PSD，也不改写历史视觉验收结论。背景使用已保存的风格锚点下采样，并附加水平镜像形成循环全景；两个连接处像素连续，但地貌存在镜像对称，不代替独立场景图层生产。

来源 SHA-256、尺寸、透明边界与变换操作见 `art/generated/manifest.json`。原候选包、workbench、提示词、概念图及验证截图不进入正式导出；运行时使用 `art/generated/` 和 `scripts/ui/`，触屏布局以 GDScript 数据随包交付，不依赖来源 JSON。

本轮 5 次内置图片生成的原始结果均为 completed，PNG 已从会话记录恢复至 `art/generated/recovered_20261027/`。此前观察到界面空输出和默认目录无文件，误判为生成失败；详见该目录的 `diagnosis.md`。角色图无透明通道，尚未接入。原始请求保存在 `art/prompts/p1_generation_attempts_20261027.md`。没有使用 CLI/API 回退。当前仅为 P1 部分交付；角色、独立场景图层、钢索 / 机关及后续 P2/P3 仍待完成。检查、截图和重建说明见 [运行时资源](../art/generated/README.md)。

## 2026-10-27 角色与独立场景补充

已接入 20 帧角色、独立天空 / 循环中景和尖刺。原始输出分别保存在 `art/generated/*_sources_20261027/`，通过 `.gdignore` 及导出过滤与运行时隔离。三份 `build_*_art.py` 脚本负责统一帧原点、保留 / 清理 Alpha、循环接缝和三角遮罩，`export_production_art.py` 可一并重建。处理与原始提示词见 `art/prompts/p1_player_environment_20261027.md`，当前计划见 [美术进度](ART_PROGRESS.md)。早期“角色未接入 / 无独立图层”的记录为本次补充前状态。

## 2026-10-27 首版覆盖默认流程

随后接入首领四状态、哨兵、武器 / 弹体、低位近景、程序月弧 / 碎屑效果和应用图标，当前共 32 张运行时纹理。`build_combat_art.py` 与 `build_finishing_art.py` 同样纳入统一重建；RGB 遮罩处理和未选用变体明确记录。完整结果见 `art/validation/p2_combat_20261027/validation.json`；用户视觉验收和 Android 实机仍待进行。
