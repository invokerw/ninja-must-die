# 关卡选择页 v01 / run06 候选 PSD

2026-11-04 从断点恢复完成，5 个视觉提取轮次，67 层（66 个视觉对象和背景），1672×941。源图无动态文字，本次文字层为 0。

- `layers.psd`：可编辑候选文件。
- `layers/` 和 `manifest.json`：按实际 PSD 顺序保存的独立图层、坐标、来源及摘要。
- `recomposed.png`：PSD 合成预览。
- `verification.json`：PSD 图层 RGBA、合成图及透明洞链回读验证通过。
- `fidelity_verification.json`：原像素恢复不适用，不建立像素一致性。
- `visual_review.json`：助手检查记录；大插图的月亮和山景、部分图标及面板存在模型重绘差异，仍需用户视觉审核。

用户已于 2026-11-04 审核通过分层资源；41 张选用贴图已复制到运行时目录并完成 Godot 拼装。`runtime_ready: false` 指运行时画面仍待用户视觉审核，Android 未验收。历史候选保留在上级目录，未覆盖。

完整原始返回、请求与时序见 `art/workbench/ui_level_select_v01_20261102_run06/result.html`。累计耗时跨越失败、等待和恢复，不作为单次生成性能数据。
