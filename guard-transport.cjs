'use strict';

// Transport is deliberately independent of the fingerprint engine. Project
// prompts never enter probes; probe outputs never enter the project response.
const http = require('node:http');
const zlib = require('node:zlib');
const {randomUUID} = require('node:crypto');

function guardFailure(reason, code = 'guard_unverified') {
  const e = new Error(reason); e.code = code; e.status = 409; return e;
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
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output || []).flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => ['output_text', 'input_text', 'text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n');
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

async function collectResponse(response, {expectedModel, signal, maxBytes = 16 * 1024 * 1024,
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
        throw guardFailure('上游声明的模型与请求模型不一致，已切断并锁定该模型。', 'guard_blocked');
      }
    }
    if (event.type === 'response.completed') {
      if (!event.response || event.response.status !== 'completed') throw guardFailure('上游完成状态无效。');
      complete = true; completedResponse = event.response;
    } else if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
      throw guardFailure('上游未完整完成响应，已拦截；这不是模型降智判定。');
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') delta += event.delta;
  }
  const parser = isSse ? createEventParser(inspect) : null;
  try {
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
      if (parsed.error || parsed.status !== 'completed') throw guardFailure('上游 JSON 响应未完整完成，已拦截。');
      inspect({type: 'response.completed', response: parsed});
    }
    if (!complete) throw guardFailure('响应在 response.completed 前结束，已拦截全部输出。');
    if (!lastModel) throw guardFailure('上游未提供模型标识，无法完成一致性校验。');
    if (signal?.aborted) throw guardFailure('请求已取消或模型被锁定。');
    return {body: Buffer.concat(chunks), isSse, model: lastModel, text: delta || responseText(completedResponse)};
  } catch (error) {
    response.destroy(); stream.destroy();
    if (error.code?.startsWith('guard_')) throw error;
    throw guardFailure('上游连接异常，响应未能验证；请重新检测。');
  } finally {
    budget.bytes -= bytes;
    signal?.removeEventListener('abort', abort);
  }
}

async function probe({context, signal, prompt}) {
  const target = new URL(context.transport.upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw guardFailure('检测仅允许经现有本地 CC Switch 转发。');
  }
  const original = context.transport.headers;
  const headers = {'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity'};
  for (const key of ['authorization', 'x-api-key', 'api-key', 'user-agent', 'originator', 'openai-beta', 'openai-organization', 'openai-project']) {
    if (original[key]) headers[key] = original[key];
  }
  headers['session_id'] = randomUUID();
  const payload = {model: context.model, store: false, stream: true,
    instructions: 'Follow the requested number-generation task. Return only the requested numbers.',
    input: [{role: 'user', content: [{type: 'input_text', text: prompt}]}],
    include: ['reasoning.encrypted_content']};
  if (context.effort && context.effort !== 'default') payload.reasoning = {effort: context.effort};
  const body = Buffer.from(JSON.stringify(payload));
  headers['content-length'] = String(body.length);
  let request;
  const abort = () => request?.destroy(new Error('probe_cancelled'));
  signal?.addEventListener('abort', abort, {once: true});
  try {
    if (signal?.aborted) throw guardFailure('检测已取消。');
    const response = await new Promise((resolve, reject) => {
      const route = new URL(context.transport.path, 'http://127.0.0.1').pathname.replace(/\/compact\/?$/, '');
      request = http.request({hostname: target.hostname, port: target.port, path: route, method: 'POST', headers}, resolve);
      request.setTimeout(60000, () => request.destroy(new Error('probe_timeout')));
      request.on('error', reject); request.end(body);
    });
    if (response.statusCode !== 200) {
      response.destroy(); throw guardFailure('检测上游返回 HTTP ' + response.statusCode + '，未能验证。');
    }
    return await collectResponse(response, {expectedModel: context.model, signal, maxBytes: 2 * 1024 * 1024});
  } finally { signal?.removeEventListener('abort', abort); }
}

module.exports = {probe, collectResponse, createEventParser, sameModel, guardFailure};
