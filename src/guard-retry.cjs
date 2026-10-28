'use strict';

const {setTimeout: delay} = require('node:timers/promises');
const {guardFailure} = require('./guard-transport.cjs');
const MAX_PROBE_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60000;

// The caller owns one budget for the entire check, including confirmation.
// Retry only transport failures, never a completed sample or its verdict.
async function probeWithRetry({probe, context, signal, prompt, budget, onProgress = () => {}, wait = delay}) {
  let sampleRetries = 0;
  for (;;) {
    if (signal?.aborted) throw guardFailure('检测已取消。');
    onProgress({sampleRetries, retriesUsed: budget.used, maxRetries: MAX_PROBE_RETRIES, waiting: false});
    try { return await probe({context, signal, prompt}); }
    catch (error) {
      if (signal?.aborted) throw guardFailure('检测已取消。');
      if (error.code !== 'guard_unverified' || error.retryable !== true) throw error;
      if (budget.used >= MAX_PROBE_RETRIES) {
        throw guardFailure('本次检测的 3 次额外重试额度已用完。' + error.message);
      }
      const waitMs = Math.max(1000 * 2 ** budget.used,
        Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
      if (waitMs > MAX_RETRY_DELAY_MS) {
        throw guardFailure('上游要求等待超过 60 秒，已停止内部重试，请稍后再检测。' + error.message);
      }
      budget.used++; sampleRetries++;
      onProgress({sampleRetries, retriesUsed: budget.used, maxRetries: MAX_PROBE_RETRIES, waiting: true, waitMs});
      try { await wait(waitMs, undefined, {signal}); }
      catch (error) {
        if (signal?.aborted) throw guardFailure('检测已取消。');
        throw error;
      }
    }
  }
}

module.exports = {probeWithRetry, MAX_PROBE_RETRIES};
