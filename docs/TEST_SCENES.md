# 测试场景规范

自 2026-10-30 起执行。默认复用正式场景并注入配置；新增功能不要求新增 `.tscn`。

## 入口和用途

| 类型 | 位置 / 入口 | 保留规则 |
| --- | --- | --- |
| 正式玩法 | `scenes/main.tscn`、`scenes/practice.tscn`、`scenes/boss_practice.tscn`、`scenes/ui/` | 由产品功能决定；练习模式属于正式玩法 |
| 自动回归 | `tests/test_*.gd`、`tests/support/` | 实例化真实场景并注入资源 / `RunLoadout`；角色或武器变化使用参数循环 |
| 手工灰盒 | `tools/run_sandbox.gd` | 共用启动器选择角色和模式，复用正式场景；不为每组参数建立场景文件 |
| 独立美术 / 交互预览 | `scenes/art/`、`scripts/art/`、`tools/art/` | 仅在需要不同节点结构、渲染环境或长期独立验证台时保留，记录用途及验收状态 |
| 临时测试台 | `tests/fixtures/`，仅在确实需要独立节点结构时新增 | 命名说明测试对象；随对应功能验收决定删除或转为长期夹具 |

`tests/*`、`tools/*`、`scenes/art/*`、`scripts/art/*` 已从 Windows / Android 导出排除。新增其他调试目录时，必须同步检查两个导出配置；正式场景不得引用仅供测试的资源。

## 共用手工入口

在项目根目录运行（Windows 用本机 Godot 可执行文件替换命令路径）：

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . --script res://tools/run_sandbox.gd -- --character=wind_scout --mode=parkour --touch
```

- `--character=`：`shadow_runner`（默认）、`wind_scout`、`thunder_guard`。
- `--mode=`：`parkour`（默认）、`boss`、`full`。
- `--touch`：启动时显示触屏按钮；F3 可切换。
- `--help`：显示参数；未知参数、角色或模式以非零状态退出。

启动器使用进程独立的临时档案，重试和返回准备页期间继续隔离正式存档。正常退出删除临时档案及备份；强制终止可能留下 `.godot/test-isolated-manual-*.json*`，可在相关进程退出后删除。重试保留本局角色、武器和模式，身法运行计时重新开始。自动回归使用 `TestProfileScope` 隔离档案。

## 新建与验收清理

新建独立测试场景前，先检查能否通过配置共用入口完成。确需保留时，在相关功能文档或验收报告记录：文件路径、用途、启动方式、依赖测试、当前验收状态，以及删除条件或长期保留理由。

用户明确验收通过后，开发者在该切片收尾时执行：

1. 将仍有价值的行为校验纳入共用自动回归；仍需人工复测的配置迁入共用启动器。
2. 删除已失去独立用途的场景、配套脚本及引用；同步文档和导出配置，不另存一份废弃场景归档。
3. 检查引用与资源加载，验证正式入口、受影响模式的启动 / 暂停 / 重试，并运行相关回归。
4. 在验收记录保留必要截图、结论和长期保留场景的理由。

自动回归通过只代表代码检查完成；待人工试玩、美术或 Android 实机验收的入口继续保留用途记录。清理不影响正式练习功能。

## 当前整理记录

- 阶段 A 两个按角色复制的灰盒包装场景已由共用启动器替代并删除，角色 × 模式及重试验证保留在 `tests/test_mobility.gd`。
- `scenes/art/ui_touch_preview.tscn` 与 `ui_touch_boss_preview.tscn` 保留：仍由美术捕获工具和 `tests/test_ui_art_preview.gd` 使用，视觉 / Android 验收待完成。入口与状态见 [美术流水线](ART_PIPELINE.md)。
- 阶段 A 真人手感和 Android 验收仍待进行；此次整理表示消除重复入口，不表示功能已获人工验收。
