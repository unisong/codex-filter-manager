(() => {
  const $ = id => document.getElementById(id);
  let state = null, models = [], page = 1, editing = null, detailId = null, detail = null, updating = null, manualModel = null;
  const pageMeta = {
    filters: ['历史过滤', '按供应商管理旧会话兼容规则，与模型保护分别控制。'],
    targets: ['模型监测', '自动识别最近实际路由，确认检测目标、保护模式与当前结果。'],
    history: ['检测记录', '查看每轮取样结果与独立复测证据，最多保留最近 100 轮。'],
    settings: ['设置与诊断', '只连接本机 Magpie，查看运行状态并导出脱敏诊断。']
  };
  let activeView = 'filters';
  const H = globalThis.HistorySettings;
  let filterBase = null, filterDraft = null, filterProviders = [], filterBusy = false, filterEnabled = true, filterEnabledOnly = false;
  let scheduleBusy = false, connected = false;
  const scheduled = t => t && t.mode !== 'manual' && t.scheduleEnabled !== false;
  const nextCheck = t => '下次 ' + date(t.nextAt);
  function renderMonitoring() {
    const enabled = state.targets.filter(scheduled), running = state.targets.filter(t => t.running), stopping = running.filter(t => t.stopping);
    $('monitoringControl').hidden = (activeView !== 'targets' && activeView !== 'history') || (!enabled.length && !running.length && !stopping.length);
    $('monitoringControl').dataset.status = !connected || state.health ? 'unknown' : stopping.length ? 'stopping' : running.length ? 'running' : enabled.length ? 'active' : 'idle';
    $('monitoringStatus').textContent = !connected ? '连接中断 · 检测状态未确认' : state.health ? '检测服务异常 · 暂停新增取样'
      : stopping.length ? '正在取消本轮检测' : enabled.length ? '定期检测已开启 · ' + enabled.length + ' 个模型' : '定期检测已停止';
    const next = enabled.filter(t => !t.running).sort((a, b) => a.nextAt - b.nextAt)[0];
    $('monitoringDetail').textContent = !connected ? '无法确认后台是否仍在检测，请重新连接后停止。'
      : state.health ? state.health : [running.length ? '检测中 ' + running.length + ' 项' : '', next?.nextAt ? nextCheck(next) : '',
        enabled.length ? '任务结束后点右侧停止；不会自动随 Codex 任务结束停止。' : '不会自动取样；已有模型暂停与过滤规则保留。'].filter(Boolean).join(' · ');
    $('stopAllChecks').disabled = scheduleBusy || !connected || !!state.health || (!enabled.length && !running.some(t => !t.stopping));
    $('stopAllChecks').textContent = scheduleBusy ? '正在停止…' : '停止全部检测';
  }
  async function controlSchedule(t, op = scheduled(t) ? 'stop' : 'start') {
    if (scheduleBusy) return;
    if ((op === 'start' && !t) || t === undefined) { notice('检测目标不存在，请刷新后重试。', 'error'); return; }
    if (op === 'start' && !await confirm('恢复定期检测？', `将按原设置每 ${t.intervalMinutes} 分钟检测 ${t.model}，消耗上游额度；从一个完整间隔后开始，不立即取样。${t.mode === 'protect' ? '强偏离时仍按原规则暂停模型请求。' : ''}`)) return;
    scheduleBusy = true; renderMonitoring();
    try {
      await api('schedule', {...(t ? {id: t.id} : {}), action: op});
      notice(op === 'start' ? '定期检测已恢复，从下一个间隔开始。' : '定期检测已停止；正在进行的本轮已请求取消。已有模型暂停和过滤规则保留。', 'success');
      if (updating) await updating;
      await refresh();
    } catch (e) { notice(e.message, 'error'); }
    finally { scheduleBusy = false; renderMonitoring(); renderCurrentModel(); targets(); }
  }
  async function cancelRound(t) {
    await api('action', {id: t.id, action: 'cancel'});
    notice('已请求取消本轮。' + (scheduled(t) ? '定期检测仍开启；要同时停止后续排期，请点击「停止定期检测」。' : '不会自动开始下一轮。'));
    if (updating) await updating;
    await refresh();
  }
  $('stopAllChecks').onclick = () => controlSchedule(null, 'stop');
  $('currentSchedule').onclick = () => { const t = selectedTarget(currentSelection()); if (t) return controlSchedule(t); };
  const currentSelection = () => WorkbenchSelection({current: state?.currentModel, history: state?.history || []})
    || (manualModel ? {...manualModel, source: 'manual'} : null);
  const referenceFor = model => state.candidates.includes(model?.slice(model.indexOf('/') + 1)) ? model.slice(model.indexOf('/') + 1) : '';
  function renderCurrentModel() {
    const selected = currentSelection(), saved = selectedTarget(selected);
    const last = state.history.find(r => r.model === selected?.model && (!saved || r.effort === saved.effort));
    $('currentModel').textContent = selected?.model || '暂无实际请求或历史记录';
    $('currentModelSource').textContent = selected ? selected.source === 'manual' ? '来源：本页手动选择，尚无实际请求或检测记录。'
      : (selected.source === 'request' ? '来源：Magpie 最近实际路由' : '来源：最近检测记录')
      + ' · ' + date(Date.parse(selected.observedAt) || selected.startedAt) + '；不代表当前前台会话。' : '发送一次 Codex 请求后会自动显示，或在本页手动选择。';
    $('currentModelRoute').textContent = selected?.requestedModel && selected.requestedModel !== selected.model ? '请求入口：' + selected.requestedModel : '';
    $('currentResult').textContent = saved?.running ? '检测中' : last ? statuses[last.status] : '尚无检测记录';
    $('currentResult').className = 'wb-result ' + (saved?.running ? 'running' : last?.status || '');
    $('currentResultDetail').textContent = last ? last.reason || date(last.finishedAt) : '点击检测一次，无需先浏览全部供应商。';
    $('currentProtection').textContent = saved?.paused && saved.mode === 'protect' ? (saved.allowUntil > Date.now() ? '模型请求限时放行中' : '模型后续请求已暂停') : saved?.mode === 'protect' ? '模型异常暂停保护已配置' : '不自动暂停模型请求';
    $('currentCheck').textContent = saved?.stopping ? '正在取消…' : saved?.running ? '取消本轮' : '检测一次';
    $('currentCheck').disabled = !connected || !selected || !(saved?.expected || referenceFor(selected.model)) || !!saved?.stopping || !!state.health;
    $('currentSchedule').hidden = !saved || saved.mode === 'manual';
    $('currentSchedule').textContent = scheduled(saved) ? '停止定期检测' : '恢复定期检测';
    $('currentSchedule').disabled = scheduleBusy || !connected || !!saved?.stopping || !!state.health;
    $('currentSelectionNote').textContent = selected && !(saved?.expected || referenceFor(selected.model)) ? '此模型没有同名参考，请调整监测并明确选择参考候选。'
      : saved ? '检测设置：期望 ' + saved.expected + ' · 推理 ' + saved.effort + '。不修改 Codex 模型或供应商。' : '不修改 Codex 模型或供应商。';
    $('add').textContent = selected ? '调整监测' : '手动选择模型';
    $('targetEmpty').hidden = state.targets.length !== 0 || !$('targetDialog').hidden;
  }
  const statuses = {matched: '指纹与目标相符', suspect: '疑似偏离 / 样本分歧', deviated: '重复检测支持偏离',
    incomplete: '检测未完成', cancelled: '已取消', running: '检测中', difference: '强偏离，待复测'};
  const modes = {manual: '手动检测', observe: '定期观测', protect: '异常暂停'};
  function selectedTarget(selected) {
    return state.targets.find(t => t.model === selected?.model && t.effort === (selected?.effort || 'default'))
      || state.targets.find(t => t.model === selected?.model);
  }
  let noticeTimer;
  function notice(text, kind = '') {
    clearTimeout(noticeTimer); $('toast').textContent = text; $('toast').dataset.kind = kind;
    if (kind !== 'error') noticeTimer = setTimeout(() => { $('toast').textContent = ''; }, 7000);
  }
  function el(tag, cls = '', text) { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function badge(status, text) { return el('span', 'badge ' + (status || ''), text || statuses[status] || '未检测'); }
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : '尚未检测';
  async function api(path, body) {
    const r = await fetch('/api/' + path, {method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const value = await r.json();
    if (!r.ok) throw Error((typeof value.error === 'string' ? value.error : value.error?.message) || '操作未完成');
    return value;
  }
  function button(text, action, cls = '') {
    const b = el('button', cls, text);
    b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { notice(e.message, 'error'); } finally { b.disabled = false; } };
    return b;
  }
  async function confirm(title, text) {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text;
    const d = $('confirmDialog'); d.returnValue = ''; d.showModal();
    return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), {once: true}));
  }
  function recordsFor(id) { return state.history.filter(r => r.targetId === id); }
  function targets() {
    const query = $('targetSearch').value.toLowerCase();
    const list = state.targets.filter(t => (t.model + ' ' + t.expected).toLowerCase().includes(query));
    $('targetCount').textContent = state.targets.length;
    $('targetEmpty').hidden = state.targets.length !== 0 || !$('targetDialog').hidden;
    $('targetList').replaceChildren(...list.map(t => {
      const card = el('article', 'target'); card.dataset.id = t.id;
      const left = el('div'); left.append(el('div', 'model', t.model), el('div', 'sub', '期望 ' + t.expected + ' · 推理 ' + t.effort));
       const meta = el('div', 'meta'); meta.append(el('span', '', modes[t.mode] + (t.mode === 'manual' ? '' : ' · 每 ' + t.intervalMinutes + ' 分钟')),
        el('span', '', date(t.lastChecked)));
      if (t.stale && t.lastChecked) meta.append(badge('', '结果已过期'));
      if (t.routeChanged) meta.append(badge('suspect', '路由配置已变化'));
      left.append(meta);
       const scheduleState = el('div', 'schedule-state');
       scheduleState.append(badge(t.stopping ? 'suspect' : scheduled(t) ? 'matched' : '', t.stopping ? '本轮取消中'
         : t.mode === 'manual' ? '仅手动检测' : scheduled(t) ? '定期检测已开启' : '定期检测已停止'));
       if (scheduled(t)) scheduleState.append(el('small', 'muted', t.running ? '本轮结束后开始计算下个间隔' : nextCheck(t)));
       left.append(scheduleState);
      if (t.paused) left.append(el('p', 'sub', t.pauseReason || '已暂停'));
      const right = el('div', 'right'), tags = el('div', 'actions');
      const last = recordsFor(t.id)[0];
      tags.append(badge(t.running ? 'running' : (last?.status || t.lastResult)));
      if (t.paused && t.mode === 'protect') tags.append(badge(t.allowUntil > Date.now() ? 'suspect' : 'paused', t.allowUntil > Date.now() ? '限时放行中' : '后续请求已暂停'));
      right.append(tags);
      const actions = el('div', 'actions');
       const check = button(t.stopping ? '正在取消…' : t.running ? '取消本轮' : '检测一次', async () => {
         if (t.running) { await cancelRound(t); return; }
        else if (await confirm('运行三样本检测？', '将向 ' + t.model + ' 发送 3 次独立请求。强偏离时再复测 3 次，整轮最多额外重试 3 次。可能消耗上游额度，不发送项目对话。')) {
          await api('check', {id: t.id}); notice('检测已开始，进度自动更新；刷新页面不会重复启动。');
        }
        await refresh();
       }, t.running ? '' : 'primary');
       check.disabled = !!t.stopping || !connected || !!state.health; actions.append(check);
       if (t.mode !== 'manual') {
         const toggle = button(scheduled(t) ? '停止定期检测' : '恢复定期检测', () => controlSchedule(t));
         toggle.disabled = scheduleBusy || !!t.stopping || !connected || !!state.health; actions.append(toggle);
       }
      if (last) actions.append(button('详情', () => showDetail(last.id)));
      actions.append(button('设置', () => editTarget(t)));
      if (t.mode === 'protect') {
         actions.append(button(t.paused ? '解除模型暂停' : '暂停模型请求', async () => {
          const op = t.paused ? 'resume' : 'pause';
          if (await confirm(t.paused ? '解除此模型的暂停？' : '暂停此模型？', t.paused ? '后续请求将恢复；保留检测异常记录，不改变历史过滤。' : '此完整模型的后续请求将被拦截，其他模型不受影响。')) {
            await api('action', {id: t.id, action: op}); await refresh();
          }
        }, 'danger'));
        if (t.paused) actions.append(button('放行 15 分钟', async () => {
          if (await confirm('限时放行 15 分钟？', '允许此模型的后续请求，期满后恢复暂停。新发现的强偏离可以提前结束放行。')) {
            await api('action', {id: t.id, action: 'allow'}); await refresh();
          }
        }));
      }
      right.append(actions); card.append(left, right); return card;
    }));
  }
  function history() {
    const list = state.history.filter(r => r.model.toLowerCase().includes($('historySearch').value.toLowerCase())
      && (!$('historyStatus').value || r.status === $('historyStatus').value));
    const pages = Math.max(1, Math.ceil(list.length / 10)); page = Math.min(page, pages);
    $('historyRows').replaceChildren(...list.slice((page - 1) * 10, page * 10).map(r => {
      const tr = el('tr'), name = el('td'); name.append(el('span', '', r.model), el('small', '', '期望 ' + r.expected));
      const result = el('td'); result.append(badge(r.status));
      const when = el('td', '', date(r.startedAt));
      const samples = el('td', '', r.rounds.reduce((n, x) => n + x.samples.length, 0) + ' 份');
      const act = el('td'); act.append(button('查看', () => showDetail(r.id)));
       if (r.status === 'running') act.append(button('停止此目标检测', () => controlSchedule(state.targets.find(t => t.id === r.targetId), 'stop')));
      tr.append(name, result, when, samples, act); return tr;
    }));
    if (!list.length) { const tr = el('tr'), td = el('td', 'muted', '暂无符合条件的检测记录'); td.colSpan = 5; tr.append(td); $('historyRows').append(tr); }
    $('pageInfo').textContent = `第 ${page} / ${pages} 页 · ${list.length} 条`;
    $('prev').disabled = page <= 1; $('next').disabled = page >= pages;
  }
  function settings() {
    // Polling never replaces a user's unsaved connection or budget edits.
    if (!document.activeElement.closest('#connectionForm') && !$('connectionForm').dataset.dirty) $('gatewayUrl').value = state.connection.url;
    if (!document.activeElement.closest('#budgetForm') && !$('budgetForm').dataset.dirty) $('dailyLimit').value = state.daily.limit;
    $('connectionStatus').textContent = state.connection.hasKey ? '已保存网关 Key，页面不会回显。' : '未保存网关 Key，使用本机网关默认访问方式。';
    $('budgetUsed').textContent = '今日已发出 ' + state.daily.used + ' / ' + state.daily.limit + ' 次（UTC ' + state.daily.day + '）';
    $('health').replaceChildren(badge(state.health ? 'deviated' : 'matched', state.health || '后台运行正常'),
      el('p', 'muted', '历史过滤与模型检测包含在同一插件中，规则分别控制；不修改 Codex 配置。'));
    $('bankVersion').textContent = '参考库提交 ' + state.bankVersion.slice(0, 12);
  }
  async function refresh(loadModels = false) {
    if (updating) {
      await updating;
      if (!loadModels) return;
    }
    updating = (async () => { try {
       state = await api('state'); connected = true;
       $('workbenchVersion').textContent = 'v' + state.version;
       $('refresh').textContent = activeView === 'filters' ? '同步供应商' : activeView === 'history' ? '刷新记录'
         : activeView === 'settings' ? '重新检查' : '刷新状态';
       targets(); history(); settings(); renderMonitoring(); renderCurrentModel();
      if (loadModels) models = (await api('models')).models;
      if (activeView === 'targets' && !currentSelection() && !$('targetDialog').dataset.offered && $('targetDialog').hidden) {
        $('targetDialog').dataset.offered = '1'; await editTarget();
      }
      if (detailId && $('detailDialog').open) {
        const record = state.history.find(r => r.id === detailId);
        // Avoid replacing selected text or an expanded sample on each poll.
        if (record?.status !== detail?.status || record?.rounds.reduce((n, r) => n + r.samples.length, 0) !== detail?.rounds.reduce((n, r) => n + r.samples.length, 0)) {
          detail = await api('records/' + detailId); renderDetail();
        }
      }
     } catch (e) { connected = false; if (state) { renderMonitoring(); renderCurrentModel(); targets(); } throw e; }
     finally { updating = null; } })();
    return updating;
  }
  function modelOptions() {
    const query = $('modelSearch').value.toLowerCase(), selected = $('model').value || editing?.model;
    const list = models.filter(m => m.toLowerCase().includes(query));
    $('model').replaceChildren(...list.map(m => { const o = el('option', '', m); o.value = m; return o; }));
    if (list.includes(selected)) $('model').value = selected;
  }
  function syncInterval() {
    const custom = $('interval').value === 'custom';
    $('customIntervalField').hidden = !custom;
    $('customInterval').disabled = !custom;
    $('customInterval').required = custom;
  }
  $('interval').onchange = syncInterval;
  async function editTarget(t = null) {
    $('removeTarget')?.remove();
    editing = t; $('targetForm').reset(); syncInterval(); $('targetError').textContent = '';
     $('scheduleSettingNote').textContent = t && t.mode !== 'manual' && !scheduled(t) ? '此目标的定期检测已停止。保存设置不会恢复排期；需要时在模型卡片点击「恢复定期检测」。已有模型暂停保留。'
       : '定期模式在 Magpie 空闲时也会取样，不随 Codex 任务结束自动停止；任务完成后可点击顶部「停止全部检测」。停止保留模式与保护状态，恢复入口在模型卡片上。';
    $('dialogTitle').textContent = t ? '编辑监测模型' : '添加监测模型';
    $('targetDialog').hidden = false; $('model').disabled = true;
    try {
      if (!models.length) models = (await api('models')).models;
      modelOptions(); $('model').disabled = false;
      $('expected').replaceChildren(el('option', '', '请选择，需明确确认'), ...state.candidates.map(id => { const o = el('option', '', id); o.value = id; return o; }));
      $('expected').firstChild.value = '';
      if (t) {
        if (!models.includes(t.model)) { const o = el('option', '', t.model + '（当前列表中缺失）'); o.value = t.model; $('model').append(o); }
        $('model').value = t.model; $('expected').value = t.expected; $('effort').value = t.effort;
        const preset = [...$('interval').options].some(option => option.value === String(t.intervalMinutes));
        $('interval').value = preset ? String(t.intervalMinutes) : 'custom';
        $('customInterval').value = t.intervalMinutes; syncInterval();
        $('targetForm').querySelector('[name=mode][value=' + t.mode + ']').checked = true;
      } else {
        const selected = currentSelection();
        if (selected?.model && models.includes(selected.model)) $('model').value = selected.model;
        $('expected').value = referenceFor($('model').value);
        if (selected?.effort && [...$('effort').options].some(o => o.value === selected.effort)) $('effort').value = selected.effort;
      }
      if (!models.length) $('targetError').textContent = '网关没有返回模型。请检查 Magpie 供应商配置。';
      if (t) {
        const remove = button('删除目标', async () => {
          if (await confirm('删除监测目标？', '解除此目标的暂停，保留已有检测记录，不影响历史过滤。')) {
            await api('action', {id: t.id, action: 'delete'}); closeTarget(); await refresh();
          }
        }, 'danger'); remove.id = 'removeTarget'; $('targetForm').append(remove);
      }
    } catch (e) { $('targetError').textContent = e.message; }
  }
  function closeTarget() { $('targetDialog').hidden = true; $('removeTarget')?.remove(); if (state) renderCurrentModel(); }
  $('targetForm').onsubmit = async e => {
    e.preventDefault(); const submit = $('targetForm').querySelector('[type=submit]'); submit.disabled = true;
    try {
      const body = {model: $('model').value, expected: $('expected').value, effort: $('effort').value,
        intervalMinutes: Number($('interval').value === 'custom' ? $('customInterval').value : $('interval').value),
        mode: $('targetForm').querySelector('[name=mode]:checked').value};
      if (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 1 || body.intervalMinutes > 10080) throw Error('定期间隔应为 1–10080 分钟的整数。');
      if (editing) body.id = editing.id;
       if (body.mode !== 'manual' && (!editing || editing.mode === 'manual' || (scheduled(editing) && (editing.mode !== body.mode || editing.intervalMinutes !== body.intervalMinutes)))) {
        if (!await confirm('开启定期检测？', `Magpie 运行时每 ${body.intervalMinutes} 分钟对该模型取样，会消耗上游额度；${body.mode === 'protect' ? '强偏离还会暂停后续请求。' : '本模式不会自动暂停请求。'}保存后从下一个间隔开始。`)) return;
      }
      await api('targets', body); manualModel = {model: body.model, effort: body.effort};
      closeTarget(); await refresh(); notice('目标已保存。尚未主动发起检测。', 'success');
    } catch (e) { $('targetError').textContent = e.message; }
    finally { submit.disabled = false; }
  };
  function renderDetail() {
    const body = $('detailBody'), r = detail; body.replaceChildren();
    body.append(el('div', 'detail-title', r.model), el('div', 'detail-meta', '期望 ' + r.expected + ' · ' + date(r.startedAt)),
      badge(r.status), el('p', '', r.reason || (r.phase === 'confirming' ? '首次支持偏离，正在独立复测。' : '正在逐个取样，刷新页面不会重复启动。')));
    if (r.status === 'running') body.append(button('停止此目标检测', () => controlSchedule(state.targets.find(t => t.id === r.targetId), 'stop'), 'danger'));
    r.rounds.forEach((round, i) => {
      const box = el('section', 'round'); box.append(el('h3', '', i ? '第 2 轮 · 独立复测' : '第 1 轮 · 三样本指纹'));
      if (round.evidence) {
        const ranking = el('div', 'ranking');
        round.evidence.aggregate.topCandidates.forEach(c => {
          const row = el('div'); const meter = document.createElement('meter'); meter.min = 0; meter.max = 1; meter.value = c.score;
          row.append(el('span', 'mono', c.model), meter, el('span', '', Math.round(c.score * 100) + '%')); ranking.append(row);
        }); box.append(ranking, el('p', 'detail-note', '库内相对权重，不是模型身份置信度。'));
      }
      round.samples.forEach((s, index) => {
        const d = el('details'), summary = el('summary', '', `样本 ${index + 1} · ${s.status} · ${s.attempts.length} 次请求`);
        d.append(summary, el('p', 'detail-note', '要求 ' + s.expectedCount + ' 个整数。' + (s.reason || '')));
        const evidence = round.evidence?.samples[index];
        if (evidence) d.append(el('p', 'detail-note', '有效 ' + evidence.actualCount + ' 个 · 最接近 ' + evidence.prediction));
        d.append(el('h3', '', '挑战原文'), el('pre', '', s.prompt), el('h3', '', '样本回答'), el('pre', '', s.text || '尚无完整样本正文'));
        s.attempts.forEach((a, j) => d.append(el('p', 'detail-note', `尝试 ${j + 1} · ${a.status} · ${a.reason || date(a.startedAt)}`)));
        if (s.usage) d.append(el('p', 'detail-note', '上游报告 token：输入 ' + (s.usage.input_tokens ?? '未知') + ' / 输出 ' + (s.usage.output_tokens ?? '未知')));
        box.append(d);
      }); body.append(box);
    });
    body.append(el('p', 'detail-note', '工作台 v' + state.version + ' · ModelTrace ' + r.bankVersion.slice(0, 12) + ' · ' + (r.requests ?? '取样中') + ' 次请求'));
  }
  async function showDetail(id) { detailId = id; detail = await api('records/' + id); renderDetail(); if (!$('detailDialog').open) $('detailDialog').showModal(); }
  function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
    const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('exportRecord').onclick = () => { if (detail) download('model-evidence-' + detail.id + '.json', detail); };
  $('diagnose').onclick = () => {
    const s = {service: 'magpie-model-workbench', version: state.version, bankVersion: state.bankVersion,
      health: state.health, targetCount: state.targets.length, running: state.targets.filter(t => t.running).length,
      paused: state.targets.filter(t => t.paused && t.mode === 'protect').length, budget: state.daily,
       scheduled: state.targets.filter(scheduled).length,
      history: state.history.map(r => ({status: r.status, requests: r.requests, startedAt: r.startedAt, finishedAt: r.finishedAt}))};
    download('workbench-diagnostics.json', s);
  };
  function showView(view) {
    activeView = pageMeta[view] ? view : 'filters';
    const meta = pageMeta[activeView];
    $('pageTitle').textContent = meta[0]; $('pageSubtitle').textContent = meta[1];
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== activeView; });
    document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === activeView));
    if (state) {
      renderMonitoring();
      $('refresh').textContent = activeView === 'filters' ? '同步供应商' : activeView === 'history' ? '刷新记录'
        : activeView === 'settings' ? '重新检查' : '刷新状态';
    }
    if (activeView === 'filters' && !filterBase) loadFilters().catch(e => notice(e.message, 'error'));
    if (activeView === 'targets' && state && !currentSelection() && !$('targetDialog').dataset.offered && $('targetDialog').hidden) {
      $('targetDialog').dataset.offered = '1';
      editTarget().catch(e => notice(e.message, 'error'));
    }
  }
  document.querySelectorAll('.nav').forEach(b => b.onclick = () => showView(b.dataset.view));
  function paintFilters() {
    const dirty = filterBase ? H.differences(filterBase, filterDraft) : [];
    $('filterSave').disabled = filterBusy || !dirty.length;
    $('filterDiscard').disabled = filterBusy || !dirty.length;
    $('filterRefresh').disabled = filterBusy;
    $('filterEnabledOnly').disabled = !filterBase;
    $('filterEnabledOnly').setAttribute('aria-pressed', String(filterEnabledOnly));
    $('filterRefresh').textContent = filterBusy ? '正在处理…' : '合并供应商列表';
    $('filterDirty').textContent = !filterBase ? '尚未读取规则' : dirty.length ? new Set(dirty.map(x => x.id)).size + ' 个供应商待保存' : '没有未保存的修改';
    if (!filterBase) return;
    const {rows: list, total, enabled, narrowed} = H.view(filterBase, filterDraft, filterProviders,
      {enabledOnly: filterEnabledOnly, query: $('filterSearch').value});
    $('filterEnabledOnly').textContent = `只看已开启 · ${enabled}`;
    $('filterCount').textContent = `共 ${total} 个供应商 · 已开启 ${enabled} 个${narrowed ? ` · 找到 ${list.length} 个` : ''}`;
    $('filterRows').replaceChildren(...list.map(row => {
      const card = el('div', 'filter-row'), identity = el('div', 'filter-identity');
      identity.append(el('strong', '', row.name), el('small', 'mono', row.id));
      if (!row.listed || row.target !== row.id) identity.append(el('small', 'muted', row.target !== row.id ? '使用规则：' + row.target : '已存规则，当前列表中缺失'));
      card.append(identity);
      for (const [field, caption] of [['historyFilter', '历史过滤'], ['preserveEncryptedInclude', '保留新响应密文'], ['deepSeekObjectRoot', 'DeepSeek Schema']]) {
        const label = el('label', 'filter-toggle'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.setAttribute('role', 'switch'); checkbox.dataset.id = row.id; checkbox.dataset.field = field;
        checkbox.setAttribute('aria-label', row.name + '：' + caption);
        checkbox.checked = field === 'historyFilter' ? row.on
          : field === 'preserveEncryptedInclude' ? row.include : row.deepSeekObjectRoot;
        checkbox.disabled = filterBusy || !filterEnabled || (field === 'preserveEncryptedInclude' && !row.on);
        checkbox.onchange = () => {
          filterDraft = H.change(filterDraft, row.target, field, checkbox.checked); paintFilters();
          [...$('filterRows').querySelectorAll('input')].find(input => input.dataset.id === row.id && input.dataset.field === field)?.focus();
        };
        label.append(checkbox, el('span', '', caption + ' · ' + (checkbox.checked ? '开' : '关'))); card.append(label);
      }
      return card;
    }));
    $('filterEmpty').textContent = !filterEnabled ? '工作台插件当前已停用，请先在 Magpie 中启用。' : list.length ? ''
      : '没有符合条件的供应商。' + (filterEnabledOnly ? '取消筛选以搜索全部供应商。' : '');
  }
  async function loadFilters() {
    if (filterBusy) return;
    filterBusy = true; paintFilters();
    try {
      const data = await api('filter');
      const ids = new Set(data.providers.map(p => p.id));
      filterProviders = [...data.providers, ...[...new Set(models.map(m => m.split('/')[0]))]
        .filter(id => !ids.has(id)).map(id => ({id, name: id}))];
      filterEnabled = data.enabled;
      if (!filterBase || !H.differences(filterBase, filterDraft).length) filterBase = filterDraft = H.validate(data.options);
    } finally { filterBusy = false; paintFilters(); }
  }
  $('filterSearch').oninput = paintFilters;
  $('filterEnabledOnly').onclick = () => { filterEnabledOnly = !filterEnabledOnly; paintFilters(); };
  $('filterDiscard').onclick = async () => { filterDraft = filterBase; await loadFilters(); notice('已撤销修改并读取最新规则。'); };
  $('filterRefresh').onclick = async () => {
    try { await loadFilters(); notice('供应商规则已刷新，未保存的修改会保留。', 'success'); } catch (e) { notice(e.message, 'error'); }
  };
  $('filterSave').onclick = async () => {
    if (filterBusy) return;
    filterBusy = true; paintFilters();
    try {
      const saved = await api('filter', {base: filterBase, draft: filterDraft});
      filterBase = filterDraft = H.validate(saved.options);
      notice('过滤规则已保存，正在等待 Magpie 重载；页面会自动重新连接。', 'success');
      // The model-list read wakes Magpie's new host after its options change.
      api('models').catch(() => {});
    } catch (e) { notice(e.message, 'error'); }
    finally { filterBusy = false; paintFilters(); }
  };
  $('targetSearch').oninput = targets;
  for (const id of ['historySearch', 'historyStatus']) $(id).oninput = () => { page = 1; history(); };
  $('prev').onclick = () => { page--; history(); }; $('next').onclick = () => { page++; history(); };
  $('add').onclick = () => { editTarget(selectedTarget(currentSelection()) || null); };
  $('emptyAdd').onclick = () => editTarget();
  $('currentCheck').onclick = async () => {
    const selected = currentSelection(); if (!selected) return;
    $('currentCheck').disabled = true;
    try {
      const existing = selectedTarget(selected);
       if (existing?.running) { await cancelRound(existing); return; }
      if (!await confirm('运行三样本检测？', '将检测 ' + selected.model + '，期望 ' + (existing?.expected || referenceFor(selected.model))
        + '，推理 ' + (existing?.effort || selected.effort || 'default') + '。通常 3 次请求，强偏离时共 6 次，整轮最多额外重试 3 次；按上游计费，不发送项目上下文。')) return;
      if (!existing) {
        await api('targets', {model: selected.model, expected: referenceFor(selected.model), effort: selected.effort || 'default', mode: 'manual', intervalMinutes: 30});
        await refresh();
      }
      const target = selectedTarget(selected);
      if (!target) throw Error('未能保存当前模型，请调整监测后重试。');
      await api('check', {id: target.id}); notice('检测已开始，进度自动更新。'); await refresh();
    } catch (e) { notice(e.message, 'error'); } finally { renderCurrentModel(); }
  };
  $('closeTarget').onclick = $('cancelTarget').onclick = closeTarget;
  $('closeDetail').onclick = $('detailClose').onclick = () => $('detailDialog').close();
  $('modelSearch').oninput = modelOptions;
  $('model').onchange = () => { $('expected').value = referenceFor($('model').value); };
  $('refresh').onclick = async () => {
    $('refresh').disabled = true; $('refresh').textContent = '正在刷新…';
    try { await refresh(true); notice('模型列表与检测状态已刷新。', 'success'); }
    catch (e) { notice(e.message, 'error'); }
    finally { $('refresh').disabled = false; $('refresh').textContent = '刷新列表'; }
  };
  for (const id of ['connectionForm', 'budgetForm']) $(id).oninput = () => { $(id).dataset.dirty = '1'; };
  $('connectionForm').onsubmit = async e => {
    e.preventDefault(); try {
      await api('connection', {url: $('gatewayUrl').value, key: $('gatewayKey').value, clearKey: $('clearKey').checked});
      $('gatewayKey').value = ''; $('clearKey').checked = false; delete $('connectionForm').dataset.dirty;
      models = []; await refresh(); notice('连接设置已保存。请验证模型列表。', 'success');
    } catch (err) { notice(err.message, 'error'); }
  };
  $('testConnection').onclick = async () => {
    $('testConnection').disabled = true;
    try { models = (await api('models')).models; notice('网关已连接，读取到 ' + models.length + ' 个模型。本操作未调用模型。', 'success'); }
    catch (e) { notice(e.message, 'error'); } finally { $('testConnection').disabled = false; }
  };
  $('budgetForm').onsubmit = async e => {
    e.preventDefault(); try { await api('budget', {limit: Number($('dailyLimit').value)}); delete $('budgetForm').dataset.dirty; await refresh(); notice('预算已保存。', 'success'); }
    catch (err) { notice(err.message, 'error'); }
  };
  let theme = 'light';
  try { theme = localStorage.getItem('codex-workbench-theme') || localStorage.getItem('mw-theme') || 'light'; } catch {}
  document.documentElement.dataset.theme = theme;
  function themeControl() { const dark = theme === 'dark'; $('themeToggle').setAttribute('aria-pressed', String(dark)); $('themeToggle').title = $('themeToggle').ariaLabel = dark ? '切换为浅色' : '切换为深色'; }
  $('themeToggle').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('codex-workbench-theme', theme); } catch {} themeControl(); };
  themeControl();
  (async () => {
    try {
      const open = new URLSearchParams(location.hash.slice(1)).get('open');
      if (open) { window.history.replaceState(null, '', '/'); await api('session', {key: open}); }
      showView(activeView);
      await refresh(true);
      window.ServiceControls?.mount({tools:document.querySelector('.workbench-top .actions'),settings:document.querySelector('#settings .settings-grid'),
        mode:'magpie',api:(route,body)=>api(route.slice(1),body)});
      let reconnecting = false;
      setInterval(() => { if (!window.ServiceControls?.suspended && !document.hidden) refresh().then(() => {
        if (reconnecting) { reconnecting = false; notice('工作台已重新连接。过滤规则与检测记录已保留。', 'success'); }
      }).catch(() => { reconnecting = true; notice('正在重新连接工作台…如 Magpie 已关闭，请先启动后从桌面入口打开。'); }); }, 3000);
    } catch (e) { notice(e.message, 'error'); }
  })();
})();
