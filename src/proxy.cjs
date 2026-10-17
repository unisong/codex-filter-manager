'use strict';

const http = require('node:http');
const zlib = require('node:zlib');
const {timingSafeEqual, randomUUID} = require('node:crypto');
const {collectResponse} = require('./guard-transport.cjs');
const FILTER_VERSION = 34;
const SERVICE = 'ccswitch-codex-reasoning-filter-v1';
const ADMIN = '/__codex_filter__';
const LIMIT = 64 * 1024 * 1024;
// Quota/credit exhaustion will never clear by replaying; only queue/rate-limit 429s are retried.
const PERMANENT_429 = /insufficient_quota|credit_balance|quota.?exceeded|not enough quota|余额不足|额度不足/i;
const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const {FilterError, filterResponsesRequest} = require('./history-filter.mjs');

function publicPolicy(policy) {
  const filter = policy?.filter === true;
  const stripLite = policy?.stripResponsesLiteHeader === true;
  return {filter, mode: filter ? 'filtering' : stripLite ? 'compatibility' : 'passthrough',
    reason: policy?.reason || 'unidentified-provider', provider: policy?.provider || 'unknown',
    ...(stripLite ? {stripResponsesLiteHeader: true} : {})};
}

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Upstream must be a loopback HTTP origin, such as http://127.0.0.1:15721');
  }
  return url.origin;
}

function cleanHeaders(headers) {
  const clean = {...headers};
  const named = String(clean.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...named, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete clean[key];
  return clean;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  // Keep the socket open so oversized requests can receive JSON 413.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new FilterError('request_too_large', 'Request exceeds filter size limit.', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeBody(buffer, encoding, limit) {
  const options = {maxOutputLength: limit};
  try {
    switch (String(encoding || 'identity').toLowerCase()) {
      case 'identity': return buffer;
      case 'gzip': return zlib.gunzipSync(buffer, options);
      case 'deflate': return zlib.inflateSync(buffer, options);
      case 'br': return zlib.brotliDecompressSync(buffer, options);
      case 'zstd': return zlib.zstdDecompressSync(buffer, options);
      default: throw new FilterError('unsupported_content_encoding', 'Unsupported request Content-Encoding.', 415);
    }
  } catch (error) {
    if (error instanceof FilterError) throw error;
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new FilterError('request_too_large', 'Decoded request exceeds filter size limit.', 413);
    throw new FilterError('invalid_compressed_request', 'Cannot decode compressed request.');
  }
}

function sendError(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status || 502, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify({error: {type: 'invalid_request_error', code: error.code || 'local_filter_error', message: error.message}}));
}

