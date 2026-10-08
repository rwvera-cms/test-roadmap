/* Enterprise Roadmap POC — vanilla JS, no build step.
   Data: data/roadmap.json (written by scripts/sync-lists.mjs), falling back to data/roadmap.sample.json.
   Routes (hash):  #/                       enterprise
                   #/i/CLD-02               enterprise + initiative panel
                   #/product/CLD            product-area roadmap
                   #/product/CLD/CLD-02     product-area roadmap + initiative panel */
(() => {
  'use strict';

  const STATUSES = ['On track', 'At risk', 'Off track', 'Not started', 'Done'];
  const STATUS_VAR = { 'On track': '--ok', 'At risk': '--warn', 'Off track': '--bad', 'Not started': '--idle', 'Done': '--done' };
  const HORIZONS = [
    { id: 'Commit', blurb: 'Scope and dates are firm. Track against them.' },
    { id: 'Plan', blurb: 'Direction is set. Dates are indicative.' },
    { id: 'Explore', blurb: 'Options under evaluation, not commitments.' },
  ];
  const RISK = ['At risk', 'Off track'];
  const VIEWS = ['timeline', 'horizons', 'outcomes', 'risk'];
  // Product-area categories. Set per area in Enterprise Setup → Product Areas → Category.
  // Until that column exists, these area codes default to Operational and the rest to Engineering.
  const CATEGORIES = [
    { id: 'Engineering', blurb: 'New development' },
    { id: 'Operational', blurb: 'Run and operate' },
  ];
  const DEFAULT_OPERATIONAL = ['CMG', 'CAD', 'DVO', 'AGT'];
  const categoryOf = (a) => CATEGORIES.find((c) => c.id.toLowerCase() === String(a.category || '').trim().toLowerCase())?.id
    || (DEFAULT_OPERATIONAL.includes(a.id) ? 'Operational' : 'Engineering');
  // Timeline grouping dimensions, outermost first. Picking several nests them in this order.
  const DIMS = ['category', 'area', 'theme'];
  const DIM_LABEL = { category: 'Category', area: 'Product area', theme: 'Strategic theme' };
  const STALE_DAYS = 30;
  const DAY = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const d = (iso) => (iso ? Date.parse(iso.slice(0, 10) + 'T00:00:00Z') : NaN);
  const fmt = (iso) => { const t = d(iso); if (isNaN(t)) return '—'; const x = new Date(t); return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`; };
  const fmtMonth = (iso) => { const t = d(iso); if (isNaN(t)) return '—'; const x = new Date(t); return `${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
  const now = new Date();
  const TODAY = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  const store = {
    get(k, f) { try { return localStorage.getItem('roadmap.' + k) ?? f; } catch { return f; } },
    set(k, v) { try { localStorage.setItem('roadmap.' + k, v); } catch { /* storage unavailable */ } },
  };

  const S = {
    data: null, byId: {}, theme: {}, area: {}, hue: {},
    view: VIEWS.includes(store.get('view')) ? store.get('view') : 'timeline',
    groups: (store.get('groups', '') || store.get('group', 'theme')).split(',').filter((g) => DIMS.includes(g)),
    areaTab: store.get('areaTab', 'Engineering'),
    fThemes: [], fStatuses: [],
    hStatus: '', hDim: store.get('hdim', 'area'), hKey: '', // project health drill-down
    months: Number(store.get('months', 18)),
    hash: location.hash || '#/',
  };

  /* ---------- data ---------- */
  async function load() {
    if (window.ROADMAP_DATA) return window.ROADMAP_DATA;
    for (const url of ['data/roadmap.json', 'data/roadmap.sample.json']) {
      try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* try next */ }
    }
    throw new Error('No roadmap data found. Run the sync workflow, or add data/roadmap.sample.json.');
  }

  function index(data) {
    S.data = data; S.byId = {}; S.theme = {}; S.area = {}; S.hue = {};
    data.themes.forEach((t, i) => { S.theme[t.id] = t; S.hue[t.id] = `var(--c${(i % 6) + 1})`; });
    data.productAreas.forEach((a) => { a.category = categoryOf(a); S.area[a.id] = a; });
    data.initiatives.forEach((i) => { S.byId[i.id] = i; i.dependsOn = i.dependsOn || []; });
    data.initiatives.forEach((i) => { i.blocks = data.initiatives.filter((o) => o.dependsOn.includes(i.id)).map((o) => o.id); });
    data.initiatives.forEach((i) => { i.conflicts = conflictsFor(i); i.progress = progressFor(i); });
  }

  function conflictsFor(i) {
    return i.dependsOn.map((id) => S.byId[id]).filter(Boolean)
      .filter((dep) => dep.status !== 'Done' && d(dep.end) > d(i.start))
      .map((dep) => ({ dep, text: `Starts ${fmt(i.start)}, before ${dep.id} is due to finish (${fmt(dep.end)})` }));
  }

  // Jira progress (mocked in sample data). pct = share of the epic's child issues done;
  // expected = share of the initiative's planned time already elapsed.
  const BEHIND = 15; // points behind schedule before we flag it
  function progressFor(i) {
    if (!i.jira || !i.jira.total) return null;
    const pct = Math.round((i.jira.done / i.jira.total) * 100);
    const s = d(i.start), e = d(i.end);
    const expected = Math.round(Math.min(Math.max((TODAY - s) / (e - s), 0), 1) * 100);
    return { ...i.jira, pct, expected, behind: pct < expected - BEHIND, late: !!i.jira.forecastEnd && d(i.jira.forecastEnd) > e };
  }
  function rollup(list) {
    const withP = list.filter((i) => i.progress);
    const total = withP.reduce((n, i) => n + i.progress.total, 0);
    return total ? { pct: Math.round(withP.reduce((n, i) => n + i.progress.done, 0) / total * 100), epics: withP.length } : null;
  }
  const pctLabel = (p) => `<span class="pct${p.behind ? ' behind' : ''}">${p.pct}%</span>`;

  function milestonesFor(id) { return S.data.milestones.filter((m) => m.initiative === id).sort((a, b) => d(a.date) - d(b.date)); }

  /* ---------- routing ---------- */
  function route() {
    const p = S.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (p[0] === 'product' && S.area[p[1]]) return { area: p[1], open: p[2] || null };
    if (p[0] === 'i') return { area: null, open: p[1] || null };
    return { area: null, open: null };
  }
  function go(hash) {
    S.hash = hash;
    try { if (location.hash !== hash) history.pushState(null, '', hash); } catch { /* sandboxed */ }
    render();
  }
  const baseHash = (r) => (r.area ? `#/product/${r.area}` : '#/');
  const openHash = (r, id) => (r.area ? `#/product/${r.area}/${id}` : `#/i/${id}`);

  /* ---------- scope ---------- */
  function scoped(r) {
    return S.data.initiatives.filter((i) =>
      (!r.area || i.productArea === r.area) &&
      (!S.fThemes.length || S.fThemes.includes(i.theme)) &&
      (!S.fStatuses.length || S.fStatuses.includes(i.status)));
  }

  /* ---------- fiscal calendar ---------- */
  function windowRange() {
    const fs = (S.data.settings?.fiscalYearStartMonth || 1) - 1;
    const m = now.getMonth();
    const off = (m - fs + 12) % 12;
    const qStart = Date.UTC(now.getFullYear(), m - (off % 3), 1);
    const start = new Date(qStart); start.setUTCMonth(start.getUTCMonth() - 3); // one quarter of history
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + S.months);
    return { ws: start.getTime(), we: end.getTime(), fs };
  }
  function quarterLabel(t, fs) {
    const x = new Date(t); const m = x.getUTCMonth(); const off = (m - fs + 12) % 12;
    const fy = fs === 0 ? x.getUTCFullYear() : (m >= fs ? x.getUTCFullYear() + 1 : x.getUTCFullYear());
    return { isQStart: off % 3 === 0, label: `Q${Math.floor(off / 3) + 1} FY${String(fy).slice(2)}` };
  }

  /* ---------- render root ---------- */
  function render() {
    const r = route();
    const area = r.area ? S.area[r.area] : null;
    const items = scoped(r);

    $('#org').textContent = `${S.data.settings?.orgName || ''} · COMET`.replace(/^ · /, '');
    $('#page-title').textContent = area ? `${area.name} roadmap` : 'Enterprise Roadmap';
    document.title = area ? `${area.name} · Roadmap` : 'Enterprise Roadmap';
    $('#crumbs').innerHTML = area
      ? `<a href="#/" data-go="#/">Enterprise</a><span aria-hidden="true">›</span><span aria-current="page">${esc(area.name)}</span>`
      : '<span aria-current="page">All product areas</span>';

    const gen = S.data.generatedAt ? new Date(S.data.generatedAt) : null;
    $('#freshness').innerHTML = gen
      ? `Data as of ${esc(gen.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}<br>Source: ${({ lists: 'MS Lists', 'lists-csv': 'MS Lists (CSV export)', excel: 'roadmap workbooks' })[S.data.source] || 'sample file'}`
      : '';
    $('#sample-banner').hidden = S.data.source !== 'sample' || !!S.preview;

    renderHealth(r);
    $('#areas-section').hidden = !!area;
    if (!area) renderAreas();
    const ph = $('#product-head');
    ph.hidden = !area;
    if (area) {
      ph.innerHTML = `<div class="eyebrow mono">${esc(area.id)}</div><div>${esc(area.description || '')}</div>
        <div class="people"><span>Product owner: <b>${esc(area.owner || '—')}</b></span><span>Delivery manager: <b>${esc(area.deliveryManager || '—')}</b></span></div>`;
    }

    document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
    $('#group-wrap').hidden = !!area || S.view !== 'timeline';
    $('#f-window').parentElement.hidden = S.view !== 'timeline';
    $('#f-status').parentElement.hidden = S.view === 'risk'; // the risk view picks statuses itself
    $('#risk-count').textContent = S.data.initiatives.filter((i) => (!r.area || i.productArea === r.area) && RISK.includes(i.status)).length || '';

    const v = $('#view');
    if (S.view === 'timeline') v.innerHTML = timeline(items, r);
    else if (S.view === 'horizons') v.innerHTML = horizons(items);
    else if (S.view === 'outcomes') v.innerHTML = outcomes(items, r);
    else v.innerHTML = riskView(r);
    renderLegend();
    renderDrawer(r);
  }

  /* ---------- project health (portfolio status) ----------
     Full-width status mix that leads with what's on track. Clicking a status opens the
     "At risk" tab focused on it. Ignores toolbar filters; scoped to the product area on its page. */
  function renderHealth(r) {
    const all = S.data.initiatives.filter((i) => !r.area || i.productArea === r.area);
    const pctOf = (n) => (all.length ? Math.round((n / all.length) * 100) : 0);
    const ok = all.filter((i) => i.status === 'On track').length;
    const done = all.filter((i) => i.status === 'Done').length;
    const risky = all.filter((i) => RISK.includes(i.status)).length;
    const mix = STATUSES.map((s) => [s, all.filter((i) => i.status === s).length]).filter(([, n]) => n);
    const sel = S.view === 'risk' ? S.hStatus : '';
    const cls = (s) => (sel ? (sel === s ? ' on' : ' off') : '');

    $('#health').innerHTML = `
      <h2 id="health-h" class="section-h">Project health</h2>
      <div class="hcard">
        <div class="hhead"><div><h3>Portfolio status</h3><span class="small muted">Select a status to see its initiatives</span></div>
          ${risky ? `<button class="link-btn small" data-h-status="">${risky} at risk or off track ›</button>` : ''}</div>
        ${all.length ? `<div class="hero"><b>${ok}</b><span>of ${all.length} initiatives on track <span class="muted">(${pctOf(ok)}%)</span>${done ? ` <span class="muted">· ${done} done</span>` : ''}</span></div>
        <div class="hmix" role="group" aria-label="Initiatives by status">${mix.map(([s, n]) => {
          const tip = `${n} ${s} · ${pctOf(n)}% of initiatives`;
          return `<button class="seg${cls(s)}" data-h-status="${esc(s)}" style="flex:${n};--sc:var(${STATUS_VAR[s]})" data-tip="${esc(tip)}" aria-label="${esc(tip)}" aria-pressed="${sel === s}"></button>`;
        }).join('')}</div>
        <div class="hlegend">${mix.map(([s, n]) => `<button class="${cls(s)}" data-h-status="${esc(s)}" aria-pressed="${sel === s}"><span class="dot" style="--sc:var(${STATUS_VAR[s]})"></span>${esc(s)} <b>${n}</b> <span class="muted">${pctOf(n)}%</span></button>`).join('')}</div>`
        : '<span class="small muted">No initiatives yet.</span>'}
      </div>`;
  }

  /* ---------- at risk tab ----------
     Breakdown of the selected statuses (default: at risk + off track) by product area or theme,
     then the initiatives behind the selected bar. Follows the Theme filter. */
  function riskView(r) {
    const all = S.data.initiatives.filter((i) => (!r.area || i.productArea === r.area) && (!S.fThemes.length || S.fThemes.includes(i.theme)));
    const dim = r.area ? 'theme' : S.hDim;
    const pick = S.hStatus ? [S.hStatus] : RISK;
    const sel = all.filter((i) => pick.includes(i.status));
    const what = S.hStatus ? S.hStatus.toLowerCase() : 'at risk or off track';
    const What = what[0].toUpperCase() + what.slice(1);

    const groups = (dim === 'area' ? S.data.productAreas : S.data.themes).map((g) => {
      const key = (i) => (dim === 'area' ? i.productArea : i.theme) === g.id;
      return { id: g.id, name: g.name, total: all.filter(key).length, items: sel.filter(key) };
    }).filter((g) => g.items.length).sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
    if (!groups.some((g) => g.id === S.hKey)) S.hKey = '';
    const max = Math.max(1, ...groups.map((g) => g.items.length));
    const rows = groups.map((g) => {
      const parts = pick.map((s) => [s, g.items.filter((i) => i.status === s).length]).filter(([, n]) => n);
      const tip = `${g.name}: ${parts.map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ')} of ${g.total} initiatives`;
      return `<button class="hrow${S.hKey === g.id ? ' on' : ''}${S.hKey && S.hKey !== g.id ? ' off' : ''}" data-h-key="${esc(g.id)}" data-tip="${esc(tip)}" aria-label="${esc(tip)}" aria-pressed="${S.hKey === g.id}">
        <span class="hname">${esc(g.name)}</span>
        <span class="htrack"><span class="hfill" style="width:${(g.items.length / max) * 100}%">${parts.map(([s, n]) => `<i style="flex:${n};background:var(${STATUS_VAR[s]})"></i>`).join('')}</span></span>
        <span class="hval">${g.items.length} <span class="muted">of ${g.total}</span></span>
      </button>`;
    }).join('');
    const dimToggle = r.area ? '' : `<div class="seg-ctl" role="group" aria-label="Break down by">${[['area', 'Product area'], ['theme', 'Theme']].map(([k, l]) =>
      `<button data-h-dim="${k}" aria-pressed="${dim === k}">${l}</button>`).join('')}</div>`;
    const reset = S.hStatus || S.hKey ? '<button class="link-btn small" data-h-reset>Back to at risk + off track</button>' : '';

    const g = groups.find((x) => x.id === S.hKey);
    const list = (g ? g.items : sel).slice().sort((a, b) => RISK.indexOf(b.status) - RISK.indexOf(a.status) || d(a.end) - d(b.end));
    const empty = `<div class="empty">No initiatives are ${esc(what)}.</div>`;

    return `<div class="stack">
      <div class="hcard">
        <div class="hhead"><div><h3>${esc(What)} by ${dim === 'area' ? 'product area' : 'theme'}</h3><span class="small muted">Select a bar to see its initiatives</span></div>
          <div class="hhead-actions">${reset}${dimToggle}</div></div>
        ${rows ? `<div class="hbars">${rows}</div>` : empty}
      </div>
      <div class="hdrill">
        <div class="hdrill-head"><span class="hcrumb"><span>${esc(What)}</span>${g ? `<span aria-hidden="true">›</span><span>${esc(g.name)}</span>` : ''}<span class="count">${list.length}</span></span>
          ${g && dim === 'area' ? `<button class="link-btn small" data-go="#/product/${esc(g.id)}">Open ${esc(g.name)} roadmap ›</button>` : ''}</div>
        ${list.length ? `<div class="hlist">${list.map((i) => `<button class="hitem" data-open="${esc(i.id)}">
          <span class="hitem-top"><span class="mono">${esc(i.id)}</span><span class="t">${esc(i.title)}</span>${pill(i.status)}</span>
          <span class="small muted">${esc(S.area[i.productArea]?.name || '')} · ${esc(S.theme[i.theme]?.name || '')} · ${esc(i.horizon)} · due ${fmt(i.end)}${i.owner ? ` · ${esc(i.owner)}` : ''}</span>
          ${i.riskNote ? `<span class="hnote">${esc(i.riskNote)}</span>` : ''}
        </button>`).join('')}</div>` : empty}
      </div>
    </div>`;
  }

  function renderAreas() {
    if (!CATEGORIES.some((c) => c.id === S.areaTab)) S.areaTab = CATEGORIES[0].id;
    $('#area-tabs').innerHTML = CATEGORIES.map((c) => {
      const n = S.data.productAreas.filter((a) => a.category === c.id).length;
      return `<button role="tab" data-area-tab="${c.id}" aria-selected="${S.areaTab === c.id}" title="${esc(c.blurb)}">${c.id} <span class="count">${n}</span></button>`;
    }).join('');
    const list = S.data.productAreas.filter((a) => a.category === S.areaTab);
    $('#areas').innerHTML = list.length ? '' : `<div class="empty">No ${S.areaTab.toLowerCase()} product areas.</div>`;
    $('#areas').insertAdjacentHTML('beforeend', list.map((a) => {
      const its = S.data.initiatives.filter((i) => i.productArea === a.id);
      const mix = STATUSES.map((s) => [s, its.filter((i) => i.status === s).length]).filter(([, n]) => n);
      const risky = its.filter((i) => i.status === 'At risk' || i.status === 'Off track').length;
      const ru = rollup(its);
      return `<button class="area" data-go="#/product/${esc(a.id)}" aria-label="Open ${esc(a.name)} roadmap">
        <span class="name"><span>${esc(a.name)}</span><span class="mono">${esc(a.id)}</span></span>
        <span class="mix" title="${esc(mix.map(([s, n]) => `${n} ${s}`).join(', '))}">${mix.map(([s, n]) => `<i style="width:${(n / its.length) * 100}%;background:var(${STATUS_VAR[s]})"></i>`).join('')}</span>
        ${ru ? `<span class="meta"><b style="color:var(--fg)">${ru.pct}%</b> of Jira issues done across ${ru.epics} epic${ru.epics > 1 ? 's' : ''}</span>` : `<span class="meta">${its.filter((i) => i.jiraEpic).length} of ${its.length} linked to Jira${its.some((i) => i.jiraEpic) ? ' · progress not synced' : ''}</span>`}
        <span class="meta">${its.length} initiatives${risky ? ` · <b style="color:var(--bad)">${risky} at risk</b>` : ''} · DM ${esc(a.deliveryManager || '—')}</span>
      </button>`;
    }).join(''));
  }

  /* ---------- timeline ---------- */
  function timeline(items, r) {
    const { ws, we, fs } = windowRange();
    const pct = (t) => ((Math.min(Math.max(t, ws), we) - ws) / (we - ws)) * 100;
    const inWin = items.filter((i) => d(i.end) >= ws && d(i.start) <= we);
    const hidden = items.length - inWin.length;

    // header ticks
    let ticks = '', lines = '';
    for (let t = ws; t < we;) {
      const x = new Date(t); const q = quarterLabel(t, fs); const left = pct(t);
      if (q.isQStart) ticks += `<span class="q-lbl" style="left:${left}%">${q.label}</span>`;
      ticks += `<span class="m-lbl" style="left:${left}%">${MONTHS[x.getUTCMonth()]}</span>`;
      lines += `<span class="gridline${q.isQStart ? ' q' : ''}" style="left:${left}%"></span>`;
      x.setUTCMonth(x.getUTCMonth() + 1); t = x.getTime();
    }
    const today = TODAY >= ws && TODAY <= we ? `<span class="today" style="left:${pct(TODAY)}%"><span>Today</span></span>` : '';

    const bar = (i, showAllMs) => {
      const s = d(i.start), e = d(i.end);
      const left = pct(s), width = Math.max(pct(e) - left, 0.8);
      const ms = milestonesFor(i.id).filter((m) => (showAllMs || m.type === 'Review gate') && d(m.date) >= ws && d(m.date) <= we)
        .map((m) => `<span class="ms${m.done ? ' done' : ''}${m.type === 'Review gate' ? ' gate' : ''}" style="left:${((pct(d(m.date)) - left) / width) * 100}%"></span>`).join('');
      const p = i.progress;
      const tip = `${i.id} · ${i.title}\n${i.status} · ${i.horizon}\n${fmt(i.start)} – ${fmt(i.end)}${p ? `\nJira: ${p.done} of ${p.total} issues done (${p.pct}%). Expected by today: ${p.expected}%` : ''}${i.conflicts.length ? '\n! ' + i.conflicts.map((c) => c.text).join('\n! ') : ''}`;
      // Progress fill is clipped to the visible part of the bar when the bar starts before the window.
      const fillPct = p ? Math.min(Math.max(((pct(s + (e - s) * p.pct / 100) - left) / width) * 100, 0), 100) : 0;
      return `<button class="bar h-${esc(i.horizon.toLowerCase())}${p ? ' has-p' : ''}" data-open="${esc(i.id)}" data-id="${esc(i.id)}"
        style="left:${left}%;width:${width}%;--hue:${S.hue[i.theme] || 'var(--c6)'};--pct:${fillPct}%" title="${esc(tip)}">
        ${s < ws ? '<span class="clip" aria-label="starts earlier">◂</span>' : ''}
        <span class="dot" style="--sc:var(${STATUS_VAR[i.status] || '--idle'})" aria-label="${esc(i.status)}"></span>
        ${i.conflicts.length ? '<span class="warn" aria-label="dependency conflict">!</span>' : ''}
        <span class="key">${esc(i.id)}</span><span>${esc(i.title)}</span>${p ? pctLabel(p) : ''}${ms}
      </button>`;
    };

    const pack = (list) => { // greedy row packing so bars in one lane never overlap
      const rows = [];
      [...list].sort((a, b) => d(a.start) - d(b.start)).forEach((i) => {
        const row = rows.find((rw) => d(rw.at(-1).end) + 20 * DAY < d(i.start));
        row ? row.push(i) : rows.push([i]);
      });
      return rows;
    };

    let lanes, headLabel = 'Initiative';
    if (r.area) {
      lanes = [...inWin].sort((a, b) => d(a.start) - d(b.start)).map((i) => ({
        label: `<button data-open="${esc(i.id)}">${esc(i.title)}</button>
                <span class="sub"><span class="tag"><i style="--hue:${S.hue[i.theme]}"></i>${esc(S.theme[i.theme]?.name || '')}</span></span>
                <span class="sub">${i.progress ? `${i.progress.done}/${i.progress.total} issues done · ${esc(i.jiraEpic)}` : i.jiraEpic ? `Jira ${esc(i.jiraEpic)}` : 'No Jira epic linked'}</span>`,
        rows: [[i]], allMs: true,
      }));
    } else {
      // One lane per combination of the selected dimensions. With 2+ dimensions, the outermost
      // becomes a header row and the lane label shows the rest of the path.
      const dims = DIMS.filter((k) => S.groups.includes(k));
      if (!dims.length) dims.push('theme');
      const groupsOf = {
        category: () => CATEGORIES.map((c) => ({ id: c.id, name: c.id, sub: c.blurb })),
        area: () => S.data.productAreas,
        theme: () => S.data.themes,
      };
      const keyOf = { category: (i) => S.area[i.productArea]?.category, area: (i) => i.productArea, theme: (i) => i.theme };
      const labelOf = (k, g, path) => {
        const trail = path.length ? `<span class="sub">${path.map((p) => esc(p.name)).join(' › ')}</span>` : '';
        if (k === 'area') return `${trail}<button data-go="#/product/${esc(g.id)}">${esc(g.name)}</button><span class="sub">Open product roadmap ›</span>`;
        if (k === 'theme') return `${trail}<span class="tag" style="color:var(--fg);font-weight:600"><i style="--hue:${S.hue[g.id]}"></i>${esc(g.name)}</span><span class="sub">${esc(g.kpi?.name || '')}</span>`;
        return `${trail}<span style="font-weight:600">${esc(g.name)}</span><span class="sub">${esc(g.sub || '')}</span>`;
      };
      const walk = (list, ds, path) => groupsOf[ds[0]]().flatMap((g) => {
        const sub = list.filter((i) => keyOf[ds[0]](i) === g.id);
        if (!sub.length) return [];
        if (ds.length === 1) return [{ label: labelOf(ds[0], g, path), rows: pack(sub) }];
        return walk(sub, ds.slice(1), [...path, g]);
      });
      if (dims.length === 1) lanes = walk(inWin, dims, []);
      else {
        lanes = groupsOf[dims[0]]().flatMap((g) => {
          const sub = inWin.filter((i) => keyOf[dims[0]](i) === g.id);
          const inner = sub.length ? walk(sub, dims.slice(1), []) : [];
          return inner.length ? [{ header: `<span>${esc(g.name)}<span class="muted"> · ${sub.length} initiative${sub.length === 1 ? '' : 's'}</span></span>`, rows: [[]] }, ...inner] : [];
        });
      }
      headLabel = dims.map((k) => DIM_LABEL[k]).join(' › ');
    }
    lanes = lanes.filter((l) => l.rows.length);
    if (!lanes.some((l) => !l.header)) return `<div class="empty">No initiatives match these filters in this window.</div>`;

    return `<div class="tl-scroll"><div class="tl" id="tl">
      <div class="tl-row tl-head"><div class="tl-label"><span class="eyebrow">${esc(headLabel)}</span></div><div class="tl-track">${lines}${ticks}${today}</div></div>
      ${lanes.map((l) => l.header ? `<div class="tl-row tl-group"><div class="tl-label">${l.header}</div><div class="tl-track">${lines}${today}</div></div>` : `<div class="tl-row"><div class="tl-label">${l.label}</div><div class="tl-track">${lines}${today}
        ${l.rows.map((row) => `<div class="bar-row">${row.map((i) => bar(i, l.allMs)).join('')}</div>`).join('')}</div></div>`).join('')}
    </div></div>
    ${hidden ? `<p class="small muted">${hidden} initiative${hidden > 1 ? 's are' : ' is'} outside this window. Widen the window to see ${hidden > 1 ? 'them' : 'it'}.</p>` : ''}`;
  }

  /* ---------- horizons ---------- */
  function horizons(items) {
    const order = Object.keys(S.theme);
    return `<div class="horizons">${HORIZONS.map((h) => {
      const list = items.filter((i) => i.horizon === h.id).sort((a, b) => order.indexOf(a.theme) - order.indexOf(b.theme) || d(a.start) - d(b.start));
      return `<section class="hcol" aria-label="${h.id}"><header><h3>${h.id} <span class="count">${list.length}</span></h3><span class="small muted">${h.blurb}</span></header>
        ${list.map(card).join('') || '<span class="small muted">Nothing here.</span>'}</section>`;
    }).join('')}</div>`;
  }
  function card(i) {
    return `<button class="card" data-open="${esc(i.id)}" style="--hue:${S.hue[i.theme]}">
      <span class="row"><span class="mono">${esc(i.id)}</span>${pill(i.status)}</span>
      <span class="t">${esc(i.title)}</span>
      <span class="row small muted"><span class="tag"><i></i>${esc(S.theme[i.theme]?.name || '')}</span><span>${fmtMonth(i.start)} – ${fmtMonth(i.end)}</span></span>
      ${i.progress ? `<span class="mini"><span class="mini-bar"><i style="width:${i.progress.pct}%"></i><b style="left:${i.progress.expected}%" title="Expected by today"></b></span>${pctLabel(i.progress)}</span>` : ''}
      ${i.conflicts.length ? `<span class="flag">! Depends on ${i.conflicts.map((c) => esc(c.dep.id)).join(', ')} finishing first</span>` : ''}
    </button>`;
  }
  const pill = (s) => `<span class="pill"><span class="dot" style="--sc:var(${STATUS_VAR[s] || '--idle'})"></span>${esc(s)}</span>`;

  /* ---------- outcomes ---------- */
  function outcomes(items, r) {
    const themes = S.data.themes.filter((t) => !S.fThemes.length || S.fThemes.includes(t.id));
    const kpis = themes.map((t) => {
      const k = t.kpi || {};
      const span = k.target - k.baseline;
      const p = span ? Math.min(Math.max((k.current - k.baseline) / span, 0), 1) : 0;
      const n = items.filter((i) => i.theme === t.id).length;
      return `<div class="kpi" style="--hue:${S.hue[t.id]}">
        <div><h3>${esc(t.name)}</h3><span class="small muted">${esc(k.name || 'No KPI set')}</span></div>
        <div class="val">${esc(k.current ?? '—')} <small>${esc(k.unit || '')} now</small></div>
        <div class="track-bar" role="img" aria-label="${Math.round(p * 100)}% of the way from baseline to target"><i style="width:${p * 100}%"></i></div>
        <div class="ends"><span>Baseline ${esc(k.baseline ?? '—')}</span><span>${Math.round(p * 100)}% to target</span><span>Target ${esc(k.target ?? '—')}</span></div>
        <span class="small muted">${n} contributing initiative${n === 1 ? '' : 's'}${r.area ? ' from this area' : ''}</span>
      </div>`;
    }).join('');

    const areas = r.area ? [S.area[r.area]] : S.data.productAreas;
    const matrix = `<div class="matrix-wrap"><table><thead><tr><th>Product area</th>${themes.map((t) => `<th><span class="tag"><i style="--hue:${S.hue[t.id]}"></i>${esc(t.name)}</span></th>`).join('')}</tr></thead>
      <tbody>${areas.map((a) => `<tr><th><button class="link-btn" data-go="#/product/${esc(a.id)}">${esc(a.name)}</button></th>${themes.map((t) => {
        const cell = items.filter((i) => i.productArea === a.id && i.theme === t.id);
        return `<td>${cell.map((i) => `<button class="chip" data-open="${esc(i.id)}"><span class="key">${esc(i.id)}</span>${esc(i.title)}<br><span class="small muted">${fmtMonth(i.start)} – ${fmtMonth(i.end)}</span></button>`).join('') || '<span class="muted">—</span>'}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>`;

    const ids = new Set(items.map((i) => i.id));
    const gates = S.data.milestones.filter((m) => m.type === 'Review gate' && ids.has(m.initiative)).sort((a, b) => d(a.date) - d(b.date));
    const gateTable = gates.length ? `<div class="matrix-wrap"><table><thead><tr><th>Date</th><th>Review gate</th><th>Initiative</th><th>Theme</th></tr></thead><tbody>
      ${gates.map((m) => { const i = S.byId[m.initiative]; return `<tr><td class="mono">${fmt(m.date)}</td><td>${m.done ? '✓ ' : '◆ '}${esc(m.title)}</td>
        <td><button class="chip" data-open="${esc(i.id)}"><span class="key">${esc(i.id)}</span>${esc(i.title)}</button></td>
        <td><span class="tag"><i style="--hue:${S.hue[i.theme]}"></i>${esc(S.theme[i.theme]?.name || '')}</span></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty">No review gates in scope. Add milestones with type “Review gate” in MS Lists.</div>';

    return `<div class="stack">
      <h2 class="section-h">Outcome measures</h2><div class="kpis">${kpis}</div>
      <h2 class="section-h">Contribution by product area</h2>${matrix}
      <h2 class="section-h">Outcome review gates</h2>${gateTable}
    </div>`;
  }

  /* ---------- legend ---------- */
  function renderLegend() {
    $('#legend').hidden = S.view === 'risk';
    $('#legend').innerHTML = `
      <span><span class="sw c"></span>Commit</span><span><span class="sw p"></span>Plan</span><span><span class="sw e"></span>Explore</span>
      <span>Bar color = strategic theme</span>
      <span><span class="sw fill"></span>Darker fill = % of Jira issues done. <b style="color:var(--bad)">Red %</b> = more than ${BEHIND} pts behind schedule</span>
      ${STATUSES.map((s) => `<span class="tag"><span class="dot" style="--sc:var(${STATUS_VAR[s]})"></span>${s}</span>`).join('')}
      <span>◆ milestone · <span style="color:var(--accent)">◆</span> review gate</span>
      <span><b style="color:var(--bad)">!</b> dependency conflict</span>`;
  }

  /* ---------- initiative panel ---------- */
  function renderDrawer(r) {
    const i = r.open ? S.byId[r.open] : null;
    const drawer = $('#drawer');
    const wasOpen = !drawer.hidden;
    drawer.hidden = !i; $('#scrim').hidden = !i;
    if (!i) return;
    const area = S.area[i.productArea]; const theme = S.theme[i.theme];
    const jira = S.data.settings?.jiraBaseUrl;
    const age = Math.floor((TODAY - d(i.lastReviewed)) / DAY);
    const depLink = (id) => S.byId[id]
      ? `<button class="link-btn" data-open="${esc(id)}"><span class="mono">${esc(id)}</span> ${esc(S.byId[id].title)}</button> ${pill(S.byId[id].status)}`
      : `<span class="mono">${esc(id)}</span> <span class="flag">not found</span>`;

    drawer.innerHTML = `
      <button class="close" data-close>Close</button>
      <div><div class="eyebrow mono">${esc(i.id)}</div><h2 id="d-title">${esc(i.title)}</h2></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${pill(i.status)}<span class="pill">${esc(i.horizon)}</span></div>
      ${i.summary ? `<p style="margin:0">${esc(i.summary)}</p>` : ''}
      ${i.riskNote ? `<div class="risk"><b>Risk:</b> ${esc(i.riskNote)}</div>` : ''}
      <dl>
        <dt>Product area</dt><dd>${area ? (r.area === area.id ? esc(area.name) : `<button class="link-btn" data-go="#/product/${esc(area.id)}/${esc(i.id)}">${esc(area.name)} ›</button>`) : '—'}</dd>
        <dt>Theme</dt><dd><span class="tag"><i style="--hue:${S.hue[i.theme]}"></i>${esc(theme?.name || '—')}</span></dd>
        <dt>Owner</dt><dd>${esc(i.owner || '—')}</dd>
        <dt>Dates</dt><dd>${fmt(i.start)} – ${fmt(i.end)}</dd>
        <dt>Jira epic</dt><dd>${i.jiraEpic ? (jira ? `<a href="${esc(jira.replace(/\/$/, ''))}/browse/${encodeURIComponent(i.jiraEpic)}" target="_blank" rel="noopener">${esc(i.jiraEpic)} ↗</a>` : esc(i.jiraEpic)) : '<span class="muted">None linked</span>'}</dd>
        <dt>Last reviewed</dt><dd>${fmt(i.lastReviewed)}${age > STALE_DAYS ? ` <span class="flag">${age} days ago</span>` : ''}</dd>
      </dl>
      ${jiraSection(i)}
      <section><h3 class="section-h">Milestones</h3>
        <ul>${milestonesFor(i.id).map((m) => `<li><span class="mono" style="min-width:92px">${fmt(m.date)}</span><span>${m.done ? '✓' : m.type === 'Review gate' ? '◆' : '◇'} ${esc(m.title)} <span class="muted small">${esc(m.type)}</span></span></li>`).join('') || '<li class="muted">No milestones yet.</li>'}</ul></section>
      <section><h3 class="section-h">Depends on</h3>
        <ul>${i.dependsOn.map((id) => `<li style="flex-wrap:wrap">${depLink(id)}</li>`).join('') || '<li class="muted">Nothing.</li>'}</ul>
        ${i.conflicts.map((c) => `<p class="flag">! ${esc(c.text)}</p>`).join('')}</section>
      <section><h3 class="section-h">Blocks</h3>
        <ul>${i.blocks.map((id) => `<li style="flex-wrap:wrap">${depLink(id)}</li>`).join('') || '<li class="muted">Nothing.</li>'}</ul></section>`;
    if (!wasOpen) drawer.querySelector('[data-close]').focus();
  }

  function jiraSection(i) {
    const p = i.progress;
    if (!p) return `<section><h3 class="section-h">Jira progress</h3><p class="muted small" style="margin:0">${i.jiraEpic ? 'Progress for this epic isn\'t synced from Jira yet. Use the link above to see it in Jira.' : 'Add the Jira epic key to this initiative to link it here.'}</p></section>`;
    const todo = p.total - p.done - p.inProgress;
    const w = (n) => (n / p.total) * 100;
    const synced = S.data.jiraSyncedAt ? new Date(S.data.jiraSyncedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return `<section class="jira" style="--hue:${S.hue[i.theme]}"><h3 class="section-h">Jira progress · ${esc(i.jiraEpic)}</h3>
      <div class="jira-head"><span class="big${p.behind ? ' behind' : ''}">${p.pct}%</span><span class="muted">${p.done} of ${p.total} issues done<br>Expected by today: <b style="color:var(--fg)">${p.expected}%</b></span></div>
      <div class="stackbar" role="img" aria-label="${p.done} done, ${p.inProgress} in progress, ${todo} to do">
        <i class="s-done" style="width:${w(p.done)}%"></i><i class="s-ip" style="width:${w(p.inProgress)}%"></i>
        <b class="expected" style="left:${p.expected}%"><span>Expected</span></b>
      </div>
      <div class="jira-legend"><span><i class="s-done"></i>Done ${p.done}</span><span><i class="s-ip"></i>In progress ${p.inProgress}</span><span><i class="s-todo"></i>To do ${todo}</span>${p.blocked ? `<span class="flag">${p.blocked} blocked</span>` : ''}</div>
      <dl><dt>Planned end</dt><dd>${fmt(i.end)}</dd><dt>Jira forecast</dt><dd>${fmt(p.forecastEnd)}${p.late ? ` <span class="flag">${Math.round((d(p.forecastEnd) - d(i.end)) / DAY / 7)} weeks late</span>` : ''}</dd></dl>
      ${p.behind && i.status === 'On track' ? '<p class="flag" style="margin:0">! Status says on track, but progress is behind schedule.</p>' : ''}
      ${synced ? `<p class="small muted" style="margin:0">Synced from Jira ${esc(synced)}</p>` : ''}
    </section>`;
  }

  /* ---------- events ---------- */
  function wire() {
    document.addEventListener('click', (e) => {
      const r = route();
      const h = e.target.closest('[data-h-status],[data-h-key],[data-h-dim],[data-h-reset]');
      if (h) {
        const ds = h.dataset;
        if ('hStatus' in ds) { // from the portfolio bar: open the At risk tab on that status
          S.hStatus = S.view === 'risk' && S.hStatus === ds.hStatus ? '' : ds.hStatus; S.hKey = '';
          if (S.view !== 'risk') { S.view = 'risk'; store.set('view', S.view); }
          hideTip(); render(); $('.toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
        }
        else if ('hKey' in ds) S.hKey = S.hKey === ds.hKey ? '' : ds.hKey;
        else if ('hDim' in ds) { S.hDim = ds.hDim; S.hKey = ''; store.set('hdim', S.hDim); }
        else { S.hStatus = ''; S.hKey = ''; }
        hideTip(); render(); return;
      }
      const g = e.target.closest('[data-go]');
      if (g) { e.preventDefault(); go(g.dataset.go); return; }
      const o = e.target.closest('[data-open]');
      if (o) { go(openHash(r, o.dataset.open)); return; }
      if (e.target.closest('[data-close]') || e.target.id === 'scrim') go(baseHash(r));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) go(baseHash(route())); });
    window.addEventListener('popstate', () => { S.hash = location.hash || '#/'; render(); });
    window.addEventListener('hashchange', () => { S.hash = location.hash || '#/'; render(); });

    document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.view; store.set('view', S.view); render(); }));
    // multi-select dropdowns
    const MS = { 'f-group': 'groups', 'f-theme': 'fThemes', 'f-status': 'fStatuses' };
    const closeAll = (except) => document.querySelectorAll('.msel').forEach((m) => { if (m !== except) { m.querySelector('.msel-pop').hidden = true; m.querySelector('.msel-btn').setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('click', (e) => {
      const m = e.target.closest('.msel');
      closeAll(m);
      if (!m) return;
      if (e.target.closest('.msel-btn')) {
        const pop = m.querySelector('.msel-pop'); pop.hidden = !pop.hidden;
        m.querySelector('.msel-btn').setAttribute('aria-expanded', String(!pop.hidden));
      } else if (e.target.closest('[data-msel-clear]')) {
        m.querySelectorAll('input').forEach((x) => { x.checked = false; });
        m.dispatchEvent(new Event('change'));
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(null); });
    Object.entries(MS).forEach(([id, key]) => $('#' + id).addEventListener('change', () => {
      S[key] = [...$('#' + id).querySelectorAll('input:checked')].map((x) => x.value);
      if (key === 'groups') store.set('groups', S.groups.join(','));
      mselLabel($('#' + id)); render();
    }));
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-area-tab]');
      if (t) { S.areaTab = t.dataset.areaTab; store.set('areaTab', S.areaTab); renderAreas(); }
    });
    $('#f-window').addEventListener('change', (e) => { S.months = Number(e.target.value); store.set('months', S.months); render(); });

    // hover a bar: highlight what it depends on and what it blocks
    $('#view').addEventListener('mouseover', (e) => {
      const b = e.target.closest('.bar'); const tl = $('#tl'); if (!tl) return;
      tl.querySelectorAll('.bar').forEach((x) => x.classList.remove('hl', 'dim'));
      if (!b) return;
      const i = S.byId[b.dataset.id]; const rel = new Set([i.id, ...i.dependsOn, ...i.blocks]);
      if (rel.size === 1) return;
      tl.querySelectorAll('.bar').forEach((x) => x.classList.add(rel.has(x.dataset.id) ? 'hl' : 'dim'));
    });
    // chart tooltips: any element with data-tip
    const tip = $('#tip');
    document.addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.dataset.tip; tip.hidden = false;
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = e.clientY + 18 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18;
      tip.style.transform = `translate(${x}px, ${y}px)`;
    });
    $('#view').addEventListener('mouseleave', () => document.querySelectorAll('#tl .bar').forEach((x) => x.classList.remove('hl', 'dim')));
  }

  function hideTip() { $('#tip').hidden = true; }

  // Multi-select dropdown: a button that opens a checkbox list. Nothing checked = the empty label (e.g. "All").
  function msel(el, opts, sel, empty) {
    el.dataset.empty = empty;
    el.innerHTML = `<button type="button" class="msel-btn" aria-haspopup="true" aria-expanded="false"><span class="msel-txt"></span><span aria-hidden="true">▾</span></button>
      <div class="msel-pop" hidden>${opts.map(([v, l]) => `<label><input type="checkbox" value="${esc(v)}"${sel.includes(v) ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}
      <button type="button" class="link-btn small" data-msel-clear>Clear</button></div>`;
    mselLabel(el);
  }
  function mselLabel(el) {
    const on = [...el.querySelectorAll('input:checked')];
    const names = on.map((x) => x.nextElementSibling.textContent);
    el.querySelector('.msel-txt').textContent = !on.length ? el.dataset.empty
      : on.length === 1 || el.dataset.join ? names.join(el.dataset.join || '') : `${on.length} selected`;
  }

  function fillFilters() {
    S.fThemes = []; S.fStatuses = [];
    $('#f-group').dataset.join = ' › ';
    msel($('#f-group'), DIMS.map((k) => [k, DIM_LABEL[k] === 'Strategic theme' ? 'Theme' : DIM_LABEL[k]]), S.groups, 'Theme');
    msel($('#f-theme'), S.data.themes.map((t) => [t.id, t.name]), S.fThemes, 'All');
    msel($('#f-status'), STATUSES.map((s) => [s, s]), S.fStatuses, 'All');
    $('#f-window').value = String(S.months);
  }

  // Used by preview.js: show data from dropped workbooks without saving anything.
  window.RoadmapApp = {
    getData: () => S.base,
    setData(data, preview) {
      S.preview = preview || null;
      index(structuredClone(data)); fillFilters();
      if (preview?.area && S.area[preview.area]) S.hash = `#/product/${preview.area}`;
      render();
    },
  };

  load().then((data) => { S.base = data; index(structuredClone(data)); fillFilters(); wire(); render(); document.dispatchEvent(new Event('roadmap:ready')); })
    .catch((err) => { $('#view').innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
})();
