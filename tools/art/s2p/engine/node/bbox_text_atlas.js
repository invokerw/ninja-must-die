// Locate complete returned glyphs. Cell edges guide ownership, never cut glyphs.
const assert = require('node:assert/strict');
const sharp = require('sharp');

function locateTextComponents({ data, width, height, channels }, layout, count) {
  assert(count > 0 && count <= layout.cells.length);
  const seen = new Uint8Array(width * height), queue = new Int32Array(width * height);
  const components = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || data[start * channels + channels - 1] <= 16) continue;
    let head = 0, tail = 1, left = width, top = height, right = 0, bottom = 0, sx = 0, sy = 0;
    queue[0] = start; seen[start] = 1;
    while (head < tail) {
      const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (seen[next] || data[next * channels + channels - 1] <= 16) continue;
        seen[next] = 1; queue[tail++] = next;
      }
    }
    components.push({ index: components.length, bbox: [left, top, right - left, bottom - top],
      area: tail, center: [sx / tail, sy / tail] });
  }
  assert(!components.some(c => c.area >= width * height * .98), 'TEXT_ATLAS_OPAQUE_RESPONSE');
  const cells = layout.cells.slice(0, count).map(c => ({
    center: [(c.x + c.width / 2) * width / layout.width, (c.y + c.height / 2) * height / layout.height],
    width: c.width * width / layout.width, height: c.height * height / layout.height,
  }));
  let groups = Array.from({ length: count }, () => []);
  let matchingStrategy = 'fixed_cell_complete_text_components';
  // Do not cap the candidates by target count: one text target can contain
  // dozens of independent characters, accents and punctuation marks. Assign
  // each whole component once, using its center rather than clipping its tail
  // at a cell border. This also handles several text lines in the same target.
  for (const component of components.filter(c => c.area >= 2)) {
    const distances = cells.map((cell, index) => ({ index,
      distance: ((component.center[0] - cell.center[0]) / cell.width) ** 2 +
        ((component.center[1] - cell.center[1]) / cell.height) ** 2 }));
    distances.sort((a, b) => a.distance - b.distance);
    groups[distances[0].index].push(component);
  }
  // A returned single-column atlas can redistribute the vertical whitespace.
  // When fixed cells lose a target, accept the actual ordered text lines only
  // if the return has exactly one separate, complete line per requested row.
  // Missing rows or multiline ambiguity remain failures; no pixels are edited.
  const sourceRows = layout.cells.slice(0, count);
  const orderedSingleColumn = layout.columns === 1 && sourceRows.every((cell, index) =>
    index === 0 || cell.y >= sourceRows[index - 1].y + sourceRows[index - 1].height);
  if (groups.some(group => !group.length) && orderedSingleColumn) {
    const rows = [];
    for (const component of components.filter(c => c.area >= 2).sort((a, b) => a.bbox[1] - b.bbox[1])) {
      const top = component.bbox[1], bottom = top + component.bbox[3];
      const row = rows.at(-1);
      if (row && top < row.bottom) {
        row.components.push(component); row.bottom = Math.max(row.bottom, bottom);
      } else rows.push({ top, bottom, components: [component] });
    }
    if (rows.length === count && rows.every(row => row.bottom - row.top >= 3 &&
      row.components.reduce((sum, component) => sum + component.area, 0) >= 8)) {
      groups = rows.map(row => row.components);
      matchingStrategy = 'returned_single_column_text_rows';
    }
  }
  const padding = Math.max(2, Math.round(Math.min(width, height) * .002));
  const regions = groups.map((group, targetIndex) => {
    assert(group.length, `TEXT_ATLAS_MISSING_TARGET_${targetIndex + 1}`);
    const left = Math.min(...group.map(c => c.bbox[0]));
    const top = Math.min(...group.map(c => c.bbox[1]));
    const right = Math.max(...group.map(c => c.bbox[0] + c.bbox[2]));
    const bottom = Math.max(...group.map(c => c.bbox[1] + c.bbox[3]));
    const x = Math.max(0, left - padding), y = Math.max(0, top - padding);
    const r = Math.min(width, right + padding), b = Math.min(height, bottom + padding);
    // Rectangular crops must not pick up another target's glyph. Ambiguous
    // interleaving needs review; a hard cell crop would silently truncate it.
    for (const [otherIndex, other] of groups.entries()) if (otherIndex !== targetIndex) {
      for (const c of other) assert(!(c.bbox[0] < r && c.bbox[0] + c.bbox[2] > x &&
        c.bbox[1] < b && c.bbox[1] + c.bbox[3] > y), `TEXT_ATLAS_INTERLEAVED_TARGETS_${targetIndex + 1}_${otherIndex + 1}`);
    }
    return { target_index: targetIndex, rect: { left: x, top: y, width: r - x, height: b - y },
      component_bbox: [left, top, right - left, bottom - top],
      component_indices: group.map(c => c.index), component_area: group.reduce((n, c) => n + c.area, 0),
      source_cell_rect: layout.cells[targetIndex], complete_components: true };
  });
  return { method: 'complete_text_components', matching_strategy: matchingStrategy,
    reason: 'whole_glyph_ownership_without_cell_edge_clipping_or_candidate_limit',
    response_size: [width, height], component_count: components.length, regions };
}

async function detectTextAtlasRegions(model, boxes, layout) {
  const raw = await sharp(model).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return locateTextComponents({ data: raw.data, ...raw.info }, layout, boxes.length);
}

module.exports = { detectTextAtlasRegions, locateTextComponents };
