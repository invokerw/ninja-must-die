#!/usr/bin/env python3
"""Add candidate preview evidence to the saved unified PSD report; no model calls."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "art/workbench/ui_touch_combat_v02_20261026_01/result.html"

html = REPORT.read_text()
if 'id="candidate"' not in html:
    html = html.replace(
        "</nav>",
        '  <button role="tab" id="tab-candidate" aria-controls="candidate" aria-selected="false">UI 组件预览</button>\n</nav>',
        1,
    )
    html = html.replace(
        "['overview','process','layers']",
        "['overview','process','layers','candidate']",
    )
    section = '''
<section id="candidate" role="tabpanel" aria-labelledby="tab-candidate" hidden>
  <h2>五个操作按钮 · Godot 候选预览</h2>
  <p>10 张独立透明 PNG 已整理，RGB / alpha 与原拆层文件逐字节一致。按下、禁用、方向提示、冷却环与数值由 Godot 实时绘制。</p>
  <div class="notice"><strong>独立预览已验证 · 待用户视觉验收</strong><p>触摸回归通过；首领回放 36.10 秒、0 受击；已检查 1280×720 / 1600×720 画面及底部安全区文字。默认游戏与正式导出暂未启用候选 UI。</p></div>
  <article><h3>状态对比（原尺寸）</h3><p class="muted">依次为上侧、下侧禁用跳跃、空中按下快速下落、宽屏冷却。</p><a href="inspection/ui_candidate_control_states.png"><img src="inspection/ui_candidate_control_states.png" alt="五个候选按钮的可用、禁用、按下和冷却状态"></a></article>
  <article><h3>真实玩法场景中的布局</h3><a href="inspection/ui_candidate_1280_top.png"><img src="inspection/ui_candidate_screen_preview.png" alt="1280×720 Godot 候选 UI 实际渲染预览" loading="lazy"></a>
  <p class="native"><a href="inspection/ui_candidate_1280_top.png">1280 上侧</a><a href="inspection/ui_candidate_1280_bottom.png">1280 下侧</a><a href="inspection/ui_candidate_1280_air.png">1280 空中按下</a><a href="inspection/ui_candidate_1600_cooldown.png">1600 宽屏冷却</a></p></article>
  <article><h3>本机操作</h3><p>Godot 中打开 <code>scenes/art/ui_touch_preview.tscn</code>，按 F6。预览内可切换跑酷 / 首领；左侧跳跃与翻绳，右侧影步 / 武器 / 忍术，鼠标和多指均沿用现有输入逻辑。</p><p>组件包：<code>art/layered/ui_touch_v02_candidate/</code>，包含 10 张 PNG、完整 PSD、来源清单和验证结果。</p><p>进度线和四个节点由单个 Godot 控件绘制，避免原 PSD 的重复节点。原始 PSD 保留原样；按钮材质重绘差异尚在，钢索、角色、场景及其余 HUD 继续单独制作。贯星矛暂用已有矢量图标。</p><p><a href="inspection/ui_candidate_validation.json">候选验证记录</a> · <a href="inspection/ui_candidate_touch_test.log">触摸回归日志</a> · <a href="inspection/ui_candidate_render.log">图形渲染日志</a></p></article>
</section>
'''
    html = html.replace("<script>", section + "<script>", 1)
revision = "status_badges_20261027"
revision_dir = REPORT.parent / "inspection" / revision
if (revision_dir / "status_badges_comparison.png").exists():
    article = f'''<article id="status-badge-review"><h3>2026-10-27 · 状态文字优化</h3><p>“禁用 / 首领战”由约 12 像素增至 17 像素，使用居中的深蓝金边状态条；冷却数字也按完整按钮居中。上方为修改前，下方为修改后，均为原尺寸。</p><a href="inspection/{revision}/status_badges_comparison.png"><img src="inspection/{revision}/status_badges_comparison.png" alt="状态文字优化前后对比：文字放大并在圆形按钮中居中"></a></article>\n  '''
    if 'id="status-badge-review"' not in html:
        html = html.replace('<article><h3>状态对比（原尺寸）</h3>', article + '<article><h3>状态对比（原尺寸）</h3>', 1)
    for name in [
        "ui_candidate_control_states.png", "ui_candidate_screen_preview.png",
        "ui_candidate_1280_top.png", "ui_candidate_1280_bottom.png",
        "ui_candidate_1280_air.png", "ui_candidate_1600_cooldown.png",
        "ui_candidate_validation.json", "ui_candidate_touch_test.log", "ui_candidate_render.log",
    ]:
        if (revision_dir / name).exists():
            html = html.replace(f"inspection/{name}", f"inspection/{revision}/{name}")
REPORT.write_text(html)
print(REPORT)
