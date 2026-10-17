import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fullModel = value => typeof value === 'string' && /^[^/\s]+\/.+/.test(value)
  && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith('workbench-probe/');
const time = value => typeof value === 'number' ? value : Date.parse(value);
export function routeFromUsage(rows, probes = []) {
  const sampleWindows = probes.flatMap(r => (r.rounds || []).flatMap(round => (round.samples || []).flatMap(s =>
    (s.attempts || []).map(a => ({model: r.model, start: time(a.startedAt), end: time(a.finishedAt || r.finishedAt || Date.now())})))));
  return (Array.isArray(rows) ? rows : []).filter(r => r && r.agent === 'codex' && !r.kind
    && !r.source && !r.rejected && !r.handed_on && !r.computer && !r.via
    && !(typeof r.req === 'string' && r.req.startsWith('workbench-probe/'))
    && Number.isFinite(Date.parse(r.t)) && Date.parse(r.t) <= Date.now() + 60000)
    .sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).map(r => {
      const model = typeof r.provider === 'string' && !r.provider.includes('/') && typeof r.model === 'string'
        ? r.provider + '/' + r.model : null;
      return {model, requestedModel: fullModel(r.req) ? r.req : model,
        reportedModel: typeof r.served === 'string' && r.served.length <= 200 ? r.served : null,
        effort: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(r.effort) ? r.effort : 'default',
        observedAt: r.t, source: 'request', providerName: r.provider};
    }).find(r => fullModel(r.model) && !sampleWindows.some(w => w.model === r.model
      && Date.parse(r.observedAt) >= w.start - 1000 && Date.parse(r.observedAt) <= w.end + 1000)) || null;
}
export function createCurrentModel({gateway, magpieDirectory = path.join(os.homedir(), '.config', 'magpie'), history}) {
  let cached, refreshedAt = 0, pending;
  return async () => {
    if (Date.now() - refreshedAt < 5000 && cached !== undefined) return cached;
    if (pending) return pending;
    pending = (async () => {
      let rows;
      try {
        const {url, key} = gateway();
        const response = await fetch(url + '/v1/magpie/usage/requests?period=all&agent=codex&purpose=unmarked&limit=30', {
          headers: key ? {authorization: 'Bearer ' + key} : {}, redirect: 'error', signal: AbortSignal.timeout(3000)});
        if (response.ok) rows = (await response.json()).rows;
      } catch {}
      // Older Magpie releases may lack the read-only usage endpoint. Read a
      // bounded log tail; never expose account/key/session fields to the UI.
      if (!Array.isArray(rows)) try {
        const file = path.join(magpieDirectory, 'usage.jsonl'), fd = fs.openSync(file, 'r');
        try {
          const size = fs.fstatSync(fd).size, length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, size - length);
          rows = buffer.toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        } finally { fs.closeSync(fd); }
      } catch {}
      const records = history();
      cached = routeFromUsage(rows, records);
      if (!cached) {
        const record = records.filter(r => fullModel(r.model) && Number.isFinite(time(r.startedAt)))
          .sort((a, b) => time(b.startedAt) - time(a.startedAt))[0];
        cached = record ? {model: record.model, requestedModel: record.model, effort: record.effort,
          observedAt: new Date(time(record.startedAt)).toISOString(), source: 'history'} : null;
      }
      refreshedAt = Date.now(); return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}
