'use strict';

// Transport is deliberately independent of the fingerprint engine. Project
// prompts never enter probes; probe outputs never enter the project response.
const http = require('node:http');
const zlib = require('node:zlib');
const {randomUUID} = require('node:crypto');
const PROBE_TIMEOUT_MS = 180000;

function guardFailure(reason, code = 'guard_unverified') {
  const e = new Error(reason); e.code = code; e.status = 409; return e;
}

function transientFailure(reason) {
  return Object.assign(guardFailure(reason), {retryable: true});
}

function upstreamFailure(status, body, retryAfter) {
  const description = describeUpstreamError(status, body);
  const error = guardFailure('检测上游返回 HTTP ' + status + '：' + description + '。未能验证，这不是降智结论。');
  // A 429 can mean exhausted quota; a 503 can mean an unsupported model.
  // Those permanent failures must not consume more paid probe attempts.
  const permanent = /模型不可用|配额不足|认证失败|访问权限|拒绝访问|要求付费/.test(description);
  error.retryable = !permanent && [408,429,500,502,503,504,520,522,524].includes(status);
  if (typeof retryAfter === 'string' && retryAfter.trim()) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.ceil(delay);
  }
  return error;
}

function sameModel(expected, actual) {
  return typeof actual === 'string' && (actual === expected
    || (actual.startsWith(expected + '-') && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(expected.length + 1))));
}

function createEventParser(onEvent) {
  let text = '';
  const {StringDecoder} = require('node:string_decoder');
  const decoder = new StringDecoder('utf8');
  function drain(final = false) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(text))) {
      const frame = text.slice(0, match.index);
      text = text.slice(match.index + match[0].length);
      parseFrame(frame);
    }
    if (final && text.trim()) { parseFrame(text); text = ''; }
  }
  function parseFrame(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw guardFailure('上游流包含无法验证的事件，响应已拦截。'); }
    onEvent(event);
  }
  return {push(chunk) { text += decoder.write(chunk); drain(); }, end() { text += decoder.end(); drain(true); }};
}

function responseText(response) {
  // The completed response is authoritative. An empty convenience field must
  // not hide a populated output array supplied by a compatible upstream.
  const output = (Array.isArray(response?.output) ? response.output : []).flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .filter(part => ['output_text', 'input_text', 'text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n');
  if (output.trim()) return output;
  return typeof response?.output_text === 'string' ? response.output_text : '';
}

function decodedStream(response) {
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  const methods = {gzip: 'createGunzip', deflate: 'createInflate', br: 'createBrotliDecompress', zstd: 'createZstdDecompress'};
  if (encoding === 'identity') return response;
  if (!methods[encoding]) throw guardFailure('上游响应编码暂不支持验证，响应已拦截。');
  const decoder = zlib[methods[encoding]]();
  response.on('error', e => decoder.destroy(e));
  response.pipe(decoder);
  decoder.once('close', () => { if (!response.complete) response.destroy(); });
  return decoder;
}

// Error bodies are untrusted and may contain credentials or request details.
// Inspect a small JSON body only to produce a fixed, local description; never
// persist or return upstream prose, unknown error codes, or HTML.
function describeUpstreamError(status, body) {
  const categories = [
    {codes: ['model_not_found', 'model_not_supported', 'unsupported_model', 'invalid_model', 'no_available_channel'],
      message: '上游提示请求模型不可用或没有可用渠道',
      pattern: /(?:model.{0,80}(?:not found|not supported|unsupported|unavailable|does not exist)|(?:unsupported|unknown|invalid) model|no available (?:channel|route)|(?:模型|渠道).{0,40}(?:不存在|不支持|不可用)|(?:无|没有).{0,20}可用渠道)/i},
    {codes: ['insufficient_quota', 'insufficient_balance', 'balance_insufficient', 'quota_exceeded'],
      message: '上游提示余额或配额不足',
      pattern: /(?:insufficient.{0,30}(?:quota|balance|credit)|(?:quota|balance|credit).{0,30}(?:exceeded|exhausted|insufficient)|(?:余额|额度|配额).{0,20}(?:不足|耗尽|用尽|超出))/i},
    {codes: ['concurrency_queued'], message: '上游并发名额已满，请求正在排队',
      pattern: /(?:all concurrency slots are busy|(?:concurrency|request).{0,40}(?:queued|in the queue)|并发.{0,20}(?:占满|已满)|请求.{0,20}排队)/i},
    {codes: ['rate_limit_exceeded', 'rate_limit_error', 'rate_limit', 'too_many_requests', 'concurrency_limit_exceeded'],
      message: '上游提示请求频率或并发超限',
      pattern: /(?:rate.?limit|too many requests|concurrency.{0,30}(?:limit|exceed)|(?:限流|频率过高|并发.{0,20}(?:超|限制)))/i},
    {codes: ['invalid_api_key', 'authentication_error', 'invalid_authentication'],
      message: '上游提示认证失败，请检查该供应商的凭据',
      pattern: /(?:invalid.{0,20}api.?key|authentication (?:failed|error)|(?:认证失败|无效.{0,10}(?:密钥|令牌)))/i},
    {codes: ['permission_denied', 'permission_error', 'access_denied'],
      message: '上游提示当前凭据没有访问权限', pattern: /(?:permission denied|access denied|无访问权限|权限不足)/i},
    {codes: ['overloaded_error', 'server_error', 'service_unavailable'],
      message: '上游服务暂时不可用', pattern: /(?:service unavailable|server overloaded|服务暂时不可用)/i}
  ];
  let parsed;
  try { parsed = JSON.parse(body); } catch {}
  const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : parsed) : null;
  const codes = error ? [error.code, error.type, error.error_code,
    typeof parsed.error === 'string' ? parsed.error : null].filter(value => typeof value === 'string') : [];
  let generic;
  for (const code of codes) {
    const category = categories.find(item => item.codes.includes(code));
    if (category === categories.at(-1)) generic = category.message + '（' + code + '）';
    else if (category) return category.message + '（' + code + '）';
  }
  const message = error && typeof error.message === 'string' ? error.message.slice(0, 2048) : '';
  for (const category of categories) if (category.pattern.test(message)) return category.message;
  if (generic) return generic;
  if (status === 429) return '上游请求受限，请检查限流或配额';
  if (status === 401) return '上游认证失败，请检查该供应商的凭据';
  if (status === 403) return '上游拒绝访问，请检查该供应商的权限';
  if (status === 402) return '上游要求付费，请检查余额或配额';
  if (status >= 500) return '上游服务暂时不可用';
  return '上游未接受检测请求';
}

