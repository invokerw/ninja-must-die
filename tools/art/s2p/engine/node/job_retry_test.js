const assert = require("node:assert/strict");
const { normalizeRetryPolicy, createJobRetryController, withJobRetryPolicy, retryJobOperation, hasJobRetryPolicy } = require("./job_retry.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(policy = {}) {
  let time = 1700000000000, next = 0;
  const timers = new Map(), delays = [];
  const job = { ...normalizeRetryPolicy(policy), status: "running", current_step: "step",
    steps: [{ id: "step", status: "running", description: "原步骤" }], abortController: new AbortController() };
  const controller = createJobRetryController(job, { now: () => time,
    setTimer(callback, delay) { delays.push(delay); timers.set(++next, callback); return next; },
    clearTimer(id) { timers.delete(id); } });
  return { job, controller, timers, delays,
    fire() { const [id, callback] = [...timers][0]; timers.delete(id); time += job.auto_retry_interval_seconds * 1000; callback(); } };
}
async function main() {
  assert.deepEqual(normalizeRetryPolicy(), { auto_retry_count: 3, auto_retry_interval_seconds: 30 });
  for (const invalid of [{ auto_retry_count: -1 }, { auto_retry_count: 21 }, { auto_retry_count: 1.5 },
    { auto_retry_interval_seconds: 0 }, { auto_retry_interval_seconds: Infinity }, { auto_retry_interval_seconds: "abc" }])
    assert.throws(() => normalizeRetryPolicy(invalid));

  const f = fixture({ auto_retry_count: 2, auto_retry_interval_seconds: 17 });
  let calls = 0;
  const process = f.controller.run({ request_id: "mask_1", label: "mask" }, async () => {
    if (++calls < 5) throw new Error("validation failed");
    return "recovered";
  });
  await tick();
  assert.equal(calls, 1);
  assert.equal(f.job.status, "waiting_retry");
  assert.equal(f.job.steps[0].status, "waiting_retry");
  assert.equal(f.job.active_request.auto_retry_attempt, 1);
  assert.equal(Date.parse(f.job.active_request.next_retry_at), 1700000017000);
  f.fire(); await tick();
  assert.equal(calls, 2);
  assert.equal(f.job.active_request.auto_retry_attempt, 2);
  f.fire(); await tick();
  assert.equal(calls, 3, "Two retries means three total attempts");
  assert.equal(f.job.active_request.auto_retry_exhausted, true);
  assert.equal(f.job.active_request.next_retry_at, null);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.delays, [17000, 17000]);
  f.job.requestRetryResolve(); await tick();
  assert.equal(calls, 4);
  assert.equal(f.timers.size, 0, "Manual continuation must not reset an exhausted budget");
  f.job.requestRetryResolve();
  assert.equal(await process, "recovered");
  assert.equal(f.job.active_request, null);
  assert.equal(f.job.steps[0].status, "running");
  assert.equal(f.job.steps[0].failure_reason, null);
  const other = f.controller.wait({ request_id: "mask_2" });
  assert.equal(f.job.active_request.auto_retry_attempt, 1, "Each batch has its own budget");
  const obsoleteTimer = [...f.timers.values()][0];
  const obsoleteResume = f.job.requestRetryResolve;
  obsoleteResume();
  assert.equal(f.timers.size, 0, "Manual action cancels its countdown");
  obsoleteTimer(); obsoleteResume();
  await other;
  assert.equal(f.job.requestRetryResolve, null, "Timer/manual race must only resume once");

  const disabled = fixture({ auto_retry_count: 0 });
  const waiting = disabled.controller.wait({ request_id: "bbox" });
  assert.equal(disabled.timers.size, 0);
  assert.equal(disabled.job.active_request.auto_retry_exhausted, false);
  disabled.job.requestRetryResolve(); await waiting;

  const stopped = fixture();
  const stoppedWait = stopped.controller.wait({ request_id: "guide" });
  const stale = [...stopped.timers.values()][0];
  stopped.job.abortController.abort();
  await assert.rejects(stoppedWait, /JOB_STOPPED/);
  assert.equal(stopped.timers.size, 0);
  stale();
  assert.equal(stopped.job.active_request, null);
  await assert.rejects(stopped.controller.run({ request_id: "no_call" }, () => assert.fail("Stopped operation ran")), /JOB_STOPPED/);

  let blocked = false;
  const scoped = fixture();
  const task = withJobRetryPolicy(scoped.controller, () => retryJobOperation({ request_id: "scoped" }, async () => {
    assert.equal(hasJobRetryPolicy(), true);
    if (!blocked) { blocked = true; throw new Error("504"); }
    return 9;
  }));
  await tick();
  assert.equal(hasJobRetryPolicy(), false, "Jobs must not change the CLI or other jobs' policy");
  assert.equal(await retryJobOperation({}, async () => 7), 7);
  scoped.fire();
  assert.equal(await task, 9);
  scoped.controller.dispose();
  assert.equal(scoped.timers.size, 0);
  console.log("Job retry policy: exact limits, intervals, independent budgets, manual/automatic race, cancellation and job isolation passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
