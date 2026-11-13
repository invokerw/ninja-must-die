// Prevent cross-target rectangular crops without changing returned RGB/alpha.
const assert = require('node:assert/strict');
const sharp = require('sharp');

function visualAtlasBatches(boxes, limit, layoutFor = null) {
  assert(Number.isSafeInteger(limit) && limit > 0);
  const area = b => b.bbox[2] * b.bbox[3];
  const sorted = boxes.map((box, index) => ({ box, index }))
    .sort((a, b) => area(b.box) - area(a.box) || a.index - b.index).map(x => x.box);
  const groups = [];
  // Keep every size cohort separate, including a pair of large objects before
  // small controls. Checking only the largest pair misses that later size gap.
  // Native coverage also depends on aspect ratio: tall targets can force a
  // shared grid below source resolution even when their areas are similar.
  let batch = [];
  for (const box of sorted) {
    const candidate = [...batch, box];
    const sizeGap = batch.length && area(batch.at(-1)) >= area(box) * 2.5;
    const losesNativePixels = batch.length && layoutFor && layoutFor(candidate).input_scale < 1;
    if (batch.length && (batch.length === limit || sizeGap || losesNativePixels)) {
      groups.push(batch); batch = [];
    }
    batch.push(box);
  }
  if (batch.length) groups.push(batch);
  return groups;
}

// Fit RETURNED row/column ranks, rather than comparing moved components to
// input-canvas coordinates. Weighted contiguous clustering retains detached
// details; axis=1 also prevents tiny details from creating false extra rows.
function visualAtlasColumns(entries, features, count, axis = 0) {
  if (entries.length < count) return null;
  const sorted = entries.slice().sort((a, b) => features[a.index].center[axis] - features[b.index].center[axis]);
  const n = sorted.length, w = [0], wx = [0], wx2 = [0];
  for (const entry of sorted) {
    const f = features[entry.index], area = f.area, x = f.center[axis];
    w.push(w.at(-1) + area); wx.push(wx.at(-1) + area * x); wx2.push(wx2.at(-1) + area * x * x);
  }
  const cost = (a, b) => Math.max(0, wx2[b] - wx2[a] - (wx[b] - wx[a]) ** 2 / (w[b] - w[a]));
  const dp = Array.from({ length: count + 1 }, () => new Array(n + 1).fill(Infinity));
  const previous = Array.from({ length: count + 1 }, () => []); dp[0][0] = 0;
  for (let k = 1; k <= count; k++) for (let end = k; end <= n; end++) for (let start = k - 1; start < end; start++) {
    const score = dp[k - 1][start] + cost(start, end);
    if (score < dp[k][end]) { dp[k][end] = score; previous[k][end] = start; }
  }
  const groups = []; let end = n;
  for (let k = count; k > 0; k--) { const start = previous[k][end]; groups.unshift(sorted.slice(start, end)); end = start; }
  return groups;
}

async function inspectVisualCrops(model, regions) {
  const raw = await sharp(model).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info, count = width * height;
  const seeds = new Map();
  for (const region of regions) for (const seed of region.component_seeds || []) {
    assert(Number.isSafeInteger(seed) && seed >= 0 && seed < count);
    assert(!seeds.has(seed), 'Visual atlas component assigned twice');
    seeds.set(seed, region.target_index);
  }
  if (!seeds.size) return { status: 'not_checked', reason: 'no_component_ownership_seeds', conflicts: [] };
  // Thresholds locate targets only. Inspect connectivity at alpha>0, retaining
  // the model's fractional-alpha edges. A weak bridge between disjoint crops
  // is recorded, but needs no alpha editing or regeneration.
  const labels = new Int32Array(count), queue = new Int32Array(count), owners = [null];
  const merged = [];
  let component = 0;
  for (let start = 0; start < count; start++) {
    if (labels[start] || !raw.data[start * channels + 3]) continue;
    component++;
    let head = 0, tail = 1;
    queue[0] = start; labels[start] = component;
    const targets = new Set();
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      if (seeds.has(p)) targets.add(seeds.get(p));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (labels[next] || !raw.data[next * channels + 3]) continue;
        labels[next] = component; queue[tail++] = next;
      }
    }
    owners.push(targets.size === 1 ? [...targets][0] : null);
    if (targets.size > 1) merged.push({ component, target_indices: [...targets], pixels: tail });
  }
  const conflicts = [];
  for (const region of regions) {
    const { left, top, width: rw, height: rh } = region.rect, foreign = new Map();
    for (let y = top; y < top + rh; y++) for (let x = left; x < left + rw; x++) {
      const p = y * width + x;
      if (!raw.data[p * channels + 3]) continue;
      const owner = owners[labels[p]];
      if (owner !== null && owner !== region.target_index) {
        const record = foreign.get(owner) || { pixels: 0, alpha_sum: 0, maximum_alpha: 0 };
        const alpha = raw.data[p * channels + 3];
        record.pixels++; record.alpha_sum += alpha; record.maximum_alpha = Math.max(record.maximum_alpha, alpha);
        foreign.set(owner, record);
      }
    }
    for (const [foreign_target_index, record] of foreign)
      conflicts.push({ target_index: region.target_index, foreign_target_index, ...record });
  }
  const ambiguous = [];
  for (const shared of merged) for (let i = 0; i < shared.target_indices.length; i++) for (let j = i + 1; j < shared.target_indices.length; j++) {
    const a = regions.find(r => r.target_index === shared.target_indices[i]), b = regions.find(r => r.target_index === shared.target_indices[j]);
    const left = Math.max(a.rect.left, b.rect.left), top = Math.max(a.rect.top, b.rect.top);
    const right = Math.min(a.rect.left + a.rect.width, b.rect.left + b.rect.width), bottom = Math.min(a.rect.top + a.rect.height, b.rect.top + b.rect.height);
    let pixels = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++)
      if (labels[y * width + x] === shared.component) pixels++;
    if (pixels) ambiguous.push({ target_indices: [a.target_index, b.target_index], component: shared.component, pixels });
  }
  // Keep returned alpha=1 haze unchanged. Subpixel opacity spread over a few
  // weak pixels cannot constitute another semantic object. Record it, while
  // rejecting any stronger foreign pixel or one opaque pixel's total alpha.
  const blocking = conflicts.filter(c => c.maximum_alpha > 16 || c.alpha_sum >= 255);
  return { status: blocking.length || ambiguous.length ? 'failed' : 'passed',
    policy: 'reject_foreign_components_without_alpha_edits', alpha_connectivity: 8,
    alpha_minimum: 1, checked_targets: regions.length, conflicts, blocking_conflicts: blocking,
    retained_subpixel_haze: conflicts.filter(c => !blocking.includes(c)),
    merged_components: merged, ambiguous_shared_alpha: ambiguous };
}

function assertVisualCrops(check) {
  if (check.status === 'failed') {
    const code = check.reason ? 'VISUAL_ATLAS_OWNERSHIP_UNRESOLVED' : 'VISUAL_ATLAS_INTERLEAVED_TARGETS';
    const error = new Error(code + ': cannot isolate complete returned targets without neighboring pixels; preserve raw atlas for review.');
    error.code = code; error.details = check;
    throw error;
  }
}

module.exports = { visualAtlasBatches, visualAtlasColumns, inspectVisualCrops, assertVisualCrops };
