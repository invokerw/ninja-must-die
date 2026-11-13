# 项目内 s2p

本目录保存 `screenshot-to-psd` 拆层引擎、锁定依赖、项目入口和离线回归。新任务使用这里的代码，不再查找其他源码仓库或全局 `extract-layered-psd` skill。

拆层仍需要可用的模型接口；默认在运行时复用本机 Codex 自定义网关已有的 API 凭据，无需重复填写。首次安装需要 npm 软件源；安装后，报告、独立对照和离线检查不需要模型服务。游戏运行和打包不需要 Node.js 或此工具。

## 安装与独立配置

需要 Node.js **20.9+** 和 npm，建议 Node.js 22 或 24。从游戏仓库根目录执行：

```sh
npm ci --prefix tools/art/s2p/engine
node tools/art/s2p/cli.cjs init
```

`init` 创建本目录下的 `config.local.json` 和 `.env.local`，已有文件保持原样。两者均由 Git 忽略。默认无需填密钥；需要覆盖时，可在私有配置中填写 API key，或通过进程环境提供 `LAYERFORGE_CONTROLLER_API_KEY`、`LAYERFORGE_BACKGROUND_API_KEY`。

控制器默认从 Codex 配置读取模型、服务商地址、`wire_api` 和推理等级。默认图像路线共用该网关和 API 凭据，图像模型名称、质量与超时继续使用本项目配置。支持 Responses 与 Chat Completions 两种控制器协议，图像编辑仍走独立的 `images/edits`。

配置来源是 `CODEX_HOME/config.toml`（没有 `CODEX_HOME` 时为 `~/.codex/config.toml`）。支持文件中的默认 profile、`[profiles.<name>]`，以及同目录 `<name>.config.toml`。读取结果代表**配置文件中的默认值**，不代表当前聊天临时选中的模型，也不自动合并 Codex 的项目配置与完整信任规则。

API 凭据按以下顺序解析：项目路线 / 兼容环境变量中明确提供的密钥 → 所选 Codex 网关的 `env_key` → 该自定义网关配置中的 `experimental_bearer_token`。最后两项只在运行时读取，不复制到项目文件，也不把原始凭据添加到任务快照、报告或日志；`auth.json` 登录会话不参与复用。

自动复用绑定网关的协议、主机、端口及 API 基础路径。目标地址不同或原服务商地址已改变时，诊断返回明确的拒绝原因，阻止自动复用；独立提供的项目密钥仍可用于操作者明确指定的接口。续跑保留原服务商身份，凭据轮换即时读取，不跟随新选中的服务商。缺失凭据文件且没有环境 / 项目密钥时需恢复凭据来源，工具不保存密钥副本。

已有私有配置不会被 `init` 覆盖。要启用 Codex 默认配置，将私有 JSON 的控制器改为：

```json
{"llm":{"routes":{"controller":{"source":"codex","timeout_ms":1800000,"max_retries":0}}}}
```

`controller` 下明确填写的 `model`、`base_url`、`wire_api`、`reasoning_effort` 可覆盖 Codex 默认值，兼容环境变量继续有效。命令行也可临时覆盖：

```sh
node tools/art/s2p/cli.cjs doctor --codex-profile fast
node tools/art/s2p/cli.cjs doctor --codex-config /absolute/path/config.toml
node tools/art/s2p/cli.cjs doctor --controller-model MODEL --controller-protocol responses
```

需要完全独立于 Codex 时，将控制器 `source` 与 `credential_source` 均设为 `project`，并填写 `model`、`base_url`、`wire_api` 与 API key 环境变量表达式。图像路线也将 `gateway_source` / `credential_source` 设为 `project` 并填写自己的网关和密钥。

图像模型名称始终从项目 JSON / 环境读取，不随 Codex 聊天模型切换。默认图像路线的 `gateway_source: "codex"` 只跟随网关；`credential_source: "codex"` 允许绑定后的凭据复用。独立网关应将这两个字段设为 `project`。原有自定义私有配置保持不变，本机之前由初始化器生成且未自定义的配置已迁移到共享网关默认值。

## 配置诊断与接口探测

```sh
node tools/art/s2p/cli.cjs doctor
node tools/art/s2p/cli.cjs models --role controller
node tools/art/s2p/cli.cjs doctor --online
node tools/art/s2p/cli.cjs doctor --image-probe
```

