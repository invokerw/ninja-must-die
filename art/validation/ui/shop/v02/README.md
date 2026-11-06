# 山路行商独立界面 UI 任务卡

- 界面 ID / 版本：`shop` / `v02`
- 日期：2026-11-06
- 当前状态：`visual_review_pending`；`runtime_ready: false`
- 负责人：Codex；审核人：用户

## 功能与入口

- F5 准备页 → **山路行商**，正式场景 `res://scenes/ui/shop.tscn`，脚本 `scripts/ui/shop_screen.gd`。
- 返回按钮 / Esc 返回准备；确认弹层中 Esc 先取消，Tab / 方向键在弹层内循环；返回保留角色 / 已装备武器。
- 共修显示真实下一档价格、当前 / 升级后效果、上限及前置；秘卷购入后免费装备 / 卸下；补给显示库存，明确携带 / 取消，选择不扣库存；外观为空状态。
- 付费前确认花费及剩余余额，提交时重查价格、余额、档位、库存；重复或过期确认不扣钱。
- 保存失败保留同一交易草稿，显示待保存和重试，阻止新交易 / 配置；未来版本档案只读。
- 自动回归复用正式场景与 `TestProfileScope`，未新增测试场景或保留临时入口。

## 当前 UI 基线

- `art/validation/ui/shop/v01/baseline_1280.png`：2026-11-06，1280×720，桌面模式、隔离档案，来自改动前 HEAD 的实际准备页 + 商店覆盖层。
- 原问题：覆盖准备页、底部选项越界、商品未分类、档位价格固定、缺确认 / 明确状态；原百分号格式错误如实保留在基线，随旧覆盖层移除。
- 交互原型历史证据：本目录 `shop_1280_growth.png`，仅用于说明独立功能切片，正式画面以 `runtime/` 为准。

## 设计约束

- 1280×720 设计坐标，通过 `ScreenLayout` 适配宽屏 / 触屏安全区；主要触摸目标高度至少 48 设计 px。
- 状态：首次、分类 / 商品选中、锁定、余额不足、满级、已拥有 / 装备、库存满、空外观页、确认 / 取消、保存失败、未来档案只读、返回失败和重复点击；局外无暂停 / 加载状态。
- 余额、价格、当前 / 升级后值、上限、库存、锁定、装备 / 携带、交易消息及确认后余额均由 Godot 绘制。
- 月下雾岭蓝灰水墨、墨色半透明面板、暖金选中和主按钮；复用已有背景，不添加商品或改变玩法规则。

## 概念审核

- [概念 v02](../../../../concepts/ui/shop/v02.png)；[概念提示词](../../../../prompts/ui/shop/v02.prompt.md)。
- 输入参考：真实基线截图 + `art/style_guide/style_anchor.png`。
- 用户于 2026-11-06 明确回复：**“通过，按 v02 制作”**，状态 `approved`。
- v01 为未经过实际截图约束的探索稿，保留并标记修订，不作制作依据。
- 概念通过前仅完成代码交互原型；通过后才生成图标、整理资源及完成正式拼装。

## 资源与拼装

- 透明原图 / 网格 / 哈希 / alpha 检查：[资源清单](../../../../layered/ui/shop/v02/manifest.json)。
- [图标提示词](../../../../prompts/ui/shop/v02_icons.prompt.md)；内置 `image_gen` 生成原生透明图集，无 CLI 回退。
- `art/layered/ui/shop/v02/item_icons.png` → 同字节复制至 `art/generated/ui/shop/v02/item_icons.png`。
- 六个 512×512 单元，`AtlasTexture` 设置 `filter_clip`；RGBA、有效主体不触边，单元边缘最高 alpha 为 1/255。源图未修像素，通过实际背景缩小检查。
- 图标直接由模型生成 alpha，再由原生图集区域拆分；原始图、网格清单、透明检查及实际截图可复核，无需 PSD。
- 面板、按钮、文字及状态为 Godot 原生控件，背景复用 `PaintedBackdrop`。无概念整图或占位图运行时依赖。
- 两个导出预设均排除概念 / 提示词 / 分层来源 / 验证 / 测试 / 工具；正式界面仅依赖脚本、正式场景和 generated 贴图。

## 自动回归与截图

2026-11-06 本地结果：

- 18 套完整回归全部退出 0，包含 `economy`、`touch_controls`、`ui_art_preview`、`level_select` 等；跨进程档案写入后读取通过；Python 导出检查 5 项通过。摘要见 [regressions.json](regressions.json)。远端 CI 未运行。
- `economy` 扩展真实触摸进入 / 切分类 / 购买 / 装备 / 携带，取消、重复和过期确认，失败交易重试、只读和返回装备保留；最后另补键盘焦点 / 取消、余额变动重新确认与图标最小尺寸边界，均通过。
- 最终图形回归退出 0、输出 `ECONOMY_PASS`，无错误；OpenGL Compatibility / Apple M1 Pro。
- 助手检查 `runtime/` 内首次锁定、成长、秘卷、补给、确认和保存失败；1280×720、1600×720，以及 `Rect2(60, 24, 1480, 648)` 模拟安全区。图标无放大越界、无明显杂边 / 邻格，动态文字未见裁切，所有可见按钮在安全区内。截图使用隔离测试余额。
- 检查并修复了纹理最小尺寸导致的图标越界、宽屏遮罩接缝和保存按钮遮挡；对应行为 / 边界已纳入回归。

```sh
godot_bin=/Applications/Godot_mono.app/Contents/MacOS/Godot
"$godot_bin" --headless --path . --fixed-fps 60 --log-file /tmp/ninja-economy.log --script res://tests/test_economy.gd
# 图形截图：省略 --headless，并追加
# -- --capture-dir=/绝对路径/商店截图目录
```

截图：

- [成长](runtime/shop_1280_growth.png)、[首次锁定](runtime/shop_1280_initial.png)、[秘卷](runtime/shop_1280_scrolls.png)
- [宽屏补给](runtime/shop_1600_supplies.png)、[模拟安全区](runtime/shop_1600_safe.png)
- [购买确认](runtime/shop_1280_confirm.png)、[保存失败](runtime/shop_1280_save_failure.png)

## 验收边界与清理

- 概念方向：用户通过；自动回归：通过；助手截图检查：通过。
- **最终运行时用户视觉审核：待审核。Android 实机触摸 / 安全区 / 性能：待验收。**
- 玩法其余缺口见 `docs/ECONOMY.md`，本切片不宣称阶段 E 整体验收完成。
- 本次基线截图临时脚本已删除；保留正式商店场景与公共经济回归。无新调试场景、正式存档写入或临时档案遗留。
