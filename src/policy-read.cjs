'use strict';

const {setTimeout: delay} = require('node:timers/promises');
const {FilterError} = require('./history-filter.mjs');
const RETRY_DELAYS = [150, 350, 700];
const UNAVAILABLE_REASONS = new Set(['database-missing', 'database-or-config-unreadable', 'policy-unavailable']);
const SQLITE_CODES = {1: 'SQLITE_ERROR', 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 8: 'SQLITE_READONLY',
  10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 14: 'SQLITE_CANTOPEN', 26: 'SQLITE_NOTADB'};
const FILE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO']);
function readErrorCode(error) {
  if (error?.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode)) return SQLITE_CODES[error.errcode & 255] || 'SQLITE_ERROR';
  if (Object.values(SQLITE_CODES).includes(error?.code) || FILE_CODES.has(error?.code)) return error.code;
  return 'policy_read_error';
}
function readFailure(error) {
  const code = readErrorCode(error);
  return {code, retryable: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'EBUSY', 'ENOENT'].includes(code)};
}
function unavailablePolicy(reason, error) {
  return {filter: false, mode: 'unavailable', reason, provider: 'unknown', readError: readFailure(error)};
}
// All attempts read a new snapshot, including after upload. Never cache another
// supplier's policy, block the event loop on a SQLite timeout, or replay upstream work.
async function readPolicyWithRetry(read, {signal, onEvent = () => {}} = {}) {
  let retries = 0;
  for (;;) {
    signal?.throwIfAborted();
    let policy;
    try { policy = await read(); }
    catch (error) { policy = unavailablePolicy('policy-unavailable', error); }
    if (!policy || typeof policy.filter !== 'boolean') policy = unavailablePolicy('policy-unavailable');
    if (!UNAVAILABLE_REASONS.has(policy.reason) && !policy.readError) {
      if (retries) onEvent('policy-read-recovered', {attempts: retries + 1});
      return policy;
    }
    const issue = policy.readError || {code: 'policy_read_error', retryable: false};
    onEvent('policy-read-error', {code: issue.code, reason: policy.reason, attempt: retries + 1});
    if (!issue.retryable || retries === RETRY_DELAYS.length) {
      onEvent('policy-read-blocked', {code: issue.code, reason: policy.reason, attempts: retries + 1});
      throw new FilterError('filter_policy_unavailable',
        '暂时无法读取 CC Switch 供应商或过滤规则（' + issue.code + '）。本次请求未向上游发送，请稍后重试；若持续出现，请在管理页导出诊断。', 503);
    }
    const delayMs = RETRY_DELAYS[retries++];
    onEvent('policy-read-retry', {code: issue.code, attempt: retries + 1, delayMs});
    await delay(delayMs, undefined, {signal});
  }
}
module.exports = {readErrorCode, readFailure, unavailablePolicy, readPolicyWithRetry, RETRY_DELAYS};
