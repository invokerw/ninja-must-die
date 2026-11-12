# 影刃准备页立绘 · 资源生成记录

- 日期：2026-11-12；工作流：内置 `image_gen.imagegen`，透明输出；模型未由工具报告。
- 参考：`art/concepts/ui/common/v01/03_preparation.png` 与已通过审核的 `art/concepts/ui/character_setup/v02.png`。
- 原始结果：`call_GWchHwC7BC8lL4LuTfoiEKRd.png`，原始文件保存在 `art/layered/ui/character_setup/v02/source/shadow_runner_native.png`。
- 原始图存在局部半透明蓝色细屑；内置编辑工具的一次边缘修整请求返回 `400 Transparent background is not supported for this model`，未产生新图，未改模型或调用 CLI。实际 224 高的墨色底预览未见明显异色块；保留原始 alpha，不进行阈值擦边或锐化，最终用户视觉待验收。

## 原始生成提示词

```text
Use case: illustration-story. Asset type: approved game UI preparation character portrait production candidate, isolated transparent PNG. Generate ONLY the dark blue masked male ninja 影刃 / Shadow Runner from the central hero in reference image 1. Image 2 is ONLY for consistent game brushwork, moonlight and palette, do NOT use its female character. Preserve reference 1's young Chinese male identity, tied black hair, black cloth lower-face mask, dark ink-blue practical ninja clothing, pale gray shoulder scarf and small aged brass details. Three-quarter pose, head to knees, turned slightly right, alert but composed, arms relaxed, no weapons, no physical scene. Maintain the reference's hand-painted Eastern fantasy style, strong readable silhouette, cool moonlit shoulder edges, minimal fine detail, no red clothing, no armor redesign. Character must be fully isolated on TRUE transparent alpha, no background, NO moon, no mountains, no panel, no circular portrait frame, no text, no labels, no decorative glow haze. One character only, entire head and scarf intact, generous transparent padding around the hair and shoulders, do not crop the top of head or hands. Use a landscape canvas approximately 4:3 with the character centered, preserving a tall figure within generous side transparency. This is the same previously approved character, not a new character design.
```
