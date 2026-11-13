const assert = require('node:assert/strict');

// Saved local repairs can restore a full backplate behind a badge even when
// the old run extracted only a shallow fragment before that badge.
function orderRepairedLayers(layers, constraints) {
  const result = layers.slice(), ids = new Set(result.map(l => l.id));
  for (const constraint of constraints) {
    assert(ids.has(constraint.id), 'Unknown repaired layer ' + constraint.id);
    for (const id of constraint.behind) assert(ids.has(id) && id !== constraint.id, 'Invalid front layer ' + id);
    const before = result.findIndex(l => l.id === constraint.id);
    const fronts = constraint.behind.map(id => result.findIndex(l => l.id === id));
    if (fronts.length && before > Math.min(...fronts)) {
      const [layer] = result.splice(before, 1);
      const after = Math.min(...constraint.behind.map(id => result.findIndex(l => l.id === id)));
      result.splice(after, 0, { ...layer, layer_order_repair: { behind: constraint.behind, previous_index: before, index: after } });
    }
  }
  for (const constraint of constraints) for (const id of constraint.behind)
    assert(result.findIndex(l => l.id === constraint.id) < result.findIndex(l => l.id === id), 'Conflicting repair depth constraints');
  return result.map((layer, z_index) => ({ ...layer, z_index }));
}
module.exports = { orderRepairedLayers };
