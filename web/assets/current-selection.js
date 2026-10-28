// Pure selection priority, shared with the CC Switch dashboard.
(() => {
  globalThis.WorkbenchSelection = ({current, history = [], configured}) => {
    if (current?.model && current.source === 'request') return {...current, source: 'request'};
    const latest = history.filter(r => r?.model).slice().sort((a, b) =>
      (Date.parse(b.observedAt || b.checkedAt) || Number(b.startedAt) || 0) - (Date.parse(a.observedAt || a.checkedAt) || Number(a.startedAt) || 0))[0];
    if (latest) return {...latest, source: 'history'};
    if (current?.model && current.source === 'history') return {...current, source: 'history'};
    if (configured?.model) return {...configured, source: 'config'};
    return null;
  };
})();