- `doctor` 默认不联网，列出解析后的模型、地址、协议、配置文件 / profile、密钥是否存在和未验证能力。缺少配置或密钥时返回非零退出码；不会把本地检查写成接口可用。
- `models` 显式联网查询指定路线的模型名称，可选 `controller` / `background`；它不发起模型推理，也不依据名称推断视觉或图像编辑能力。返回 `has_more` 时只表示当前响应页，工具不自动选择其他模型。
- `doctor --online` 发起一次控制器看图 / JSON 探测，使用工具生成的小红图，不发送游戏素材。
- `doctor --image-probe` 发起一次真实图像编辑请求，检查多图输入是否被接受，以及内联 PNG 是否同时有透明和可见像素；不会将返回图接入游戏。两种探测可同时指定。请求会消耗对应接口额度，单次通过不证明完整拆层视觉质量或长期稳定性。

服务端失败只输出状态码和分类原因，避免错误响应回显密钥。生产请求的超时和重试仍取原路线设置，诊断不自动切换模型 / 服务商。

控制器需支持带图和 JSON 输出；图像路由需支持多参考图、透明 PNG 和配置的质量参数。当前递归拆层的全部图像请求使用 `background` 路由，包括文字图集、视觉图集和背景补全。

```sh
node tools/art/s2p/cli.cjs check
node tools/art/s2p/cli.cjs preflight
```

`check` 校验来源哈希、项目入口、模型桥接、导出边界和 12 套引擎回归。使用夹具密钥、模拟模型和本地回环 HTTP 服务，不需要真实配置，不调用真实模型。`preflight` 检查实际依赖、配置和是否存在密钥，不发出模型请求，也不能证明网关可用。

## 拆层、续跑与报告

概念图先由用户审核；资源保持候选，流程见 [美术流水线](../../../docs/ART_PIPELINE.md)。路径相对于发起命令时的目录，包含空格时加引号。

```sh
node tools/art/s2p/cli.cjs run \
  --source art/concepts/ui_touch_combat_design_v02.png \
  --output art/workbench/s2p_example_01 \
  --visual-window 3 --local-detection-inputs --combined-detection \
  --serve --port 8925
```

`run` 会发送图片并产生模型调用。省略 `--output` 时，自动在 `art/workbench/` 中使用时间戳与随机后缀创建独立目录。显式指定的输出目录必须为空。

同一任务中断后，使用原命令、原输出目录追加 `--resume`。Codex 控制器的公开配置保存在任务 manifest 中，并传给工作子进程；续跑读取原快照，即使 Codex 默认模型后来改变，也不会悄悄切换模型。凭据仍从绑定的原服务商配置或显式密钥来源读取，可轮换；若移走该配置且没有其他密钥来源，续跑会因缺少凭据而拒绝。显式改变项目配置、控制器覆盖、源图、引擎文件或运行参数时，身份检查仍会拒绝；不得修改 manifest 绕过检查。旧任务的代码身份若与本快照不同，应保留旧结果并开启新任务。

查看已有结果不调用模型，也不需要密钥：

```sh
node tools/art/s2p/cli.cjs report --output art/workbench/s2p_example_01 --serve --port 8925
node tools/art/s2p/cli.cjs compare --output art/workbench/s2p_example_01
```

浏览器统一入口为 `report` 返回的 `result.html` 地址，包含原图 / 合成叠加、原始模型 / 放置图层、递归过程、耗时和 PSD 下载。`compare` 重建独立对照证据，随后可再用 `report` 刷新报告。进程恢复、失败与参数的具体约束可查看 `node tools/art/s2p/engine/node/psd.js --help`。

保留 `run_result.json`、`verification.json`、`fidelity_verification.json`、原始模型和人工检查记录。PSD 读回与 RGBA 一致不等于与源图一致，更不等于用户视觉验收通过。模型图层只允许裁切、定位和下采样；未验收资源保持 `runtime_ready: false`。动态文字、进度、生命、冷却和按钮状态仍由 Godot 绘制。

## 目录与维护

