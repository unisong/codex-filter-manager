/* Native plugin page: no fetch, file access, credentials or model calls. */
(async () => {
  const M = globalThis.HistorySettings;
  const $ = id => document.getElementById(id);
  const words = {
    zh: {
      subtitle: '按供应商管理旧会话历史过滤', refresh: '刷新列表', refreshing: '正在刷新…',
      introTitle: '选择需要兼容旧会话的供应商',
      intro: '开启后清理旧推理密文和可移植历史的服务器 ID。所有供应商默认关闭，普通正文和工具结果会保留。',
      scope: '只用历史过滤，在本页设置即可；运行情况可到 Magpie 扩展／插件页面查看，无需登录或打开独立工作台。需要模型监测与保护时，再打开桌面“Magpie 模型工作台”（无需账号登录）。本页不修改 Codex 接入地址。',
      searchLabel: '搜索供应商', search: '搜索供应商名称或 ID', viewLabel: '显示范围',
      all: '全部供应商', enabled: '已开启过滤', configured: '已有规则', provider: '供应商',
      filter: '历史过滤', include: '保留新响应密文', on: '开启', off: '关闭', inactive: '未生效',
      helpTitle: '两个开关有什么区别？',
      helpFilter: '历史过滤：清理请求中旧 reasoning、明确标记的加密内容和可移植条目的服务器 ID，缓解切换供应商后的历史验证错误。',
      helpInclude: '保留新响应密文：保留客户端对新响应 reasoning.encrypted_content 的请求，建议开启。不会保留旧历史中的密文；只有开启历史过滤时才生效。',
      helpAliases: '已有别名会继续生效，列表会显示实际使用的规则。未出现在当前列表中的已存规则会保留。自动路由组和 fallback 可能改变最终上游，规则按进入钩子时的模型前缀匹配。',
      helpRuntime: '保存成功表示设置已写入；插件是否在运行，请到 Magpie 插件页查看启用状态、调用数和错误。页面不能读取运行中钩子的统计。',
      discard: '撤销修改', save: '保存更改', saving: '正在保存…', saveHint: '保存后用于后续请求，无需重启 Codex。',
      connecting: '正在连接 Magpie…', loading: '正在读取供应商与规则…', ready: '已读取规则，可按供应商修改。',
      refreshed: '列表已刷新。', refreshedDirty: '供应商列表已刷新，未保存的修改仍保留。',
      saved: '规则已保存。后续请求使用新设置；运行状态请查看 Magpie 插件页。',
      changed: '修改尚未保存，点击“保存更改”后生效。', discarded: '已撤销本页尚未保存的修改。',
      unlisted: '未在当前供应商列表中，已存规则仍保留', alias: '使用规则：',
      empty: '没有符合筛选条件的供应商。', noProviders: 'Magpie 尚未返回供应商。添加供应商后点击刷新列表。',
      noBridge: '请从 Magpie 侧边栏的 Codex Workbench · 历史过滤 标签页打开。旧版 Magpie 请先更新以支持插件页面。',
      invalid_options: '现有 Options 格式有误。为避免覆盖，未载入或保存；请先在 Magpie 插件 Options 中修正规则的对象与布尔值格式。',
      invalid_providers: 'Magpie 返回的供应商列表格式异常，未修改任何设置。',
      options_conflict: '其他窗口修改了相同规则或别名，本次未覆盖。请撤销本页修改、刷新列表后重试。',
      timeout: '未确认操作结果，请稍后刷新列表核对；未自动重试保存。',
      failed: '操作未完成：', retry: '。可点击刷新列表重试。', clean: '没有未保存的修改',
      dirty: n => `${n} 个供应商规则待保存`, count: (shown, n, on) => `显示 ${shown} / ${n} 个供应商 · ${on} 个开启`,
    },
    en: {
      subtitle: 'Manage history compatibility for each provider', refresh: 'Refresh list', refreshing: 'Refreshing…',
      introTitle: 'Choose providers that need history compatibility',
      intro: 'Removes old reasoning ciphertext and optional server IDs from portable history. Every provider defaults to off. Readable messages and tool results are preserved.',
      scope: 'For history filtering only, configure it here and check runtime status in Magpie Extensions / Plugins. No workbench or sign-in is needed. Open the desktop workbench only for optional model monitoring and protection; it also requires no account login. This page never edits the Codex endpoint.',
      searchLabel: 'Search providers', search: 'Search provider name or ID', viewLabel: 'Show providers',
      all: 'All providers', enabled: 'Filtering enabled', configured: 'With saved rules', provider: 'Provider',
      filter: 'History filter', include: 'Keep new ciphertext', on: 'On', off: 'Off', inactive: 'Inactive',
      helpTitle: 'What do the two switches do?',
      helpFilter: 'History filter: removes old reasoning, explicitly typed encrypted content and optional server IDs from portable items to reduce history verification errors after switching providers.',
      helpInclude: 'Keep new ciphertext: preserves the client’s request for reasoning.encrypted_content in NEW responses (recommended). Old ciphertext is still removed. Only applies while history filtering is on.',
      helpAliases: 'Existing aliases remain active; each row shows the rule it uses. Saved rules missing from the current provider list are retained. Groups and fallback may change the final upstream; matching uses the model prefix when the hook runs.',
      helpRuntime: 'Saved means the options were written. Check the Magpie Plugins page for enabled state, calls and errors. This page cannot read live hook statistics.',
      discard: 'Discard changes', save: 'Save changes', saving: 'Saving…', saveHint: 'Applies to subsequent requests. No Codex restart needed.',
      connecting: 'Connecting to Magpie…', loading: 'Reading providers and rules…', ready: 'Rules loaded. Choose a provider to edit.',
      refreshed: 'List refreshed.', refreshedDirty: 'Provider list refreshed; unsaved changes retained.',
      saved: 'Rules saved for subsequent requests. Check the Magpie Plugins page for runtime status.',
      changed: 'Unsaved changes. Use Save changes to apply them.', discarded: 'Unsaved changes discarded.',
      unlisted: 'Not in the current provider list; saved rule retained', alias: 'Uses rule: ',
      empty: 'No providers match this filter.', noProviders: 'Magpie returned no providers. Add one, then refresh.',
      noBridge: 'Open Codex Workbench · History from the Magpie sidebar. Update older Magpie versions to support plugin pages.',
      invalid_options: 'Invalid existing Options. Nothing loaded or saved. Fix the rule objects and boolean values in Magpie’s plugin Options first.',
      invalid_providers: 'Magpie returned an invalid provider list. No settings changed.',
      options_conflict: 'Another window changed the same rule or aliases. Nothing overwritten. Discard local changes, refresh, then retry.',
      timeout: 'Operation not confirmed. Refresh later to verify; saving was not automatically retried.',
      failed: 'Operation incomplete: ', retry: '. Refresh the list to retry.', clean: 'No unsaved changes',
      dirty: n => `${n} provider rule(s) to save`, count: (shown, n, on) => `${shown} / ${n} providers · ${on} enabled`,
    },
  };
  let lang = 'zh', base = {}, draft = {}, providers = [], loaded = false, busy = false, cooling = false;
  let status = {key: 'connecting', kind: ''};
  const text = () => words[lang];
  const dirty = () => M.differences(base, draft);
  function message(key, kind = '', detail = '') {
    status = {key, kind, detail};
    $('notice').textContent = (text()[key] || key) + detail;
    $('notice').dataset.kind = kind;
  }
  function error(e) {
    const key = Object.hasOwn(text(), e.message) ? e.message : 'failed';
    message(key, 'error', key === 'failed' ? String(e.message || e) + text().retry : '');
  }
  async function timed(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  function labels() {
    document.querySelectorAll('[data-t]').forEach(e => { e.textContent = text()[e.dataset.t]; });
    $('search').placeholder = text().search;
    $('providers').setAttribute('aria-label', text().provider);
    message(status.key, status.kind, status.detail);
  }
  function node(tag, cls, value) {
    const e = document.createElement(tag);
    e.className = cls;
    if (value !== undefined) e.textContent = value;
    return e;
  }
  function toggle(row, field) {
    const label = node('label', 'toggle');
    label.append(node('span', 'mobile-label', text()[field === 'historyFilter' ? 'filter' : 'include']));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.dataset.id = row.id;
    input.dataset.field = field;
    input.dataset.target = row.target;
    input.checked = field === 'historyFilter' ? row.on : row.include;
    input.disabled = busy || (field !== 'historyFilter' && !row.on);
    input.setAttribute('aria-label', row.name + ': ' + text()[field === 'historyFilter' ? 'filter' : 'include']);
    label.append(input, node('span', '', field !== 'historyFilter' && !row.on ? text().inactive : input.checked ? text().on : text().off));
    return label;
  }
  function paint() {
    const changes = dirty(), hasChanges = changes.length > 0;
    $('refresh').disabled = busy;
    $('refresh').textContent = text()[busy && status.key === 'loading' ? 'refreshing' : 'refresh'];
    $('search').disabled = !loaded;
    $('scope').disabled = !loaded;
    $('save').disabled = busy || cooling || !loaded || !hasChanges;
    $('save').textContent = text()[busy && status.key === 'saving' ? 'saving' : 'save'];
    $('discard').disabled = busy || !hasChanges;
    $('saveState').textContent = hasChanges ? text().dirty(new Set(changes.map(c => c.id)).size) : text().clean;
    if (!loaded) return;
    const all = M.rows(draft, providers), query = $('search').value.trim().toLocaleLowerCase();
    const shown = all.filter(p => (!$('scope').value || $('scope').value === 'all' || ($('scope').value === 'on' ? p.on : p.configured))
      && (!query || [p.name, p.id, p.target].some(v => v.toLocaleLowerCase().includes(query))));
    $('count').textContent = text().count(shown.length, all.length, all.filter(p => p.on).length);
    $('providers').replaceChildren(...shown.map(row => {
      const card = node('div', 'provider');
      const identity = node('div', 'identity');
      identity.append(node('div', 'name', row.name), node('div', 'id', row.id));
      if (!row.listed || row.target !== row.id) {
        const tags = node('div', 'tags');
        if (!row.listed) tags.append(node('span', 'badge', text().unlisted));
        if (row.target !== row.id) tags.append(node('span', '', text().alias + row.target));
        identity.append(tags);
      }
      card.append(identity, toggle(row, 'historyFilter'), toggle(row, 'preserveEncryptedInclude'));
      return card;
    }));
    $('empty').hidden = shown.length !== 0;
    $('empty').textContent = all.length ? text().empty : text().noProviders;
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    message('loading');
    paint();
    try {
      const hasChanges = dirty().length > 0;
      const [list, opts] = await timed(Promise.all([magpie.read('providers:list'), hasChanges ? Promise.resolve(null) : magpie.options.get()]));
      M.rows(opts || draft, list); // validate before replacing displayed state
      providers = list;
      if (!hasChanges) base = draft = M.validate(opts);
      const wasLoaded = loaded;
      loaded = true;
      message(hasChanges ? 'refreshedDirty' : wasLoaded ? 'refreshed' : 'ready', 'success');
    } catch (e) { error(e); }
    finally { busy = false; paint(); }
  }
  $('refresh').onclick = () => refresh();
  $('search').oninput = paint;
  $('scope').onchange = paint;
  $('providers').onchange = e => {
    const input = e.target;
    if (input.tagName !== 'INPUT' || busy || !loaded) return;
    draft = M.change(draft, input.dataset.target, input.dataset.field, input.checked);
    message(dirty().length ? 'changed' : 'ready');
    const {id, field} = input.dataset;
    paint();
    [...$('providers').querySelectorAll('input')].find(i => i.dataset.id === id && i.dataset.field === field)?.focus();
  };
  $('discard').onclick = () => { draft = base; message('discarded'); paint(); };
  $('save').onclick = async () => {
    if (busy || cooling || !loaded || !dirty().length) return;
    busy = true;
    message('saving');
    paint();
    try {
      const latest = await timed(magpie.options.get());
      const merged = M.merge(base, draft, latest);
      const saved = await timed(magpie.options.set(merged));
      base = draft = M.validate(saved);
      message('saved', 'success');
    } catch (e) { error(e); }
    finally {
      busy = false;
      // Magpie allows options.set at most once a second. Keep further edits
      // available, but don't issue a second write inside that window.
      cooling = true;
      setTimeout(() => { cooling = false; paint(); }, 1100);
      paint();
    }
  };
  try {
    if (!globalThis.magpie) throw new Error('noBridge');
    const theme = await timed(magpie.ready);
    const language = t => {
      lang = /^zh/i.test(t.lang || '') ? 'zh' : 'en';
      labels();
      paint();
    };
    language(theme);
    magpie.onTheme(language);
    await refresh();
  } catch (e) { error(e); $('refresh').disabled = true; }
})();
