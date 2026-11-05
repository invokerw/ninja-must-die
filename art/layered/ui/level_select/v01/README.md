# 关卡选择页 v01 分层候选资源

- 状态：`needs_review`
- 最新尝试：`art/workbench/ui_level_select_v01_20261102_run06/`
- runtime_ready：`false`
- 原图：`art/concepts/ui/level_select/v01.png`
- 拆层工作台：`art/workbench/ui_level_select_v01_20261031_run03/`（历史部分提取）；最新尝试 `art/workbench/ui_level_select_v01_20261102_run06/`
- 图层数量：67

2026-11-04：`run06` 已恢复完成，5 个视觉轮次，导出 67 层 PSD（66 个视觉对象及背景），回读结构校验通过。新增完整候选保存在 [`run06/`](run06/README.md)，历史部分提取未覆盖。助手已检查最终合成与原图：右侧大插图的月亮及山景、部分图标和面板存在模型重绘差异，用户视觉审核和 Android 验收仍待进行，`runtime_ready` 保持 `false`。

上级 `layers/` 中的历史候选来自此前拆层流程第 1 至第 7 轮的成功图层返回，包含路线节点、面板、关卡卡片、锁定图标、操作按钮、指标图标和详情插图。用户已于 2026-11-02 审核通过概念图并授权分层。控制器 JSON 响应请求兼容问题已修复；此前 geometry grounding 超时和 502/503 的记录保留在工作台中。

候选图层仅用于人工检查和后续 Godot 静态拼装，不得直接复制到 `art/generated/` 或宣称运行时完成。需要重点检查透明边缘、模型重绘差异、嵌套面板遮挡、缩放和 1280×720 安全区。

2026-11-04 后续：用户已审核通过 `run06` 分层资源，41 张选用贴图已复制至 `art/generated/ui/level_select/v01/` 并拼装正式场景。资源审核与运行时视觉审核分开记录；后者仍待验收，详见 UI 任务卡。