- `cli.cjs`：项目入口，固定使用相邻 `engine/`，支持带空格的路径及移动后的项目。
- `engine/`：纳入的引擎依赖闭包、离线测试及已有结果的局部修复 / 回放辅助脚本；辅助脚本不作为新的自动修复步骤。
- `vendor-manifest.json`：源提交、实际导入的本地修改、项目内补丁和逐文件 SHA-256。原仓库当时存在未提交改动，因此提交号不能单独代表本快照。项目补丁修正报告根目录的符号链接比较，补齐重试 / 协调模块的续跑身份，并让检测夹具按消息角色读取图片，详情见清单的 `local_patches`。
- `config.example.json`、`.env.example`：模型来源及独立图像路线模板，不包含密钥。
- `engine/node/codex_config.js`、`controller_client.js`、`model_doctor.js`：Codex 公开配置读取、协议适配和诊断。
- `tests/`：项目入口、快照完整性与引擎回归的串行运行器。

引擎的原 `package.json` 声明许可证为 ISC，导入源未包含独立 LICENSE 文件；此处保留原包元数据。更新时明确选择新版源码，重新审查依赖闭包并更新来源清单，再跑 `check`。不要链接外部 `node_modules`，也不要以整个外部仓库覆盖本目录。

`.gdignore` 阻止 Godot 导入本工具和 npm 依赖。Windows 与 Android 的现有 `tools/*` 导出排除规则同时覆盖本目录；工具回归对此做检查。`engine/node_modules/`、引擎离线测试产生的 `engine/tmp/` 和私有配置不提交。

## 验证记录 · 2026-11-13

- Node.js 22.15.0 下，`npm ci --prefix tools/art/s2p/engine --no-audit --no-fund` 成功安装项目自身的锁定依赖。
- `node tools/art/s2p/cli.cjs check` 退出 0，出现 `S2P_CHECK_PASS`：来源快照、3 项项目入口检查和 12 套引擎检查通过。模拟端到端流程实际导出 / 读回 PSD，验证续跑、原始透明洞、合成一致性、回环报告页及下载；日志为本机 `/tmp/ninja-s2p-check.log`。
- `python3 -m unittest discover -s tests -p test_ci_export.py`：5 项通过。两个导出预设仍排除 `tools/*`，工具目录有 `.gdignore`。
- 已执行 `init`，生成被忽略的独立配置和空密钥文件。未配置密钥时，实际 `preflight` 按预期拒绝，未调用模型。真实网关连通性、耗时和新拆层视觉质量尚未验证。
- 本次未执行远端 CI、游戏完整回归或 Android 实机检查；未改变运行时玩法 / 素材，也未改变既有资源验收状态。

模型接口优化已执行 `node tools/art/s2p/cli.cjs check`，退出 0、`S2P_CHECK_PASS`：4 项项目入口检查、4 项模型桥接回归及原有 12 套引擎检查通过，日志为本机 `/tmp/ninja-s2p-model-check.log`。新增回归通过真实 SDK 向回环服务验证 Responses / Chat Completions、多图和 JSON 格式、模型列表、透明 PNG 探测及错误脱敏；模拟端到端任务验证 Codex 默认值改变 / 配置文件删除后的快照续跑和显式覆盖拒绝。

公开配置读取切片初验时，默认 `doctor` 的模型调用数为 0：正确读取 Codex 默认模型和 Responses 协议；当时尚未接入网关内联凭据复用，返回 `needs_configuration`，能力保持 `not_tested`。后续运行时凭据复用与真实接口结果见下段。

凭据复用切片已完成：默认控制器和图像路线在运行时复用所选 Codex 自定义网关的 API 凭据，未重复填写或复制密钥。实际默认 `doctor` 返回 `ready`、`model_calls: 0`；真实模型列表查询通过，控制器与独立图像模型均在返回列表中。显式执行 `doctor --online --image-probe` 返回 `ready`、`model_calls: 2`：控制器小图 / JSON 探测通过，图像编辑多图输入及带真实透明 / 可见像素的内联 PNG 检查通过。只使用工具生成的小测试图，未发送游戏素材，未保存返回图作为候选资源；这不是完整真实拆层或视觉验收。

本轮 `check` 退出 0、`S2P_CHECK_PASS`：10 项入口 / 模型 / 凭据回归和原有 12 套引擎检查通过；5 项 Python 导出检查及 `git diff --check` 通过。凭据回归覆盖环境优先级、内联 API key、网关协议 / 主机 / 端口 / 路径绑定、禁用复用、轮换和任务证据无密钥。本机扫描 71 个项目 / 私有配置 / 诊断文件，未发现当前网关密钥被复制。离线日志为 `/tmp/ninja-s2p-credential-check.log`，实际在线探测为 `/tmp/ninja-s2p-reuse-online.json`。未执行完整真实拆层、远端 CI、游戏完整回归或 Android 实机检查。
