// Bound speculative visual work while keeping deletion/depth and commits serial.
// Every detector sees its own exact residual and all preceding staged metadata.
const assert = require('node:assert/strict');

async function runVisualWindow({loops, maxRounds, window = 3, detect, prepare, extract, commit, background, complete}) {
  assert(Number.isInteger(window) && window >= 1, 'Invalid visual planning window');
  const staged = [...loops], pending = [];
  let commits = Promise.resolve(), failure = null, terminal = null;
  const settle = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
  const guard = () => { if (failure) throw failure; };
  try {
    for (let index = loops.length + 1; index <= maxRounds + 1; index++) {
      // Only successful in-order commits free a window slot.
      if (pending.length >= window) {
        const oldest = pending.shift();
        await oldest.committed;
        guard();
      }
      guard();
      const plan = await detect(index, structuredClone(staged));
      guard();
      if (plan.background_only) {
        // Uses the same bounded image queue as cutouts, on the terminal residual.
        terminal = settle(background(plan, index, structuredClone(staged)));
        await commits;
        guard();
        const result = await terminal;
        if (result.error) throw result.error;
        await complete(result.value, plan);
        return {completed: true};
      }
      const item = await prepare(index, plan, staged);
      guard();
      staged.push(item.staged);
      const generated = settle(extract(item)).then(result => {
        if (result.error) failure ||= result.error;
        return result;
      });
      const predecessor = commits;
      const committed = predecessor.then(async () => {
        const result = await generated;
        if (result.error) throw result.error;
        await commit(item, result.value);
      });
      // Observe errors immediately; later commits never pass a failed predecessor.
      committed.catch(error => { failure ||= error; });
      commits = committed;
      pending.push({generated, committed});
    }
    await commits;
    guard();
    return {completed: false};
  } finally {
    // Drain requests even on failure. Successful descendants are cached, not committed.
    await Promise.all(pending.map(item => item.generated));
    await commits.catch(() => {});
    if (terminal) await terminal;
  }
}

module.exports = {runVisualWindow};
