(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RunTiming = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const terminal = status => ["completed", "failed", "stopped", "skipped"].includes(status);
  const active = status => ["running", "stopping", "waiting_retry"].includes(status);
  const timestamp = value => {
    const ms = Date.parse(value || "");
    return Number.isFinite(ms) ? ms : null;
  };
  function applyStepUpdate(step, update) {
    const firstStart = step.started_at;
    const wasTerminal = terminal(step.status);
    Object.assign(step, update);
    if (firstStart) step.started_at = firstStart;
    else if (active(update.status)) step.started_at = update.at;
    if (active(update.status) && wasTerminal) {
      delete step.completed_at;
      delete step.finished_at;
      delete step.elapsed_ms;
    }
    if (terminal(update.status)) {
      step.finished_at = step.completed_at = update.at;
      if (timestamp(step.started_at) !== null)
        step.elapsed_ms = Math.max(0, timestamp(update.at) - timestamp(step.started_at));
    }
    return step;
  }
  function finishRunTiming(job, at = new Date().toISOString()) {
    if (!terminal(job.status)) return;
    job.finished_at = job.completed_at = at;
    job.updated_at = at;
    job.elapsed_ms = Math.max(0, timestamp(at) - timestamp(job.started_at));
    for (const step of job.steps || []) {
      if (active(step.status)) applyStepUpdate(step, { status: job.status, at });
      const start = timestamp(step.started_at), end = timestamp(step.finished_at || step.completed_at);
      if (start !== null && end !== null) step.elapsed_ms = Math.max(0, end - start);
    }
  }
  function timingSnapshot(job) {
    const keys = ["id", "workspace_account", "source", "output_dir", "status", "stage", "auto_retry_count", "auto_retry_interval_seconds", "started_at",
      "finished_at", "completed_at", "updated_at", "elapsed_ms", "loops", "cutouts", "bbox_mask_delete_mode"];
    const result = Object.fromEntries(keys.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
    result.steps = (job.steps || []).map(step => Object.fromEntries(
      ["id", "title", "description", "order", "status", "at", "started_at", "finished_at", "completed_at", "elapsed_ms", "progress"]
        .filter(key => step[key] !== undefined).map(key => [key, step[key]])));
    return result;
  }
  function timingValues(record, parent = null, now = Date.now()) {
    const start = timestamp(record?.started_at);
    let end = timestamp(record?.finished_at || record?.completed_at);
    if (end === null && terminal(record?.status)) {
      // Older failed Web jobs omitted their own end timestamp. Their final
      // step still has it; use that recorded time, never a moving clock.
      const ends = (record.steps || []).map(step => timestamp(step.finished_at || step.completed_at)).filter(ms => ms !== null);
      end = ends.length ? Math.max(...ends) : timestamp(record.updated_at || record.at || parent?.finished_at || parent?.completed_at);
    }
    const live = end === null && active(record?.status);
    const elapsed = start !== null && (end !== null || live) ? Math.max(0, (end ?? now) - start) : null;
    return { start, end, live, elapsed };
  }
  function formatDuration(ms) {
    if (ms === null || !Number.isFinite(ms)) return "未记录";
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
    return `${hours ? `${hours}小时 ` : ""}${hours || minutes ? `${minutes}分 ` : ""}${seconds}秒`;
  }
  function formatDateTime(ms) {
    if (ms === null) return "—";
    return new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  return { terminal, active, timestamp, applyStepUpdate, finishRunTiming, timingSnapshot,
    timingValues, formatDuration, formatDateTime };
});