function readErrorBody(response, signal) {
  return new Promise(resolve => {
    const chunks = [];
    let stream, bytes = 0, finished = false, timer;
    const finish = (complete = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stream?.removeListener('data', onData);
      stream?.removeListener('end', onEnd);
      stream?.removeListener('close', onClose);
      resolve(complete ? Buffer.concat(chunks).toString('utf8') : '');
      chunks.length = 0;
      if (!complete) { response.destroy(); stream?.destroy(); }
    };
    const abort = () => finish();
    const onData = chunk => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > 32 * 1024) finish();
      else chunks.push(chunk);
    };
    const onEnd = () => finish(true), onClose = () => finish();
    if (signal?.aborted) { finish(); return; }
    try { stream = decodedStream(response); } catch { finish(); return; }
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(finish, 2000);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', () => finish());
    stream.once('close', onClose);
  });
}

async function collectResponse(response, {expectedModel, expectedProvider, signal, maxBytes = 16 * 1024 * 1024,
  onMismatch, onProgress = () => {}, budget = {bytes: 0, limit: 64 * 1024 * 1024}}) {
  const chunks = [];
  let bytes = 0, complete = false, completedResponse, delta = '', lastModel;
  const isSse = /text\/event-stream/i.test(String(response.headers['content-type'] || ''));
  const stream = decodedStream(response);
  const abort = () => { response.destroy(); stream.destroy(guardFailure('请求已取消或同一模型已被锁定。')); };
  signal?.addEventListener('abort', abort, {once: true});
  function inspect(event) {
    if (!event || typeof event !== 'object') throw guardFailure('上游事件格式无法验证。');
    if (complete) throw guardFailure('响应完成后仍包含额外事件，已拦截。');
    const actual = event.response?.model;
    if (actual != null) {
      lastModel = actual;
      if (!sameModel(expectedModel, actual)) {
        onMismatch?.(actual);
        throw guardFailure('上游声明的模型与请求模型不一致，本轮未用于指纹评分；未自动锁定模型。', 'guard_blocked');
      }
    }
    if (event.type === 'response.completed') {
      if (!event.response || event.response.status !== 'completed') throw guardFailure('上游完成状态无效。');
      complete = true; completedResponse = event.response;
    } else if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
      const remote = event.response?.error || event.error;
      const detail = remote || event.response?.incomplete_details;
      const description = describeUpstreamError(0, JSON.stringify({error: detail || {code: event.code, message: event.message}}));
      const error = guardFailure('上游未完整完成响应，已拦截；这不是模型降智判定。');
      error.retryable = /并发名额|频率或并发超限|服务暂时不可用/.test(description);
      throw error;
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') delta += event.delta;
  }
  const parser = isSse ? createEventParser(inspect) : null;
  try {
    if (expectedProvider && (response.headers['x-magpie-provider'] !== expectedProvider
        || response.headers['x-magpie-model'] !== expectedProvider + '/' + expectedModel)) {
      throw guardFailure('Magpie 未确认预期供应商与模型路由，响应已拦截；请检查故障转移、路由插件或 Magpie 版本。');
    }
    if (signal?.aborted) throw guardFailure('请求已取消。');
    for await (const chunk of stream) {
      onProgress();
      bytes += chunk.length; budget.bytes += chunk.length;
      if (bytes > maxBytes || budget.bytes > budget.limit) throw guardFailure('待验证响应超过本地缓冲上限，已拦截。');
      chunks.push(chunk);
      parser?.push(chunk);
    }
    if (parser) parser.end();
    else {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw guardFailure('上游没有返回可验证的 Responses 内容。'); }
      if (parsed?.error || ['failed', 'incomplete'].includes(parsed?.status)) {
        inspect({type: parsed.status === 'incomplete' ? 'response.incomplete' : 'response.failed', response: parsed, error: parsed.error});
      }
      if (parsed?.status !== 'completed') throw guardFailure('上游 JSON 响应未完整完成，已拦截。');
      inspect({type: 'response.completed', response: parsed});
    }
    if (!complete) throw transientFailure('响应在 response.completed 前结束，已拦截全部输出。');
    if (!lastModel) throw guardFailure('上游未提供模型标识，无法完成一致性校验。');
    if (signal?.aborted) throw guardFailure('请求已取消或模型被锁定。');
    // Some upstreams send whitespace/partial deltas but put the full answer in
    // response.completed. Never let those deltas shadow the final answer. When
    // completed has no body, retain the ordinary delta-only streaming fallback.
    const finalText = responseText(completedResponse);
    const usage = completedResponse?.usage;
    const count = key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
    return {body: Buffer.concat(chunks), isSse, model: lastModel, text: finalText.trim() ? finalText : delta,
      usage: usage ? {input_tokens: count('input_tokens'), output_tokens: count('output_tokens'), total_tokens: count('total_tokens')} : null};
  } catch (error) {
    response.destroy(); stream.destroy();
    if (error.code?.startsWith('guard_')) throw error;
    throw transientFailure('上游连接异常，响应未能验证；请重新检测。');
  } finally {
    budget.bytes -= bytes;
    signal?.removeEventListener('abort', abort);
  }
}

