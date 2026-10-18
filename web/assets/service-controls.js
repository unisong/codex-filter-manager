/* Shared lifecycle controls for the CC Switch and Magpie workbenches. */
(() => {
  'use strict';
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const controls = window.ServiceControls = {suspended: false};
  controls.mount = ({tools, settings, api, mode}) => {
    const magpie = mode === 'magpie';
    const stop = el('button', magpie ? '关闭工作台' : '关闭服务', 'button service-stop');
    stop.id = 'stopService'; stop.type = 'button';
    stop.title = magpie ? '停止工作台与模型检测，保留 Magpie 和历史过滤' : '停止过滤服务并恢复 Codex 配置';
    const power = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    power.setAttribute('viewBox', '0 0 24 24'); power.setAttribute('aria-hidden', 'true');
    power.innerHTML = '<path d="M12 3v9M6 5.5a9 9 0 1 0 12 0"/>';
    stop.prepend(power); tools.append(stop);
    const panel = el('section', '', 'panel service-update'); panel.id = 'updatePanel';
    const head = el('div', '', 'service-update-head'), title = el('div');
    title.append(el('div', 'APPLICATION', 'eyebrow'), el('h2', '版本更新'));
    const check = el('button', '检查更新', 'button'); check.id = 'checkUpdates'; check.type = 'button';
    head.append(title, check);
    const summary = el('p', '正在读取本机版本…', 'service-update-status');
    summary.id = 'updateStatus'; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
    const description = el('p', magpie
      ? '手动检查 GitHub 正式版本。新版下载并校验后，在 Magpie 切换插件目录；不会覆盖运行中的插件。'
      : '手动检查 GitHub 正式版本。安装前备份程序文件，保留本机规则与记录；安装后自动重启过滤服务。', 'muted');
    const row = el('div', '', 'service-update-actions');
    const label = el('label', '可选更新 '), select = el('select'); select.id = 'updateVersion'; label.htmlFor = select.id; label.append(select);
    const install = el('button', magpie ? '下载并准备新版' : '安装并重启', 'button primary');
    install.id = 'installUpdate'; install.type = 'button'; install.disabled = true;
    row.append(label, install); row.hidden = true;
    const notes = el('details', '', 'service-release-notes');
    const noteText = el('pre'), link = el('a', '在 GitHub 查看此版本');
    link.target = '_blank'; link.rel = 'noreferrer';
    notes.append(el('summary', '版本说明'), noteText, link); notes.hidden = true;
    const reason = el('p', '', 'muted'), result = el('p', '', 'service-update-result'); result.id = 'updateResult';
    const ready = el('div', '', 'service-update-ready'); ready.hidden = true;
    const readyPath = el('input'); readyPath.readOnly = true; readyPath.setAttribute('aria-label', '新版 Magpie 插件目录');
    readyPath.onclick = () => readyPath.select();
    ready.append(el('p', '新版已准备好。在 Magpie 中将本地插件目录切换为下方路径，然后重新加载。模型设置与记录继续使用原来的本机数据目录。'), readyPath);
    panel.append(head, description, summary, row, reason, notes, result, ready); settings.prepend(panel);
    const dialog = el('dialog', '', 'service-confirm'); dialog.id = 'serviceConfirm';
    const form = el('form'); form.method = 'dialog';
    const heading = el('h2'), message = el('p'), actions = el('div', '', 'service-update-actions');
    const cancel = el('button', '取消', 'button'), accept = el('button', '确认', 'button primary');
    cancel.value = 'cancel'; accept.value = 'ok'; actions.append(cancel, accept);
    form.append(heading, message, actions); dialog.append(form); document.body.append(dialog);
    const confirm = (title, text, action) => new Promise(resolve => {
      heading.textContent = title; message.textContent = text; accept.textContent = action;
      dialog.returnValue = ''; dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once: true});
      dialog.showModal(); cancel.focus();
    });
    let state, timer, recovering = false, recoveryStarted = 0;
    const busy = () => state && (['checking', 'downloading'].includes(state.phase) || state.result?.phase === 'installing');
    const showSelection = () => {
      const release = state?.releases.find(r => r.tag === select.value);
      notes.hidden = !release; noteText.textContent = release?.notes || '此版本没有附加说明。';
      if (release) link.href = release.page;
    };
    function render(value) {
      state = value;
      const selected = select.value;
      select.replaceChildren(...state.releases.map(r => {
        const option = el('option', r.tag + (r === state.releases[0] ? ' · 最新' : ''));
        option.value = r.tag; return option;
      }));
      if (state.releases.some(r => r.tag === selected)) select.value = selected;
      const active = busy();
      check.disabled = active; check.textContent = state.phase === 'checking' ? '正在检查…' : '检查更新';
      check.setAttribute('aria-busy', String(state.phase === 'checking'));
      stop.disabled = active; select.disabled = active; install.disabled = active || !state.canInstall || !state.releases.length;
      row.hidden = !state.releases.length; reason.textContent = state.installReason;
      summary.textContent = `当前 v${state.currentVersion} · ` + (state.phase === 'checking' ? '正在连接 GitHub…'
        : state.phase === 'downloading' ? '正在下载并校验发布包…'
        : state.result?.phase === 'installing' ? '正在准备安装，请勿重复启动或关闭…'
        : state.error || (!state.checkedAt ? '尚未检查' : state.releases.length ? `发现 ${state.releases.length} 个可更新版本` : '未发现可安装的正式更新'));
      panel.dataset.error = String(!!state.error || state.result?.phase === 'failed');
      const r = state.result;
      result.textContent = r?.phase === 'installed' ? `${r.tag} 已安装并重启，本机规则与记录已保留。`
        : r?.phase === 'ready' ? `${r.tag} 已下载并通过校验。`
        : r?.phase === 'failed' ? '更新未完成：' + r.message : '';
      ready.hidden = r?.phase !== 'ready'; readyPath.value = r?.target || '';
      showSelection();
      clearTimeout(timer);
      if (active) timer = setTimeout(refresh, 1500);
      else if (recovering) {
        // The service token changes across an in-place restart; reload the document for a new token.
        if (r?.phase === 'installed') location.reload();
        recovering = false; controls.suspended = false;
      }
    }
    async function refresh() {
      try { render(await api('/updates')); }
      catch (error) {
        if (recovering && Date.now() - recoveryStarted < 180000) {
          summary.textContent = '过滤服务正在重启，页面将自动重新连接…';
          // A new service can reject the old token. Reload as soon as its public health endpoint answers.
          try {
            const r = await fetch('/__codex_filter__/health', {signal: AbortSignal.timeout(2000)});
            if (r.ok && (await r.json()).state !== 'stopping') { location.reload(); return; }
          } catch {}
          timer = setTimeout(refresh, 2000); return;
        }
        summary.textContent = '无法读取更新状态：' + error.message;
        check.disabled = false; stop.disabled = false; controls.suspended = false; recovering = false;
      }
    }
    select.onchange = showSelection;
    check.onclick = async () => {
      check.disabled = true; check.textContent = '正在检查…';
      try { render(await api('/updates/check', {})); }
      catch (error) { summary.textContent = error.message; check.disabled = false; check.textContent = '检查更新'; }
    };
    install.onclick = async () => {
      const tag = select.value;
      if (!await confirm(magpie ? `准备 ${tag}？` : `安装 ${tag} 并重启？`, magpie
        ? '下载到独立目录并校验。现有插件继续运行，完成后按提示在 Magpie 切换目录。'
        : '请先结束正在进行的 Codex 调用。安装会停止过滤服务及检测，备份程序文件后安装新版；失败时尝试恢复旧版。本机规则与记录会保留。', magpie ? '下载新版' : '安装并重启')) return;
      install.disabled = true;
      try {
        render(await api('/updates/install', {tag}));
        recovering = !magpie; recoveryStarted = Date.now(); controls.suspended = !magpie;
      } catch (error) { summary.textContent = error.message; install.disabled = false; }
    };
    stop.onclick = async () => {
      if (!await confirm(magpie ? '关闭本机工作台？' : '关闭过滤服务？', magpie
        ? '停止工作台和所有模型检测。Magpie、历史过滤和已有模型暂停规则继续有效。再次使用时从 Magpie 的工作台入口打开，或重新加载插件；定期检测需手动恢复。'
        : '恢复 Codex 接入地址，取消检测并关闭过滤服务，进行中的调用可能中断。CC Switch 与 Codex 本身继续运行。下次双击 Start.bat 或桌面快捷方式启动。', '确认关闭')) return;
      stop.disabled = true; controls.suspended = true;
      try {
        await api('/service/stop', {}); clearTimeout(timer);
        const banner = el('div', '', 'service-stopped'); banner.id = 'serviceStopped'; banner.setAttribute('role', 'status');
        banner.append(el('strong', '正在关闭…'), el('p', magpie
          ? '工作台与检测将停止。Magpie 和历史过滤继续运行；从 Magpie 的工作台入口可再次打开。'
          : 'Codex 配置已恢复，过滤服务正在结束请求。下次双击 Start.bat 或桌面快捷方式启动。'));
        tools.closest('header').after(banner);
        document.querySelectorAll('main button, main input, main select, aside button').forEach(node => { node.disabled = true; });
        const health = magpie ? '/health' : '/__codex_filter__/health';
        let attempts = 0;
        const verify = async () => {
          try {
            const r = await fetch(health, {signal: AbortSignal.timeout(2000)});
            if (!r.ok) throw Error('stopped');
            if (++attempts < 20) { setTimeout(verify, 1000); return; }
            banner.firstChild.textContent = '关闭仍在进行，请稍后查看状态';
          } catch { banner.firstChild.textContent = magpie ? '工作台已关闭' : '过滤服务已关闭'; }
        };
        setTimeout(verify, 500);
      } catch (error) { controls.suspended = false; stop.disabled = false; summary.textContent = error.message; alert(error.message); }
    };
    refresh();
  };
})();
