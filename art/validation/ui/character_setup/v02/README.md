# 角色选择与行前准备 UI 任务卡 v02

- 界面 ID / 版本：`character_setup` / `v02`；日期：2026-11-12。
- 概念审核：`approved`，用户反馈“可以实现”；当前状态：`runtime_ready`，`runtime_ready: true`。
- 负责人：Codex；审核人：用户。用户运行时视觉 / 手感已验收通过；Android 实机仍待单独验收。
- 正式入口：F5 → `res://scenes/ui/character_setup.tscn`；复用正式场景，没有新增测试场景。

## 当前功能

左侧角色列表可用触摸、鼠标或键盘选择。点击只预览，中间“设为出战”才提交角色并请求保存；未确认的角色不影响底部出战摘要、关卡选择、练习或商店返回。右侧武器操作针对预览角色，且每名角色保留自己的武器槽；秘卷、成长和补给仍是档案共享配置。

岚织由第一关正式首通的奖励事务解锁；旧档首通权益迁移也可恢复所有权。烬锋沿用 1-3 解锁条件，该关尚未开放，因此只能查看锁定信息。岚织 / 烬锋身法已经可用，K 仍暂用月蚀斩，局内动作仍使用共用角色与占位着色；本切片不引入专属忍术、教学或新关卡。

`PlayerProfile` 使用统一注册表检查角色所有权、配置合法性、较新档案只读、未保存交易及局内状态。局内和暂停禁止换角 / 装备；失败保存保留内存选择并可重试，不覆盖奖励事务。重试仍读取固定的本局快照。F6 直接运行正式游戏场景也读取档案当前角色，灰盒显式注入仍可用。读取未知或未拥有的角色时回退影刃，未知扩展字段保留。

## 基线、概念与审核

- 改动前真实基线：[1280×720](baseline/preparation_initial.png)、[1600×720 模拟安全区](baseline/preparation_safe.png)；2026-11-12、隔离档案、原生菜单可触摸，无局内触屏动作键。
- 改动前 [组件图形回归](logs/baseline.log) 退出 0、`UI_COMPONENTS_PASS`。当时正式页只展示不可选的影刃，三人资源已在注册表，尚未接入正式选择。
- 构图延续已审核的[通用 03 板](../../../../concepts/ui/common/v01/03_preparation.png)，本轮先以实际基线生成[概念 v02](../../../../concepts/ui/character_setup/v02.png)，再取得用户明确“可以实现”后进入资源与拼装。
- [概念来源 / 校验 / 审核记录](../../../../concepts/ui/character_setup/v02.manifest.json)、[完整概念提示词](../../../../prompts/ui/character_setup/v02.prompt.md)、[影刃资源生成提示词](../../../../prompts/ui/character_setup/shadow_runner_portrait_v01.prompt.md)。概念原图未缩放、裁切或重绘。

## 组件、布局与状态

复用 `UITokens / PaintedTheme / UISelectCard / UITabBar / UIDetailPanel / UIActionButton / UIStatusChip / FeedbackSettingsPanel`。角色卡是既有卡片的组合应用，没有新增色板或基础控件；立绘 / 头像由 `CharacterData` 的纹理字段驱动，战斗 HUD 读取本局角色头像。

- 1280×720 三列布局：左侧列表、中间立绘与能力、右侧装备与纪录。底部摘要与五个动作分两行，保持固定可达。
- 模拟 1600×720 与 `Rect2(60,24,1480,648)`；按钮不小于 48×48，长能力 / 武器 / 纪录文本使用原生滚动，动态文字均由 Godot 绘制。
- 选中边框表示正在预览；勾表示已出战，锁表示未解锁。锁定卡仍可查看具体条件；已拥有、选中与已出战独立。
- 保存失败有持久提示和明确重试；未保存交易阻止继续配置；只读可查看、不可改写。设置遮罩阻断后台输入，并恢复来源焦点。确认出战后焦点回到角色卡，避免停在禁用按钮上。
- 卡片、立绘和底部动作均使用设计坐标 / `ScreenLayout`，没有改移动、碰撞、评分、奖励数值或身法参数。