function makeProxy({getUpstream, token, dashboard, guard, requestScopedPolicy = false, onStop = () => {}, getState = () => ({}), getDiagnostics, log = () => {}, limit = LIMIT, getModelAliases = () => new Map(), getFilterPolicy = () => ({filter: false, reason: 'unidentified-provider'}),
  // Replay a concurrency-queue/rate-limit 429 instead of failing the turn. Safe only
  // for buffered POSTs: the upstream rejected the request before any model work ran.
  retry429 = null}) {
  const stats = {requests: 0, filteredRequests: 0, removedReasoningItems: 0, removedItemIds: 0,
    removedEncryptedContentItems: 0,
    strippedResponsesLiteHeaders: 0, lastLiteHeaderStrippedAt: null,
    normalizedModelAliases: 0, lastModelAliasNormalizedAt: null,
    retries429: 0, lastRetry429At: null, retry429Exhausted: 0, retry429Permanent: 0,
    blockedRequests: 0, upstreamErrors: 0, upstreamHttpErrors: 0, lastFilteredAt: null, lastUpstreamStatus: null};
  let lastPolicy = {filter: false, mode: 'passthrough', reason: 'no-request-yet'};
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID(), started = Date.now();
    let tracked = false;
    const requestLog = (event, data = {}) => log(event, {...data, requestId});
    res.on('finish', () => { if (tracked) requestLog('request-finished', {status: res.statusCode, durationMs: Date.now() - started}); });
    let upstreamRequest;
    const guardController = new AbortController();
    guardController.signal.addEventListener('abort',() => upstreamRequest?.destroy(),{once:true});
    let unwatch, heartbeat;
    res.on('close', () => {
      clearInterval(heartbeat); unwatch?.();
      if (tracked && !res.writableFinished) requestLog('request-disconnected', {durationMs: Date.now() - started});
      if (!res.writableFinished) { guardController.abort(); upstreamRequest?.destroy(); }
    });
    // SSE comments keep the local connection alive while withholding all model
    // events and tool calls. A denied request sends only an explicit error event.
    function startHeartbeat() {
      heartbeat = setInterval(() => {
        if (res.destroyed) return;
        if (!res.headersSent) res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
        res.write(': model guard is verifying\n\n');
      },5000);
      heartbeat.unref();
    }
    function requestError(error) {
      clearInterval(heartbeat);
      if (res.destroyed) return;
      if (heartbeat && res.headersSent) {
        res.end('event: error\ndata: '+JSON.stringify({type:'error',code:error.code || 'guard_unverified',message:error.message})+'\n\n');
      } else sendError(res,error);
    }
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        throw new FilterError('invalid_target', 'Only origin-form HTTP requests are accepted.');
      }
      const route = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const assetName = ['workbench-theme.css','current-selection.js'].find(name => route === ADMIN + '/' + name);
      const isDashboard = dashboard && (assetName || route === ADMIN + '/ui' || route === ADMIN + '/favicon.svg' || route.startsWith(ADMIN + '/api/'));
      if (isDashboard) {
        const origin = 'http://127.0.0.1:' + server.address().port;
        if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
            || (route !== ADMIN + '/ui' && req.headers['sec-fetch-site'] === 'cross-site')) {
          throw new FilterError('invalid_management_origin', '管理页面仅允许本机同源访问。', 403);
        }
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        if (assetName && req.method === 'GET' && dashboard.asset) {
          res.writeHead(200, {'content-type': assetName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'});
          res.end(dashboard.asset(assetName)); return;
        }
        if (route === ADMIN + '/favicon.svg' && req.method === 'GET') {
          res.setHeader('content-security-policy', "default-src 'none'; style-src 'none'; sandbox");
          res.writeHead(200, {'content-type': 'image/svg+xml; charset=utf-8'});
          res.end(dashboard.icon());
          return;
        }
        if (route === ADMIN + '/ui' && req.method === 'GET') {
          res.setHeader('content-security-policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
          res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
          res.end(dashboard.html(token));
          return;
        }
      }
      if (!isDashboard && (req.headers.origin || req.headers['sec-fetch-site'])) {
        throw new FilterError('browser_request_rejected', 'Browser requests are not supported.', 403);
      }
      if (route === ADMIN + '/health' && req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({service: SERVICE, filterVersion: FILTER_VERSION, pid: process.pid, stats, policy: lastPolicy, ...getState()}));
        return;
      }
      if (route.startsWith(ADMIN)) {
        const given = Buffer.from(String(req.headers['x-filter-token'] || ''));
        const expected = Buffer.from(String(token || ''));
        if (!expected.length || expected.length !== given.length || !timingSafeEqual(given, expected)) {
          throw new FilterError('invalid_control_token', 'Invalid local control token.', 403);
        }
        if (isDashboard && route.startsWith(ADMIN + '/api/')) {
          if (route === ADMIN + '/api/diagnostics' && req.method === 'GET') {
            const diagnostics = getDiagnostics ? await getDiagnostics() : await require('./diagnostics.cjs').buildReport({service: {running: true, ...getState(), filterVersion: FILTER_VERSION}, management: dashboard});
            res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
            res.end(JSON.stringify({diagnostics}));
            return;
          }
          let payload = {};
          if (req.method !== 'GET') {
            const raw = await readBody(req, 65536);
            try { payload = JSON.parse(raw.toString('utf8')); }
            catch { throw new FilterError('invalid_request_json', '请求格式无效。'); }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new FilterError('invalid_request_json', '请求格式无效。');
          }
          const data = await dashboard.handle(req.method, route.slice((ADMIN + '/api').length), payload);
          res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
          res.end(JSON.stringify({...data, filter: {filterVersion: FILTER_VERSION, pid: process.pid, stats, ...getState()}}));
          return;
        }
        if (route !== ADMIN + '/stop' || req.method !== 'POST') throw new FilterError('unknown_control_route', 'Unknown control route.', 404);
        await onStop();
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"stopping":true}');
        return;
      }
      tracked = req.method === 'POST' && /\/responses(?:\/compact)?\/?$/.test(route);
      if (tracked) requestLog('request-received');
      let body, policyInput;
      if (requestScopedPolicy && req.method === 'POST' && /\/responses(?:\/compact)?\/?$/.test(route)) {
        body = await readBody(req, limit);
        try { policyInput = JSON.parse(decodeBody(body, req.headers['content-encoding'], limit).toString('utf8')); }
        catch (error) {
          if (error.code === 'request_too_large') throw error;
          policyInput = {model: ''};
        }
        policyInput = policyInput && typeof policyInput === 'object' ? policyInput : {model: ''};
      }
      let policy;
      try { policy = await getFilterPolicy(policyInput); }
      catch { policy = {filter: false, reason: 'policy-unavailable'}; }
      const shouldFilter = policy?.filter === true;
      lastPolicy = publicPolicy(policy);
      if (tracked) requestLog('request-policy', {filter: shouldFilter, reason: policy?.reason, provider: policy?.provider});
      if (shouldFilter && /\/responses\/compact\/?$/.test(route)) {
        throw new FilterError('encrypted_compaction_disabled',
          'Encrypted Responses compaction is disabled. Use a text summary and start a new session.', 409);
      }
      const upstream = new URL(localOrigin(getUpstream()));
      if (Number(upstream.port || 80) === server.address().port) throw new FilterError('proxy_loop', 'Local gateway and filter must use different ports.', 503);
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      let isResponses = (shouldFilter || policy?.stripResponsesLiteHeader === true)
        && /\/responses\/?$/.test(route) && req.method === 'POST';
      if (isResponses) {
        const original = body ?? await readBody(req, limit);
        // Uploading can take time: never filter using a pre-upload routing decision.
        try { policy = await getFilterPolicy(policyInput); }
        catch { policy = {filter: false, reason: 'policy-unavailable'}; }
        isResponses = policy?.filter === true || policy?.stripResponsesLiteHeader === true;
        lastPolicy = publicPolicy(policy);
        if (tracked) requestLog('request-policy', {filter: policy?.filter === true, reason: policy?.reason, provider: policy?.provider});
        if (!isResponses) {
          body = original;
        } else {
          if (policy.stripResponsesLiteHeader === true && Object.hasOwn(headers, RESPONSES_LITE_HEADER)) {
            delete headers[RESPONSES_LITE_HEADER];
            stats.strippedResponsesLiteHeaders++;
            stats.lastLiteHeaderStrippedAt = new Date().toISOString();
            requestLog('lite-header-stripped', {provider: policy.provider || 'unknown'});
          }
          // Header compatibility changes neither body fields nor encoding.
          if (policy.filter !== true) {
            body = original;
          } else {
            const raw = decodeBody(original, req.headers['content-encoding'], limit);
            let input;
            try { input = JSON.parse(raw.toString('utf8')); }
            catch { throw new FilterError('invalid_request_json', 'Responses request is not valid JSON.'); }
            const filtered = filterResponsesRequest(input, {
              preserveEncryptedInclude: policy.preserveEncryptedInclude === true
            });
            stats.filteredRequests++;
            stats.removedReasoningItems += filtered.removed;
            stats.removedItemIds += filtered.removedItemIds;
            stats.removedEncryptedContentItems += filtered.removedEncryptedContentItems;
            stats.lastFilteredAt = new Date().toISOString();
            requestLog('filtered', {removed: filtered.removed, removedItemIds: filtered.removedItemIds,
              removedEncryptedContentItems: filtered.removedEncryptedContentItems,
              provider: policy.provider || 'unknown'});
            body = Buffer.from(JSON.stringify(filtered.body));
            delete headers['content-encoding'];
            delete headers.expect;
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(body.length);
          }
        }
      }
      // A downgraded CC Switch cannot resolve the newer ccs-*/model names saved
      // in old turns. Codex may still use that previous model for pre-turn
      // compaction even when the composer already selects the plain model.
      // This opt-in exact map changes only the model name, never history or routing.
      if (req.method === 'POST' && /\/responses(?:\/compact)?\/?$/.test(route)
          && getModelAliases().size > 0) {
        const original = body ?? await readBody(req, limit);
        body = original;
        let input;
        try { input = JSON.parse(decodeBody(original, headers['content-encoding'], limit).toString('utf8')); }
        catch (error) {
          // Preserve non-JSON/unknown encodings for upstream validation. Size
          // limits still apply to decompressed input.
          if (error.code === 'request_too_large') throw error;
        }
        const target = typeof input?.model === 'string' && getModelAliases().get(input.model);
        if (target) {
          const from = input.model;
          body = Buffer.from(JSON.stringify({...input, model: target}));
          delete headers['content-encoding'];
          delete headers.expect;
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(body.length);
          stats.normalizedModelAliases++;
          stats.lastModelAliasNormalizedAt = new Date().toISOString();
          requestLog('model-alias-normalized', {from, to: target});
          isResponses = true;
        }
      }
      if (res.destroyed || req.aborted) return;
      // Buffer Responses request bodies so a queued 429 can be replayed byte-for-byte;
      // the upstream rejected the request before any model work ran. Requests that
      // never match this route keep the original no-retry streaming behavior.
      if (retry429 && req.method === 'POST' && body === undefined
          && /\/responses(?:\/compact)?\/?$/.test(route)) {
        body = await readBody(req, limit);
        if (res.destroyed || req.aborted) return;
      }
      let guardContext;
      if (guard && body && req.method === 'POST' && /\/responses\/?$/.test(route)) {
        try {
          const observed = JSON.parse(decodeBody(body,headers['content-encoding'],limit).toString('utf8'));
          guard.observe?.(observed,{upstream:upstream.origin,path:req.url,headers});
        } catch {}
      }
      if (guard && guard.shouldInspect()) {
        // Unknown generation protocols cannot bypass an enabled guard.
        if (req.method === 'POST' && !/\/responses(?:\/compact)?\/?$/.test(route)) {
          throw new FilterError('guard_unverified','模型保护仅支持 Responses HTTP 请求。',409);
        }
        if (req.method === 'POST') {
          body ??= await readBody(req,limit);
          let input;
          try { input = JSON.parse(decodeBody(body,headers['content-encoding'],limit).toString('utf8')); }
          catch { throw new FilterError('guard_unverified','请求内容无法验证，已拦截。',409); }
          if (input?.stream === true) startHeartbeat();
          guardContext = await guard.prepare(input,{upstream:upstream.origin,path:req.url,headers},guardController.signal);
          if (guardContext) unwatch = guard.watch(guardContext,guardController);
          else { clearInterval(heartbeat); heartbeat = undefined; }
        }
      }
      const canRetry429 = retry429 && req.method === 'POST' && body !== undefined
        && /\/responses(?:\/compact)?\/?$/.test(route);
      stats.requests++;
      const sendUpstream = () => new Promise((resolve, reject) => {
        upstreamRequest = http.request({hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || 80,
          path: req.url, method: req.method, headers}, resolve);
        upstreamRequest.setTimeout(600000, () => upstreamRequest.destroy(new Error('upstream_timeout')));
        upstreamRequest.on('error', reject);
        if (body) upstreamRequest.end(body);
        else req.pipe(upstreamRequest);
      });
      req.on('aborted', () => upstreamRequest?.destroy());
      const retryStart = Date.now();
      let attempts = 0;
      for (;;) {
        if (guardContext) {
          guard.assertCurrent(guardContext);
          if (guardController.signal.aborted) throw new FilterError('guard_unverified','受保护请求已取消，未放行任何模型输出。',409);
        }
        attempts++;
        let upstreamResponse;
        try { upstreamResponse = await sendUpstream(); }
        catch (error) {
          if (res.destroyed) return;
          stats.upstreamErrors++;
          requestLog('upstream-error', {code: error.code || 'timeout'});
          requestError(new FilterError('ccswitch_unavailable', 'Cannot reach local gateway (CC Switch / Magpie). Start its local proxy, then retry.', 502));
          return;
        }
        if (tracked) requestLog('upstream-response', {status: upstreamResponse.statusCode});
        if (isResponses || tracked) {
          stats.lastUpstreamStatus = upstreamResponse.statusCode;
          if (upstreamResponse.statusCode >= 400) {
            stats.upstreamHttpErrors++;
            requestLog('upstream-http-error', {status: upstreamResponse.statusCode});
          }
        }
        if (upstreamResponse.statusCode !== 429 || !canRetry429 || attempts >= retry429.maxAttempts) {
          if (upstreamResponse.statusCode === 429 && canRetry429 && attempts >= retry429.maxAttempts) {
            stats.retry429Exhausted++;
            requestLog('retry-429-exhausted', {attempts});
          }
          if (res.destroyed) { upstreamResponse.destroy(); return; }
          if (guardContext && upstreamResponse.statusCode >= 300 && upstreamResponse.statusCode < 400) {
            // A client can follow Location and replay the project request to an
            // endpoint outside this proxy. Never release redirects under guard.
            upstreamResponse.destroy();
            throw new FilterError('guard_unverified','上游要求重定向到其他地址，模型保护已拦截。请在网关核对供应商地址。',409);
          }
          if (guardContext && upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300) {
            const timer = setTimeout(() => guardController.abort(),600000);
            timer.unref();
            let checked;
            try {
              checked = await collectResponse(upstreamResponse,{expectedModel:guardContext.model, expectedProvider:guardContext.gatewayProvider,
                signal:guardController.signal,budget:guard.budget,
                onMismatch:actual => guard.block(guardContext,actual)});
              guard.assertCurrent(guardContext);
            } finally { clearTimeout(timer); }
            clearInterval(heartbeat);
            if (res.destroyed) return;
            if (res.headersSent) {
              if (!checked.isSse) throw new FilterError('guard_unverified','上游响应协议与请求不一致，已拦截。',409);
            } else {
              const responseHeaders = cleanHeaders(upstreamResponse.headers);
              delete responseHeaders['content-encoding'];
              responseHeaders['content-length'] = String(checked.body.length);
              res.writeHead(upstreamResponse.statusCode,responseHeaders);
            }
            res.end(checked.body);
            return;
          }
          clearInterval(heartbeat);
          if (res.headersSent) {
            upstreamResponse.resume();
            requestError(new FilterError('guard_upstream_error','上游返回 HTTP '+upstreamResponse.statusCode+'，请求未完成。',502));
            return;
          }
          res.writeHead(upstreamResponse.statusCode, cleanHeaders(upstreamResponse.headers));
          res.flushHeaders();
          let streamErrorLogged = false;
          const streamFailed = () => {
            if (!streamErrorLogged && !res.destroyed && !guardController.signal.aborted) { streamErrorLogged = true; requestLog('upstream-stream-error'); }
            res.destroy();
          };
          upstreamResponse.on('error', streamFailed);
          upstreamResponse.on('aborted', streamFailed);
          upstreamResponse.pipe(res);
          return;
        }
        // Rejected before any model work: drain the small error body, then decide
        // whether a replay is worthwhile. Quota/credit exhaustion is permanent.
        const errorBody = await readBody(upstreamResponse, 64 * 1024).catch(() => Buffer.alloc(0));
        if (PERMANENT_429.test(errorBody.toString('utf8'))) {
          stats.retry429Permanent++;
          requestLog('retry-429-permanent', {attempts});
          if (res.destroyed) return;
          if (res.headersSent) { requestError(new FilterError('upstream_quota','上游额度不足，请检查供应商余额。',429)); return; }
          clearInterval(heartbeat);
          res.writeHead(429, {...cleanHeaders(upstreamResponse.headers), 'content-length': String(errorBody.length)});
          res.end(errorBody);
          return;
        }
        const retryAfter = Number(upstreamResponse.headers['retry-after']);
        const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        const backoff = retry429.baseDelayMs * Math.pow(2, Math.min(attempts - 1, 3));
        const delayMs = Math.max(0, Math.min(hinted || backoff, retry429.maxDelayMs));
        if (Date.now() - retryStart + delayMs > retry429.budgetMs) {
          stats.retry429Exhausted++;
          requestLog('retry-429-exhausted', {attempts, budgetMs: retry429.budgetMs});
          if (res.destroyed) return;
          if (res.headersSent) { requestError(new FilterError('upstream_rate_limit','上游限流重试耗尽，请稍后重试。',429)); return; }
          clearInterval(heartbeat);
          res.writeHead(429, {...cleanHeaders(upstreamResponse.headers), 'content-length': String(errorBody.length)});
          res.end(errorBody);
          return;
        }
        stats.retries429++;
        stats.lastRetry429At = new Date().toISOString();
        requestLog('retry-429', {attempt: attempts + 1, delayMs, elapsedMs: Date.now() - retryStart});
        await new Promise(resolve => setTimeout(resolve, delayMs));
        if (res.destroyed || req.aborted) return;
      }
    } catch (error) {
      stats.blockedRequests++;
      if (tracked) requestLog('blocked', {code: error.code || 'filter_error'});
      requestError(error instanceof FilterError || error.code?.startsWith('guard_') ? error : new FilterError('local_filter_error', 'Local filter failed to handle request.', 500));
    }
  });
  server.on('upgrade', (req, socket) => {
    const body = 'Use Responses over HTTP/SSE; WebSocket filtering is not supported.';
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: '
      + Buffer.byteLength(body) + '\r\n\r\n' + body);
  });
  server.requestTimeout = 120000;
  return server;
}

module.exports = {SERVICE, ADMIN, FILTER_VERSION, FilterError, filterResponsesRequest, localOrigin, makeProxy, decodeBody};
