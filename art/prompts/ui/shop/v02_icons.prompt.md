# 山路行商商品图标 v02

- 日期：2026-11-06；在用户明确通过概念 v02 后生成。
- 工作流：内置 `image_gen`，`transparent_background: true`；未调用 CLI / 私有模型，未抠改像素。
- 原始结果：1536×1024 RGBA，六个 512×512 网格；原图保存在 `art/layered/ui/shop/v02/item_icons.png`。
- 运行时：同字节复制至 `art/generated/ui/shop/v02/item_icons.png`，通过 `AtlasTexture` 取网格；文字、数值、状态均由 Godot 绘制。
- 检查：见 `art/layered/ui/shop/v02/manifest.json`；助手已检查实际背景上的透明边缘、缩小到约 100 px 的辨识度及图集边界。

## 提示词

Create a production game UI icon ATLAS on a true TRANSPARENT background, 1536x1024 landscape. Six standalone hand-painted Chinese fantasy item icons, arranged in an exact 3 column by 2 row evenly spaced grid. Each cell 512x512, center the icon in its cell, leave at least 100 pixels fully transparent padding on all sides of each icon; absolutely no contact or overlap between cells. No text, numbers, background, tiles, frames, circles, or drop-shadow rectangle.
Top row left: one elegant curved steel dao training blade, short dark wrapped hilt, cream moonlit blade with restrained brass fittings; blade facing upper right.
Top row center: one compact traditional lamellar cuirass / body armor chest piece, dark blue-gray and muted brass, recognizable silhouette.
Top row right: one pale parchment rolled-open scroll with wooden rods and a tiny restrained warm gold crystal-like symbol, representing light gathering.
Bottom row left: one pale parchment rolled-open scroll with wooden rods and a muted jade protective shield symbol, representing extended protection.
Bottom row center: one protective paper talisman charm, parchment yellow small hanging red-brown thread and a restrained dark ink seal, no readable writing.
Bottom row right: one small celadon ceramic medicine bottle with a wooden stopper, one short cord, subtle jade glaze.
All six must share the same hand-painted ink-wash brush texture, 3/4 view, moonlit cream edges and low-saturation blue-gray / muted bronze palette. Crisp separable alpha edges, simple readable silhouettes at 64px, no intense glows, no cast shadow. Premium Chinese fantasy game UI style. The icons will be sampled separately by Godot AtlasTexture, so strict grid placement and transparent cell margins are essential.