## 资源与分层证据

[分层候选与原始 PSD](../../../../layered/ui/character_setup/v02/README.md)；[运行时资源说明](../../../../generated/ui/character_setup/v02/README.md)。原生文字、面板、按钮和状态不用模型图层。

分层首次因原图 1672×941 不是 16 倍数被模型服务拒绝，保留[失败记录](logs/extraction_initial_failure.json)。随后从副本裁去左 4 / 上 6 的边缘，使用 1664×928 处理输入；原始概念不变。完成 98 层 PSD，独立结构检查确认 PSD RGBA、合成图和透明孔链一致；直接模型 RGBA 有细节重绘，不声称原像素还原。原始模型、原图裁块、放置图层与实际菜单分开检查。

选入的三张头像与岚织预览立绘逐字节复制；影刃预览立绘为内置生图的独立透明输出，仅下采样，不修 alpha 或锐化。原图有轻微蓝色边缘细屑，实际菜单尺寸下未见明显异色块，保留候选状态。烬锋只有锁定灰度头像，没有伪造正式立绘或暂时解锁。

## 实际验证

[机器摘要](validation.json)、[19 张运行截图](runtime/README.md)、[最终图形日志](logs/ninja-character-ui-final2.log)。截图为正式场景、隔离档案、OpenGL 实际输出，未编辑像素。

2026-11-12 本地串行完整 19 套 GDScript 回归、跨进程隔离存档写入 / 读取及 5 项 Python 导出测试全部退出 0，日志有对应 PASS、无 `SCRIPT ERROR / ERROR:`。具体套件和日志见机器摘要。新增行为覆盖落在原 `weapons / save / ui_components / profile_persistence`，没有新建角色专用测试场景：

- 真实首通解锁、锁定 / 未知 ID 拒绝、各角色武器记忆及重启恢复；旧档权益和未知扩展字段保留。
- 真实触摸预览、键盘确认、预览不出战、保存失败 / 重试、只读及待保存奖励边界、设置防穿透。
- F6 直接入口、练习导航、返回准备、局内 / 暂停禁止更换、本局快照不变及角色 HUD 头像。

助手检查了 19 张首次进入、武器预览 / 装备、秘卷 / 补给 / 纪录、只读、保存失败、角色预览 / 确认 / 锁定、待保存、设置、宽屏与安全区画面。已修复预览徽章覆盖岚织头部；未见明显动作越界、面板互相覆盖或卡片图像溢出。武器长说明和纪录末项按预期滚动可达。概念图的压缩排版不是照图缩小字体。

最终编辑器导入出现一次 `EditorSettings not instantiated` 的退出设置错误，保留[导入日志](logs/ninja-character-import-final.log)，没有记为“无错误导入通过”；之后的运行时回归和图形检查均无此错误。未执行远端 CI、Windows 本机或 Android 实机验收。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . --fixed-fps 60 \
  --log-file /tmp/ninja-character-preparation.log \
  --script res://tests/test_ui_components.gd -- \
  --capture-preparation-dir=/Users/admin/code/godot/ninja-must-die/art/workbench/ui/character_setup/recapture
```

截图输出目录传绝对路径，其他机器替换仓库位置。去掉截图参数、加 `--headless` 可只运行行为回归。

## 保留与后续

正式场景和公共回归继续保留；无新调试入口，无玩家正式存档读写，无资源移动 / UID 手改。Windows / Android 预设继续排除 `tests/*`、`tools/*`、分层、概念、提示词和验收目录；正式代码只引用 `art/generated/` 纹理。

概念、PSD、原始生成图、必要裁块及最终截图保留；中间图形截图存入被忽略的工作目录。用户视觉 / 手感确认后再决定资源细化，Android 触摸、安全区和性能另验。剧情、专属忍术、烬锋解锁关卡仍按后续切片处理。

导入日志归档仅清理行尾空白与末尾多余空行，既有错误内容原样保留。