async function probe({context, signal, prompt, timeoutMs = PROBE_TIMEOUT_MS}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PROBE_TIMEOUT_MS) throw guardFailure('检测等待时限无效。');
  const target = new URL(context.transport.upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw guardFailure('检测仅允许经现有本地网关转发。');
  }
  const original = context.transport.headers;
  const headers = {'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity'};
  for (const key of ['authorization', 'x-api-key', 'api-key', 'user-agent', 'originator', 'openai-beta', 'openai-organization', 'openai-project']) {
    if (original[key]) headers[key] = original[key];
  }
  headers['session_id'] = randomUUID();
  const payload = {model: context.requestModel || context.model, store: false, stream: true,
    instructions: '请完成用户要求的整数选择任务，直接输出数字，不要调用工具或编写代码。',
    input: [{role: 'user', content: [{type: 'input_text', text: prompt}]}],
    include: ['reasoning.encrypted_content']};
  if (context.effort && context.effort !== 'default') payload.reasoning = {effort: context.effort};
  const body = Buffer.from(JSON.stringify(payload));
  headers['content-length'] = String(body.length);
  let request, response, deadline, stopped;
  const stop = error => {
    stopped ||= error;
    request?.destroy(error);
    response?.destroy(error);
  };
  const abort = () => stop(guardFailure('检测已取消。'));
  signal?.addEventListener('abort', abort, {once: true});
  try {
    if (signal?.aborted) throw guardFailure('检测已取消。');
    deadline = setTimeout(() => stop(transientFailure('单个检测样本等待超过 ' + (timeoutMs / 1000)
      + ' 秒，已停止；未能验证，这不是降智结论。')), timeoutMs);
    deadline.unref?.();
    response = await new Promise((resolve, reject) => {
      const route = new URL(context.transport.path, 'http://127.0.0.1').pathname.replace(/\/compact\/?$/, '');
      request = http.request({hostname: target.hostname, port: target.port, path: route, method: 'POST', headers}, resolve);
      request.on('error', reject); request.end(body);
    });
    if (stopped) throw stopped;
    if (response.statusCode !== 200) {
      const errorBody = await readErrorBody(response, signal);
      if (signal?.aborted) throw guardFailure('检测已取消。');
      throw upstreamFailure(response.statusCode, errorBody, response.headers['retry-after']);
    }
    return await collectResponse(response, {expectedModel: context.model, expectedProvider: context.gatewayProvider, signal, maxBytes: 2 * 1024 * 1024});
  } catch (error) {
    // Destroying the request can make IncomingMessage emit ECONNRESET instead
    // of the original timeout. Keep the actual local cause for the dashboard.
    if (stopped) throw stopped;
    if (error.code?.startsWith('guard_')) throw error;
    throw transientFailure('检测连接中断或无法建立；未收到可验证的完整响应，这不是降智结论。');
  } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); }
}

module.exports = {probe, collectResponse, createEventParser, sameModel, guardFailure, PROBE_TIMEOUT_MS};
