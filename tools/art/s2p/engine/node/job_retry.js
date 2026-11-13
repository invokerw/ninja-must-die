const { AsyncLocalStorage } = require("node:async_hooks");

// Scope the policy to one Web job, including its concurrent Atlas workers.
// CLI calls retain their existing retry behavior.
const context = new AsyncLocalStorage();
function normalizeRetryPolicy(payload = {}) {
  const integer = (value, fallback, min, max, name) => {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return number;
  };
  return {
    auto_retry_count: integer(payload.auto_retry_count, 3, 0, 20, "auto_retry_count"),
    auto_retry_interval_seconds: integer(payload.auto_retry_interval_seconds, 30, 1, 3600, "auto_retry_interval_seconds"),
  };
}
function createJobRetryController(job, { onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const policy = normalizeRetryPolicy(job);
  const signal = job.abortController.signal;
  const used = new Map();
  let pending = null;
  const stopped = () => job.cancelled || signal.aborted;
  const notify = () => onChange(job);
  function wait(request) {
    if (stopped()) return Promise.reject(new Error("JOB_STOPPED"));
    if (pending) return Promise.reject(new Error("RETRY_ALREADY_PENDING"));
    return new Promise((resolve, reject) => {
      const count = used.get(request.request_id) || 0;
      const scheduled = count < policy.auto_retry_count;
      const step = job.steps.find(item => item.id === job.current_step);
      const description = step?.description;
      const record = {
        ...request, step_id: step?.id, status: "failed", retryable: true,
        auto_retry_attempt: count + (scheduled ? 1 : 0),
        auto_retry_max: policy.auto_retry_count,
        auto_retry_exhausted: !scheduled && policy.auto_retry_count > 0,
        next_retry_at: scheduled ? new Date(now() + policy.auto_retry_interval_seconds * 1000).toISOString() : null,
      };
      let timer = null, settled = false;
      const cleanup = () => {
        if (timer !== null) clearTimer(timer);
        signal.removeEventListener("abort", abort);
        pending = null;
        job.pending_atlas_retry = null;
        job.requestRetryResolve = null;
        job.requestRetryReject = null;
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        job.active_request = null;
        reject(new Error("JOB_STOPPED"));
      };
      const resume = () => {
        if (settled) return;
        if (stopped()) return abort();
        settled = true;
        // Clicking during the countdown advances the same scheduled retry.
        // Manual retries after exhaustion do not replenish the automatic budget.
        used.set(request.request_id, scheduled ? count + 1 : count);
        cleanup();
        job.active_request = { ...record, status: "retrying", next_retry_at: null,
          retry_started_at: new Date(now()).toISOString() };
        job.status = "running";
        job.stage = `正在重试：${record.label || `Atlas 批次 ${record.batch || ""}`}`;
        if (step) Object.assign(step, { status: "running", description, failure_reason: null });
        notify();
        resolve();
      };
      pending = { abort };
      job.pending_atlas_retry = record;
      job.active_request = record;
      job.status = "waiting_retry";
      job.stage = scheduled ? "等待自动重试" : policy.auto_retry_count ? "自动重试次数已用完，等待手动重试" : "等待手动重试";
      if (step) Object.assign(step, { status: "waiting_retry", failure_reason: request.reason });
      job.requestRetryResolve = resume;
      job.requestRetryReject = abort;
      signal.addEventListener("abort", abort, { once: true });
      if (scheduled) timer = setTimer(resume, policy.auto_retry_interval_seconds * 1000);
      notify();
    });
  }
  async function run(request, operation) {
    let attempt = 0;
    for (;;) {
      if (stopped()) throw new Error("JOB_STOPPED");
      attempt++;
      job.active_request = { ...request, status: "running", attempt, started_at: new Date(now()).toISOString() };
      notify();
      try {
        const result = await operation();
        if (stopped()) throw new Error("JOB_STOPPED");
        if (job.active_request?.request_id === request.request_id) job.active_request = null;
        notify();
        return result;
      } catch (error) {
        if (stopped() || error.message === "JOB_STOPPED") throw error;
        await wait({ ...request, attempt, retry_label: "重试此步骤", reason: String(error.message || error).slice(0, 500) });
      }
    }
  }
  return { wait, run, dispose() { pending?.abort(); used.clear(); } };
}
const withJobRetryPolicy = (controller, operation) => context.run(controller, operation);
const hasJobRetryPolicy = () => Boolean(context.getStore());
const retryJobOperation = (request, operation) => context.getStore()?.run(request, operation) || operation();
module.exports = { normalizeRetryPolicy, createJobRetryController, withJobRetryPolicy, hasJobRetryPolicy, retryJobOperation };
