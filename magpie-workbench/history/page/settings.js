// Pure settings operations. The page uses only Magpie's documented bridge;
// the request hook remains independent of this UI.
(() => {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const fields = ['historyFilter', 'preserveEncryptedInclude'];
  function validate(opts) {
    if (!object(opts) || (opts.providers !== undefined && !object(opts.providers))
        || (opts.aliases !== undefined && !object(opts.aliases))) throw new Error('invalid_options');
    for (const [key, rule] of Object.entries(opts.providers || {})) {
      if (!key.startsWith('magpie:')) continue;
      if (!object(rule) || fields.some(f => own(rule, f) && typeof rule[f] !== 'boolean')) throw new Error('invalid_options');
    }
    if (Object.values(opts.aliases || {}).some(id => typeof id !== 'string' || !id || id.includes('/'))) throw new Error('invalid_options');
    return opts;
  }
  const target = (opts, id) => own(opts.aliases || {}, id) ? opts.aliases[id] : id;
  const ruleAt = (opts, id) => opts.providers?.['magpie:' + id];
  const valueAt = (opts, id, field) => ruleAt(opts, id)?.[field];
  function rows(opts, providers) {
    validate(opts);
    if (!Array.isArray(providers) || providers.some(p => !object(p) || typeof p.id !== 'string' || !p.id
        || p.id.includes('/') || typeof p.name !== 'string')) throw new Error('invalid_providers');
    const list = new Map(providers.filter(p => p.hidden !== true).map(p => [p.id, {...p, listed: true}]));
    for (const key of Object.keys(opts.providers || {})) {
      if (key.startsWith('magpie:') && key.length > 7 && !list.has(key.slice(7))) {
        const id = key.slice(7);
        list.set(id, {id, name: id, listed: false});
      }
    }
    return [...list.values()].map(p => {
      const id = target(opts, p.id), rule = ruleAt(opts, id);
      return {...p, target: id, configured: !!rule, on: rule?.historyFilter === true,
        include: rule ? rule.preserveEncryptedInclude === true : true};
    }).sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  function view(base, draft, providers, {enabledOnly = false, query = ''} = {}) {
    // Membership and order follow saved rules until saving succeeds. Switches
    // still display the draft, so turning one off never moves it mid-edit.
    const saved = rows(base, providers), edited = new Map(rows(draft, providers).map(row => [row.id, row]));
    const search = query.trim().toLocaleLowerCase();
    const shown = saved.filter(row => (!enabledOnly || row.on)
      && (!search || [row.name, row.id, row.target].some(value => value.toLocaleLowerCase().includes(search))))
      .map(row => edited.get(row.id));
    return {rows: shown, total: saved.length, enabled: saved.filter(row => row.on).length,
      narrowed: enabledOnly || !!search};
  }
  function change(opts, id, field, value) {
    if (!fields.includes(field) || typeof value !== 'boolean') throw new Error('invalid_change');
    const rule = ruleAt(opts, id) || {historyFilter: false, preserveEncryptedInclude: true};
    return {...opts, providers: {...opts.providers, ['magpie:' + id]: {...rule, [field]: value}}};
  }
  function differences(base, draft) {
    const changes = [];
    for (const key of Object.keys(draft.providers || {})) {
      if (!key.startsWith('magpie:')) continue;
      const id = key.slice(7);
      for (const field of fields) {
        const value = valueAt(draft, id, field);
        if (value !== valueAt(base, id, field)) changes.push({id, field, value});
      }
    }
    return changes;
  }
  function merge(base, draft, latest) {
    validate(latest);
    // Never replace Options with a stale full snapshot. Preserve unrelated
    // edits, and require a reload if the same switch or alias changed elsewhere.
    const edits = differences(base, draft);
    if (edits.length && JSON.stringify(base.aliases || {}) !== JSON.stringify(latest.aliases || {})) throw new Error('options_conflict');
    let result = latest;
    for (const {id, field, value} of edits) {
      const now = valueAt(latest, id, field);
      if (now !== valueAt(base, id, field) && now !== value) throw new Error('options_conflict');
      // Unlike change(), do not add defaults for fields the user didn't edit.
      result = {...result, providers: {...result.providers,
        ['magpie:' + id]: {...ruleAt(result, id), [field]: value}}};
    }
    return result;
  }
  globalThis.HistorySettings = {validate, rows, view, change, differences, merge};
})();
