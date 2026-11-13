const assert = require('node:assert/strict');
const sharp = require('sharp');
const { locateTextComponents } = require('./bbox_text_atlas.js');
const { placeModelRgba } = require('./bbox_model_rgba.js');

async function main() {
  const width = 240, height = 240, data = Buffer.alloc(width * height * 4);
  const paint = (x, y, w, h, alpha = 255) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const at = (row * width + col) * 4;
      data[at] = col; data[at + 1] = row; data[at + 2] = 153; data[at + 3] = alpha;
    }
  };
  // More disconnected glyphs than the old target-count + 8 cap, in two lines.
  for (let i = 0; i < 12; i++) paint(8 + i * 7, 21, 4, 13);
  for (let i = 0; i < 6; i++) paint(45 + i * 8, 84, 5, 29);
  // The lower line crosses cell one's bottom, but belongs to that target.
  paint(150, 87, 30, 23); paint(9, 155, 70, 28); paint(150, 158, 26, 22);
  // Small disconnected punctuation and fractional-alpha RGBA survive crop.
  paint(95, 25, 2, 2); paint(20, 20, 1, 1, 1);
  const original = Buffer.from(data);
  const layout = { width, height, cells: [
    { x: 0, y: 0, width: 110, height: 100 }, { x: 130, y: 0, width: 110, height: 100 },
    { x: 0, y: 124, width: 110, height: 100 }, { x: 130, y: 124, width: 110, height: 100 },
  ] };
  const result = locateTextComponents({ data, width, height, channels: 4 }, layout, 4);
  assert(data.equals(original), 'Localization must never edit alpha or RGB');
  const first = result.regions[0], third = result.regions[2];
  assert(first.rect.top + first.rect.height >= 113, 'A glyph tail outside its cell must survive');
  assert(first.component_indices.length >= 19, 'Keep all glyphs and punctuation, without a candidate cap');
  assert(third.rect.top > 113, 'The following cell cannot inherit the preceding glyph tail');
  const assignments = result.regions.flatMap(r => r.component_indices);
  assert.equal(new Set(assignments).size, assignments.length, 'Each component has exactly one owner');
  const model = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const rect = first.rect;
  const placement = await placeModelRgba(model, rect, [0, 0, rect.width, rect.height]);
  const actual = await sharp(placement.buffer).raw().toBuffer();
  const expected = await sharp(model).extract(rect).raw().toBuffer();
  assert(actual.equals(expected), 'Unscaled crop retains returned RGBA, including alpha=1');
  const small = await placeModelRgba(model, rect, [0, 0, 42, 37]);
  assert(small.placement.raster_scale.every(s => s <= 1));
  assert.throws(() => locateTextComponents({ data: Buffer.alloc(width * height * 4), width, height, channels: 4 }, layout, 4), /MISSING_TARGET/);
  const shifted = Buffer.alloc(width * height * 4);
  const glyph = (x, y) => {
    for (let yy = y; yy < y + 12; yy++) for (let xx = x; xx < x + 6; xx++) {
      const at = (yy * width + xx) * 4;
      shifted[at] = 180; shifted[at + 1] = 155; shifted[at + 2] = 120; shifted[at + 3] = 255;
    }
  };
  for (const y of [40, 112, 180]) for (const x of [90, 102, 114]) glyph(x, y);
  shifted[(39 * width + 89) * 4 + 3] = 1;
  const shiftedBefore = Buffer.from(shifted);
  const singleColumn = { width, height, columns: 1, rows: 3, cells: [
    { x: 0, y: 0, width: 240, height: 50 },
    { x: 40, y: 60, width: 160, height: 30 },
    { x: 65, y: 110, width: 110, height: 30 },
  ] };
  const shiftedResult = locateTextComponents({ data: shifted, width, height, channels: 4 }, singleColumn, 3);
  assert.equal(shiftedResult.matching_strategy, 'returned_single_column_text_rows');
  assert.deepEqual(shiftedResult.regions.map(region => region.component_bbox[1]), [40, 112, 180], 'Use complete returned row order after vertical reflow');
  assert(shifted.equals(shiftedBefore), 'Returned-row localization cannot modify model RGBA');
  const missingLine = Buffer.from(shifted);
  missingLine.fill(0, 112 * width * 4, 124 * width * 4);
  assert.throws(() => locateTextComponents({ data: missingLine, width, height, channels: 4 }, singleColumn, 3), /MISSING_TARGET/, 'Do not force a missing text line into the expected count');
  console.log('PASS: complete multiline text beyond cell edge; 19+ disconnected glyphs; unique ownership; exact raw RGBA; no upsampling; missing-target gate');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
