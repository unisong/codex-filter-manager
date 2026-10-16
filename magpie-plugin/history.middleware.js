import {filterResponsesRequest, FilterError} from './history-filter.mjs';

export function onRequest(body, ctx) {
  if (ctx.protocol !== 'responses' || !body || typeof body.model !== 'string' || !/^[^/]+\/.+/.test(body.model)) return;
  const prefix = body.model.split('/')[0];
  const options = ctx.options || {};
  const aliases = options.aliases || {};
  const id = Object.prototype.hasOwnProperty.call(aliases, prefix) ? aliases[prefix] : prefix;
  const rules = options.providers || {};
  const rule = rules['magpie:' + id];
  if (!Object.prototype.hasOwnProperty.call(rules, 'magpie:' + id) || rule?.historyFilter !== true) return;
  try {
    if (/\/compact\/?$/.test(ctx.path || '')) {
      ctx.reject(409, 'Codex history filter: encrypted compaction cannot cross resources. Use a text summary and a new session.');
      return;
    }
    return filterResponsesRequest(body, {preserveEncryptedInclude: rule.preserveEncryptedInclude === true}).body;
  } catch (error) {
    // Explicit rejection is required: Magpie forwards the original request if
    // a hook throws. Never silently discard non-portable context references.
    ctx.reject(error instanceof FilterError ? error.status : 409,
      'Codex history filter: ' + (error instanceof FilterError ? error.message : 'history could not be safely filtered.'));
  }
}
