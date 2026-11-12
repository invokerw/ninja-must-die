# 角色选择 v02 · 分层候选与来源

2026-11-12；用户概念审核和本版准备页用户视觉已通过，`runtime_ready: true`；Android 实机仍待验收。该审核不代表后续角色局内动画或忍术特效完成。

- [素材清单](manifest.json)：三张角色头像、岚织预览立绘、影刃独立生成预览图；包含尺寸、透明通道、哈希和运行时路径。
- [原始 PSD](source/layers.psd)：1664×928、98 层；[结构验证](source/verification.json)、[保真边界](source/fidelity_verification.json)、[运行摘要](source/run_result.json)。
- [助手视觉检查](inspection/visual_review.json)。每个 `inspection/*_comparison.png` 按左原图裁块、中实际模型裁块、右放置图层排列；原图和实际模型分辨率不同，展示时仅缩小，不放大。正式运行图另见[任务卡](../../../../validation/ui/character_setup/v02/README.md)。
- `source/*_atlas.png` 保存实际原始模型返回；`source/shadow_runner_native.png` 是内置图片工具的原始透明输出。均不修 RGB / alpha，不掩盖模型重绘差异。
- 第一次原图尺寸被服务拒绝，随后使用[派生输入](source/extraction_input.png)和[裁切记录](source/extraction_input.json)重跑；原始概念保持不变。

选入运行时的抠图放在 `textures/`，以逐字节复制进入 `art/generated/ui/character_setup/v02/`。影刃独立图只做 724 宽下采样。没有将模型文字、控件底板或整张概念图导入正式 UI。

重建无需模型调用，要求本机 Node 20+、`sharp` 与被忽略的原始分层工作目录仍在。若 `sharp` 不在 Node 搜索路径，可指定 `SHARP_MODULE` 为已安装模块的绝对目录：

```sh
node tools/art/export_character_preparation.cjs
```

完整模型 / 时间线工作目录为 `art/workbench/ui/character_setup/v02/extraction_aligned/`。此候选目录已加 `.gdignore`，且 Windows / Android 都排除 `art/layered/*`；正式路径只引用 `art/generated/`。
