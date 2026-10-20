'use strict';
/* Homeserver-Manager — Frontend */

const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
};

let dash = null;          // last /api/dashboard payload
let pollTimer = null;

/* ===================== helpers ===================== */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showAuth(true); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

const fmtDateTime = ts => ts ? new Date(ts).toLocaleString(tLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString(tLocale(), { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtBytes = b => {
  if (b == null || isNaN(b)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return b.toFixed(b >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
};
const fmtUptime = sec => {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d > 0 ? t('uptime.dh', d, h) : h > 0 ? t('uptime.hm', h, m) : t('uptime.m', m);
};
const pct = v => v == null ? '—' : (v * 100).toFixed(v >= 0.995 || v === 0 ? 0 : 1) + ' %';

/* ===================== i18n (static DOM) ===================== */

// translate everything declared via data-i18n* attributes in index.html
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of document.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  applyTheme(localStorage.getItem('hsm-theme') || 'system'); // re-translate theme button title
}

/* ===================== theme ===================== */
// cycles: system → light → dark
const THEME_ICONS = { system: '◐', light: '☀', dark: '☾' };
function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem('hsm-theme', mode);
  const btn = $('#themeBtn');
  btn.textContent = THEME_ICONS[mode];
  btn.title = t('theme.prefix') + t('theme.' + mode);
}
function initTheme() {
  applyTheme(localStorage.getItem('hsm-theme') || 'system');
  $('#themeBtn').addEventListener('click', () => {
    const cur = localStorage.getItem('hsm-theme') || 'system';
    const next = { system: 'light', light: 'dark', dark: 'system' }[cur];
    applyTheme(next);
  });
}

/* ===================== auth ===================== */

function showAuth(loginMode) {
  $('#appView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  $('#authHint').textContent = loginMode ? t('auth.hint.login') : t('auth.hint.setup');
  $('#authSubmit').textContent = loginMode ? t('auth.login') : t('auth.setup');
  $('#authPassword2').classList.toggle('hidden', loginMode);
  $('#authForm').dataset.mode = loginMode ? 'login' : 'setup';
  $('#authPassword').focus();
}

function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 15000);
}

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const mode = e.target.dataset.mode;
  const pw = $('#authPassword').value;
  $('#authError').textContent = '';
  try {
    if (mode === 'setup') {
      if (pw !== $('#authPassword2').value) throw new Error(t('auth.mismatch'));
      await api('/api/setup', { method: 'POST', body: { password: pw } });
    } else {
      await api('/api/login', { method: 'POST', body: { password: pw } });
    }
    $('#authPassword').value = ''; $('#authPassword2').value = '';
    showApp();
  } catch (err) {
    $('#authError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  clearInterval(pollTimer);
  showAuth(true);
});

/* ===================== dashboard ===================== */

async function refresh() {
  try {
    dash = await api('/api/dashboard');
  } catch (e) {
    if (e.message !== 'unauthorized') toast(t('err.connLost'), true);
    return;
  }
  // the language is a server setting — follow it if it changed elsewhere
  const lang = dash.settings.language;
  if (lang && lang !== LANG) { setLang(lang); applyStaticI18n(); }
  if (dash.version) $('#footerVersion').textContent = ' · v' + dash.version;
  renderPublicIps();
  renderGlobalLinks();
  renderChart();
  renderServers();
}

function renderPublicIps() {
  const box = $('#publicIps');
  box.replaceChildren();
  const { v4, v6, v4ChangedAt, v6ChangedAt } = dash.publicIp;
  const chip = (tag, ip, changedAt) => el('span', { class: 'ip-chip' },
    el('span', { class: 'ip-tag' }, tag),
    ip || t('ip.unavailable'),
    el('span', { class: 'ip-tip' }, t('ip.lastChange', fmtDateTime(changedAt))),
  );
  box.append(chip('IPv4', v4, v4ChangedAt), chip('IPv6', v6, v6ChangedAt));
}

function renderGlobalLinks() {
  const box = $('#globalLinks');
  box.replaceChildren();
  if (!dash.globalLinks.length) {
    box.append(el('span', { class: 'empty-note' }, t('glinks.empty')));
    return;
  }
  for (const l of dash.globalLinks) {
    const a = el('a', { class: 'glink', href: normalizeUrl(l.url), target: '_blank', rel: 'noopener', title: l.note || l.url },
      l.alias,
      el('span', {
        class: 'glink-edit', title: t('common.edit'),
        onclick: ev => { ev.preventDefault(); ev.stopPropagation(); openGlobalLinkModal(l); },
      }, '✎'),
    );
    box.append(a);
  }
}

const normalizeUrl = u => /^https?:\/\//i.test(u) ? u : 'https://' + u;

/* ---------- availability chart (24h, one line per server) ---------- */

// fixed categorical slots (validated palette); beyond 8 servers fall back to muted
const seriesColor = i => i < 8 ? `var(--series-${i + 1})` : 'var(--muted)';

function renderChart() {
  const box = $('#availChart');
  const legend = $('#chartLegend');
  box.replaceChildren();
  legend.replaceChildren();
  const servers = dash.servers;
  $('#chartSub').textContent = servers.length
    ? t('chart.sub', servers.length, dash.settings.pingIntervalSec)
    : '';
  if (!servers.length) {
    box.append(el('div', { class: 'empty-note', style: 'padding:30px 0;text-align:center' }, t('chart.empty')));
    return;
  }

  const N = servers[0].ping.buckets.length;
  const W = 1000, H = 190, padL = 42, padR = 10, padT = 12, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = i => padL + (i / (N - 1)) * iw;
  const y = v => padT + (1 - v) * ih;
  const now = Date.now(), windowMs = dash.windowMs;
  const bucketTime = i => now - windowMs + (i + 0.5) * (windowMs / N);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const S = (tag, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // grid + y labels at 0/50/100 %
  for (const v of [0, 0.5, 1]) {
    svg.append(S('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'grid-line' }));
    const t2 = S('text', { x: padL - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' });
    t2.textContent = (v * 100) + ' %';
    svg.append(t2);
  }
  // x labels: every 6 h
  for (let hAgo = 24; hAgo >= 0; hAgo -= 6) {
    const i = N - 1 - (hAgo / 24) * (N - 1);
    const t2 = S('text', { x: x(i), y: H - 6, 'text-anchor': hAgo === 24 ? 'start' : hAgo === 0 ? 'end' : 'middle', class: 'axis-label' });
    t2.textContent = hAgo === 0 ? t('chart.now') : `-${hAgo} h`;
    svg.append(t2);
  }

  // one line per server, over non-null segments; isolated points get a dot
  servers.forEach((srv, si) => {
    const values = srv.ping.buckets;
    const color = seriesColor(si);
    let line = '', segStart = null;
    const dots = [];
    const flushSeg = end => {
      if (segStart === null) return;
      if (end === segStart) dots.push(segStart);
      segStart = null;
    };
    for (let i = 0; i < N; i++) {
      const v = values[i];
      if (v === null) { flushSeg(i - 1); continue; }
      if (segStart === null) { segStart = i; line += ` M ${x(i)} ${y(v)}`; }
      else line += ` L ${x(i)} ${y(v)}`;
    }
    flushSeg(N - 1);
    svg.append(S('path', { d: line, class: 'series-line', style: `stroke:${color}` }));
    for (const i of dots) svg.append(S('circle', { cx: x(i), cy: y(values[i]), r: 4, class: 'series-dot', style: `fill:${color}` }));
  });

  const cross = S('line', { class: 'crosshair', y1: padT, y2: padT + ih, x1: -10, x2: -10 });
  svg.append(cross);
  box.append(svg);

  // legend: color chip + server name (identity never via color alone)
  for (let si = 0; si < servers.length; si++) {
    legend.append(el('span', { class: 'lg-item' },
      el('span', { class: 'lg-chip', style: `background:${seriesColor(si)}` }),
      servers[si].name));
  }

  const tip = el('div', { class: 'chart-tooltip hidden' });
  box.append(tip);
  svg.addEventListener('mousemove', ev => {
    const rect = svg.getBoundingClientRect();
    const relX = (ev.clientX - rect.left) / rect.width * W;
    const i = Math.round((relX - padL) / iw * (N - 1));
    const rows = i >= 0 && i < N
      ? servers.map((s, si) => ({ name: s.name, v: s.ping.buckets[i], color: seriesColor(si) })).filter(r => r.v !== null)
      : [];
    if (!rows.length) { tip.classList.add('hidden'); cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); return; }
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    tip.replaceChildren(
      el('div', { style: 'margin-bottom:3px' }, fmtTime(bucketTime(i)) + t('chart.timeSuffix')),
      ...rows.map(r => el('div', { class: 'tt-row' },
        el('span', { class: 'tt-chip', style: `background:${r.color}` }),
        r.name,
        el('span', { class: 'tt-val' }, pct(r.v)))),
    );
    tip.classList.remove('hidden');
    tip.style.left = (x(i) / W * rect.width) + 'px';
    tip.style.top = Math.max(tip.offsetHeight + 14, ev.clientY - rect.top) + 'px';
  });
  svg.addEventListener('mouseleave', () => { tip.classList.add('hidden'); cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); });
}

/* ---------- server cards ---------- */

function statusDot(up) {
  return el('span', {
    class: 'dot ' + (up === true ? 'dot-good' : up === false ? 'dot-crit' : 'dot-none'),
    title: up === true ? t('status.up') : up === false ? t('status.down') : t('status.none'),
  });
}

function uptimeStrip(buckets) {
  const strip = el('div', { class: 'uptime-strip', title: t('strip.title') });
  for (const v of buckets) {
    const seg = el('i', { class: 'seg' });
    if (v === null) { seg.style.background = 'var(--grid)'; seg.style.height = '35%'; }
    else if (v >= 0.99) { seg.style.background = 'var(--status-good)'; seg.style.height = '100%'; }
    else if (v >= 0.5) { seg.style.background = 'var(--status-warn)'; seg.style.height = '100%'; }
    else { seg.style.background = 'var(--status-crit)'; seg.style.height = '100%'; }
    strip.append(seg);
  }
  return strip;
}

// ctx = { srv, svc } enables the favorite toggle on the chip
function linkChip(link, srvTag, ctx) {
  const check = link.check;
  const dotColor = check == null ? 'var(--status-none)' : check.ok ? 'var(--status-good)' : 'var(--status-crit)';
  const dotTitle = check == null ? t('chip.unchecked') : (check.ok ? t('status.up') : t('status.down')) + t('chip.checked', fmtTime(check.checkedAt));
  const isPort = link.kind === 'port';
  const star = ctx ? el('span', {
    class: 'chip-fav' + (link.favorite ? ' on' : ''),
    title: t('common.favorite'),
    onclick: ev => { ev.preventDefault(); ev.stopPropagation(); toggleLinkFav(ctx.srv, ctx.svc, link); },
  }, link.favorite ? '★' : '☆') : null;
  const portTitle = isPort ? 'Port ' + link.port + ' (' + (link.protocol || 'tcp').toUpperCase() + ')\n' : '';
  const content = [
    el('span', { class: 'mini-dot', style: `background:${dotColor}` }),
    link.alias,
    srvTag ? el('span', { class: 'srv-tag' }, srvTag) : null,
    el('span', { class: 'scope-tag' }, isPort ? 'PORT' : link.scope === 'local' ? 'LOCAL' : 'ONLINE'),
    star,
  ];
  const cls = 'link-chip' + (link.favorite ? ' fav' : '');
  return isPort
    ? el('span', { class: cls, title: portTitle + dotTitle }, content)
    : el('a', { class: cls, href: link.resolvedUrl, target: '_blank', rel: 'noopener', title: link.resolvedUrl + '\n' + dotTitle }, content);
}

async function toggleLinkFav(srv, svc, link) {
  const links = svc.links.map(l => ({ ...l, favorite: l.id === link.id ? !l.favorite : !!l.favorite }));
  try {
    await api(`/api/servers/${srv.id}/services/${svc.id}`, { method: 'PUT', body: { links } });
    refresh();
  } catch (e) { toast(e.message, true); }
}

async function togglePinned(srv) {
  try {
    await api('/api/servers/' + srv.id, { method: 'PUT', body: { pinned: !srv.pinned } });
    refresh();
  } catch (e) { toast(e.message, true); }
}

// favorites first, otherwise keep configured order
const byFavorite = list => [...list].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

function serviceRow(srv, svc) {
  return el('div', { class: 'svc-row' },
    el('div', { class: 'svc-head' },
      el('span', { class: 'svc-name' }, svc.name),
      el('button', { class: 'icon-btn', title: t('svc.edit'), onclick: () => openServiceModal(srv, svc) }, '✎'),
    ),
    svc.links.length ? el('div', { class: 'svc-links' }, byFavorite(svc.links).map(l => linkChip(l, null, { srv, svc }))) : null,
    svc.note ? el('span', { class: 'svc-note' }, svc.note) : null,
  );
}

function serverCard(srv, { inGroup = false } = {}) {
  const r = srv.resolved || {};
  const meta = el('div', { class: 'server-meta' },
    el('span', {}, el('span', { class: 'k' }, 'IPv4 '), el('span', { class: 'v' }, r.ipv4 || '—')),
    el('span', {}, el('span', { class: 'k' }, 'IPv6 '), el('span', { class: 'v' }, r.ipv6 ? shortV6(r.ipv6) : '—')),
    srv.ping.rtt != null ? el('span', {}, el('span', { class: 'k' }, 'Ping '), el('span', { class: 'v' }, srv.ping.rtt.toFixed(1) + ' ms')) : null,
    el('span', {}, el('span', { class: 'k' }, '24h '), el('span', { class: 'v' }, pct(srv.ping.uptime24h))),
  );

  // in a group the services live merged in the group header
  const services = el('div', { class: 'svc-list' });
  if (!inGroup) for (const svc of byFavorite(srv.services)) services.append(serviceRow(srv, svc));
  services.append(el('div', {},
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openServiceModal(srv, null) }, '+ Service')));

  return el('div', { class: 'server-card' + (srv.pinned ? ' pinned' : '') },
    el('div', { class: 'server-head' },
      statusDot(srv.ping.up),
      el('div', {},
        el('div', { class: 'server-name' }, srv.name),
        el('div', { class: 'server-host' }, srv.hostname),
      ),
      el('div', { class: 'server-head-actions' },
        el('button', {
          class: 'icon-btn pin-btn' + (srv.pinned ? ' on' : ''),
          title: srv.pinned ? t('card.unpin') : t('card.pin'),
          onclick: () => togglePinned(srv),
        }, srv.pinned ? '⚑' : '⚐'),
        el('button', { class: 'icon-btn', title: t('common.edit'), onclick: () => openServerModal(srv) }, '✎'),
      ),
    ),
    meta,
    el('div', {}, uptimeStrip(srv.ping.buckets),
      el('div', { class: 'uptime-label' }, el('span', {}, t('card.24hAgo')), el('span', {}, t('chart.now')))),
    srv.note ? el('div', { class: 'server-note' }, srv.note) : null,
    services,
    el('div', { class: 'card-footer' },
      el('button', { class: 'btn btn-sm', onclick: () => openDetailModal(srv) }, t('card.details')),
      el('button', { class: 'btn btn-sm', disabled: srv.ssh ? null : '', title: srv.ssh ? '' : t('card.needSsh'), onclick: () => openTerminal(srv) }, '⌨ Terminal'),
    ),
  );
}

// merged row inside a group: all same-named services across the group's servers
function mergedServiceRow(m) {
  const parts = [];
  for (const { srv, svc } of m.entries) {
    for (const l of byFavorite(svc.links)) parts.push(linkChip(l, srv.name, { srv, svc }));
    parts.push(el('button', {
      class: 'icon-btn', style: 'font-size:11px;padding:2px 5px',
      title: t('group.editOn', svc.name, srv.name),
      onclick: () => openServiceModal(srv, svc),
    }, '✎'));
  }
  return el('div', { class: 'svc-row' },
    el('div', { class: 'svc-head' },
      el('span', { class: 'svc-name' }, m.name),
      m.entries.length > 1 ? el('span', { class: 'group-count' }, t('group.onServers', m.entries.length)) : null,
    ),
    el('div', { class: 'svc-links' }, parts),
  );
}

function renderGroup(name, members) {
  const merged = new Map();
  for (const srv of members) {
    for (const svc of srv.services || []) {
      const key = svc.name.trim().toLowerCase();
      if (!merged.has(key)) merged.set(key, { name: svc.name, entries: [] });
      merged.get(key).entries.push({ srv, svc });
    }
  }
  const rows = [...merged.values()];
  const sorted = [...members].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return el('div', { class: 'server-group' },
    el('div', { class: 'group-head' },
      el('span', { class: 'group-name' }, name),
      el('span', { class: 'group-count' }, t('group.count', members.length)),
    ),
    el('div', { class: 'group-services' },
      el('div', { class: 'gs-title' }, t('group.services')),
      rows.length ? rows.map(mergedServiceRow) : el('span', { class: 'empty-note' }, t('group.empty')),
    ),
    el('div', { class: 'group-grid' }, sorted.map(srv => serverCard(srv, { inGroup: true }))),
  );
}

function renderServers() {
  const grid = $('#serverGrid');
  grid.replaceChildren();
  if (!dash.servers.length) {
    grid.append(el('div', { class: 'empty-note' }, t('servers.empty')));
    return;
  }
  // top-level entries: groups (emitted at first member) and ungrouped servers;
  // pinned entries come first (groups count as pinned if any member is pinned)
  const seenGroups = new Set();
  const entries = [];
  for (const srv of dash.servers) {
    const g = (srv.group || '').trim();
    const gKey = g.toLowerCase();
    if (g) {
      if (seenGroups.has(gKey)) continue;
      seenGroups.add(gKey);
      const members = dash.servers.filter(s => (s.group || '').trim().toLowerCase() === gKey);
      entries.push({ pinned: members.some(m => m.pinned), node: () => renderGroup(g, members) });
    } else {
      entries.push({ pinned: !!srv.pinned, node: () => serverCard(srv) });
    }
  }
  entries.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  for (const e of entries) grid.append(e.node());
}

const shortV6 = ip => ip.length > 22 ? ip.slice(0, 20) + '…' : ip;

/* ===================== modals ===================== */

function openModal(content, { wide = false } = {}) {
  closeModal();
  const backdrop = el('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target === backdrop) closeModal(); } },
    el('div', { class: 'modal' + (wide ? ' modal-lg' : '') }, content));
  $('#modalRoot').append(backdrop);
  document.addEventListener('keydown', escClose);
  return backdrop;
}
function closeModal() {
  $('#modalRoot').replaceChildren();
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

const field = (label, input, hint) => el('div', { class: 'field' },
  el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null);
const textInput = (attrs = {}) => el('input', { type: 'text', ...attrs });
const checkRow = (input, label) => el('label', { class: 'check-row' }, input, label);

// wraps a password input or textarea; content is hidden until the eye is clicked
function secretField(input) {
  const isTextarea = input.tagName === 'TEXTAREA';
  if (isTextarea) input.classList.add('masked');
  let shown = false;
  const btn = el('button', { type: 'button', class: 'eye-btn', title: t('secret.show') }, '👁');
  btn.addEventListener('click', () => {
    shown = !shown;
    if (isTextarea) input.classList.toggle('masked', !shown);
    else input.type = shown ? 'text' : 'password';
    btn.title = shown ? t('secret.hide') : t('secret.show');
    btn.style.opacity = shown ? '1' : '';
  });
  return el('div', { class: 'secret-wrap' }, input, btn);
}

/* ---------- server create/edit (incl. SSH) ---------- */

function openServerModal(srv) {
  const isNew = !srv;
  const name = textInput({ value: srv?.name || '', placeholder: t('srv.namePh') });
  const hostname = textInput({ value: srv?.hostname || '', placeholder: 'nas.fritz.box / 192.168.1.10' });
  const NEW_GROUP = '__new__';
  // dedupe case-insensitively, keeping the first-seen casing as display name
  const groupNames = [...new Map((dash?.servers || [])
    .map(s => (s.group || '').trim()).filter(Boolean)
    .map(g => [g.toLowerCase(), g])).values()].sort((a, b) => a.localeCompare(b));
  const curGroup = (srv?.group || '').trim();
  const matchedGroup = groupNames.find(g => g.toLowerCase() === curGroup.toLowerCase());
  const groupSelect = el('select', {},
    el('option', { value: '' }, t('srv.groupNone')),
    ...groupNames.map(g => el('option', { value: g }, g)),
    el('option', { value: NEW_GROUP }, t('srv.groupNew')));
  groupSelect.value = curGroup && !matchedGroup ? NEW_GROUP : (matchedGroup || '');
  const groupNewIn = textInput({ value: curGroup && !matchedGroup ? curGroup : '', placeholder: t('srv.groupPh') });
  const groupNewField = field(t('srv.groupNewLabel'), groupNewIn);
  const syncGroupUi = () => groupNewField.classList.toggle('hidden', groupSelect.value !== NEW_GROUP);
  groupSelect.addEventListener('change', syncGroupUi);
  syncGroupUi();
  const note = el('textarea', { placeholder: t('notePh') }); note.value = srv?.note || '';
  const sshUser = textInput({ value: srv?.ssh?.username || '', placeholder: 'root', autocomplete: 'off' });
  const sshPort = el('input', { type: 'number', value: srv?.ssh?.port || 22, min: 1, max: 65535 });
  const sshAuth = el('select', {},
    el('option', { value: 'password' }, t('field.password')),
    el('option', { value: 'key' }, t('ssh.key')));
  sshAuth.value = srv?.ssh?.auth || 'password';
  const sshSecret = el('textarea', {
    placeholder: srv?.ssh?.hasSecret ? t('ssh.keepPh') : t('ssh.secretPh'),
    autocomplete: 'new-password', spellcheck: 'false',
  });
  const sshPassphrase = el('input', { type: 'password', placeholder: t('ssh.passphrasePh'), autocomplete: 'new-password' });

  // secret label + passphrase visibility follow the auth method
  const secretLabel = el('label', {});
  const secretF = el('div', { class: 'field' }, secretLabel, secretField(sshSecret),
    el('div', { class: 'hint' }, t('ssh.encrypted')));
  const passField = field(t('ssh.passphrase'), secretField(sshPassphrase));
  const syncAuthUi = () => {
    const isKey = sshAuth.value === 'key';
    secretLabel.textContent = isKey ? t('ssh.key') : t('field.password');
    passField.classList.toggle('hidden', !isKey);
  };
  sshAuth.addEventListener('change', syncAuthUi);
  syncAuthUi();

  const sshBody = () => sshUser.value.trim() ? {
    username: sshUser.value, port: sshPort.value, auth: sshAuth.value,
    secret: sshSecret.value || undefined,
    passphrase: sshPassphrase.value || undefined,
  } : null;

  // only re-verify over SSH when something relevant to the connection actually changed —
  // avoids a connection attempt on every unrelated edit (e.g. renaming the server)
  const initialConn = { hostname: srv?.hostname || '', username: srv?.ssh?.username || '', port: String(srv?.ssh?.port || 22), auth: srv?.ssh?.auth || 'password' };
  const connChanged = () => hostname.value.trim() !== initialConn.hostname
    || sshUser.value.trim() !== initialConn.username
    || String(sshPort.value) !== initialConn.port
    || sshAuth.value !== initialConn.auth
    || !!sshSecret.value || !!sshPassphrase.value;

  const testBtn = el('button', { class: 'btn btn-sm' }, t('ssh.test'));
  const testSsh = async () => {
    testBtn.disabled = true; testBtn.textContent = t('ssh.testing');
    try {
      await api('/api/ssh-test', {
        method: 'POST',
        body: { serverId: srv?.id, hostname: hostname.value, ssh: sshBody() },
      });
      toast(t('ssh.ok'));
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    } finally {
      testBtn.disabled = false; testBtn.textContent = t('ssh.test');
    }
  };
  testBtn.addEventListener('click', testSsh);

  const forgetHostKeyBtn = srv?.ssh ? el('button', {
    class: 'btn btn-sm', title: t('ssh.forgetHostKeyHint'),
    onclick: async () => {
      if (!confirm(t('ssh.forgetHostKeyConfirm'))) return;
      try {
        await api(`/api/servers/${srv.id}/ssh-hostkey`, { method: 'DELETE' });
        toast(t('ssh.hostKeyForgotten'));
      } catch (e) { toast(e.message, true); }
    },
  }, t('ssh.forgetHostKey')) : null;

  const save = async () => {
    const ssh = sshBody();
    // credentials are verified before they are saved, but only when the connection
    // details actually changed — an unrelated edit shouldn't force a new SSH round-trip
    if (ssh && (ssh.secret || srv?.ssh?.hasSecret) && connChanged()) {
      const ok = await testSsh();
      if (!ok && !confirm(t('ssh.failSave'))) return;
    }
    const group = groupSelect.value === NEW_GROUP ? groupNewIn.value.trim() : groupSelect.value;
    const body = { name: name.value, hostname: hostname.value, note: note.value, group, ssh };
    try {
      if (isNew) await api('/api/servers', { method: 'POST', body });
      else await api('/api/servers/' + srv.id, { method: 'PUT', body });
      closeModal(); toast(isNew ? t('srv.created') : t('srv.saved'));
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  openModal(el('div', {},
    el('h3', {}, isNew ? t('srv.new') : t('srv.edit')),
    field(t('field.name'), name),
    field(t('srv.hostLabel'), hostname, t('srv.hostHint')),
    field(t('srv.group'), groupSelect, t('srv.groupHint')),
    groupNewField,
    field(t('field.note'), note),
    el('fieldset', { class: 'group' },
      el('legend', {}, t('ssh.legend')),
      el('div', { class: 'field-row' },
        field(t('field.user'), sshUser), field('Port', sshPort), field('Auth', sshAuth)),
      secretF,
      passField,
      el('div', { style: 'display:flex;gap:10px' }, testBtn, forgetHostKeyBtn),
    ),
    el('div', { class: 'modal-actions' },
      !isNew ? el('button', {
        class: 'btn btn-danger', onclick: async () => {
          if (!confirm(t('srv.delConfirm', srv.name))) return;
          await api('/api/servers/' + srv.id, { method: 'DELETE' });
          closeModal(); toast(t('srv.deleted')); refresh();
        },
      }, t('common.delete')) : null,
      el('button', { class: 'btn', onclick: closeModal }, t('common.cancel')),
      el('button', { class: 'btn btn-primary', onclick: save }, t('common.save')),
    ),
  ));
  name.focus();
}

/* ---------- service create/edit with link rows ---------- */

function openServiceModal(srv, svc) {
  const isNew = !svc;
  const name = textInput({ value: svc?.name || '', placeholder: t('svc.namePh') });
  const note = el('textarea', { placeholder: t('notePh') }); note.value = svc?.note || '';
  const monitorCb = el('input', { type: 'checkbox' });
  monitorCb.checked = svc ? svc.monitorAvail !== false : true;
  const linkRows = el('div', {});

  const addRow = (l = {}) => {
    const kind = el('select', { class: 'le-kind' },
      el('option', { value: 'url' }, 'Link'),
      el('option', { value: 'port' }, 'Port'));
    kind.value = l.kind === 'port' ? 'port' : 'url';
    const alias = textInput({ class: 'le-alias', value: l.alias || '', placeholder: 'Alias' });
    const url = textInput({ class: 'le-url', value: (l.kind === 'port' ? l.port : l.url) || '' });
    const scope = el('select', {},
      el('option', { value: 'local' }, 'local'),
      el('option', { value: 'online' }, 'online'));
    scope.value = l.scope || 'local';
    const protocol = el('select', { class: 'le-protocol hidden' },
      el('option', { value: 'tcp' }, 'TCP'),
      el('option', { value: 'http' }, 'HTTP'),
      el('option', { value: 'https' }, 'HTTPS'));
    protocol.value = l.protocol || 'tcp';
    let favorite = !!l.favorite;
    const favBtn = el('button', { type: 'button', class: 'le-fav' + (favorite ? ' on' : ''), title: t('common.favorite') }, favorite ? '★' : '☆');
    favBtn.addEventListener('click', () => {
      favorite = !favorite;
      favBtn.textContent = favorite ? '★' : '☆';
      favBtn.classList.toggle('on', favorite);
    });
    const syncKindUi = () => {
      const isPort = kind.value === 'port';
      url.placeholder = isPort ? t('svc.portPh') : t('svc.urlPh');
      scope.classList.toggle('hidden', isPort);
      protocol.classList.toggle('hidden', !isPort);
    };
    kind.addEventListener('change', () => {
      // the raw value means something different per kind (":9090" vs. plain "9090") —
      // reconcile it instead of silently carrying over a string that fails to parse
      const isPort = kind.value === 'port';
      if (isPort) url.value = url.value.replace(/\D/g, '');
      else if (/^\d+$/.test(url.value)) url.value = ':' + url.value;
      syncKindUi();
    });
    syncKindUi();
    const row = el('div', { class: 'link-editor-row' }, favBtn, kind, alias, url, scope, protocol,
      el('button', { class: 'le-del', title: t('svc.removeEntry'), onclick: () => row.remove() }, '✕'));
    row._get = () => kind.value === 'port'
      ? { id: l.id, kind: 'port', alias: alias.value, port: url.value, protocol: protocol.value, favorite }
      : { id: l.id, kind: 'url', alias: alias.value, url: url.value, scope: scope.value, favorite };
    linkRows.append(row);
  };
  for (const l of svc?.links || []) addRow(l);
  if (isNew) addRow();

  const save = async () => {
    const body = {
      name: name.value, note: note.value, monitorAvail: monitorCb.checked,
      links: [...linkRows.children].map(r => r._get()).filter(l => (l.url || l.port || '').trim()),
    };
    try {
      if (isNew) await api(`/api/servers/${srv.id}/services`, { method: 'POST', body });
      else await api(`/api/servers/${srv.id}/services/${svc.id}`, { method: 'PUT', body });
      closeModal(); toast(t('svc.saved')); refresh();
    } catch (e) { toast(e.message, true); }
  };

  openModal(el('div', {},
    el('h3', {}, isNew ? t('svc.new', srv.name) : t('svc.edit')),
    field(t('field.name'), name),
    field(t('field.note'), note),
    checkRow(monitorCb, t('svc.monitor')),
    el('fieldset', { class: 'group' },
      el('legend', {}, t('svc.linksLegend')),
      linkRows,
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => addRow() }, t('svc.addEntry')),
      el('div', { class: 'hint', style: 'margin-top:8px' }, t('svc.linkHint', srv.hostname)),
    ),
    el('div', { class: 'modal-actions' },
      !isNew ? el('button', {
        class: 'btn btn-danger', onclick: async () => {
          if (!confirm(t('svc.delConfirm', svc.name))) return;
          await api(`/api/servers/${srv.id}/services/${svc.id}`, { method: 'DELETE' });
          closeModal(); toast(t('svc.deleted')); refresh();
        },
      }, t('common.delete')) : null,
      el('button', { class: 'btn', onclick: closeModal }, t('common.cancel')),
      el('button', { class: 'btn btn-primary', onclick: save }, t('common.save')),
    ),
  ), { wide: true });
  name.focus();
}

/* ---------- global link ---------- */

function openGlobalLinkModal(link) {
  const isNew = !link;
  const alias = textInput({ value: link?.alias || '', placeholder: t('gl.aliasPh') });
  const url = textInput({ value: link?.url || '', placeholder: 'https://dash.cloudflare.com' });
  const note = textInput({ value: link?.note || '', placeholder: t('gl.notePh') });
  const save = async () => {
    const body = { alias: alias.value, url: url.value, note: note.value };
    try {
      if (isNew) await api('/api/global-links', { method: 'POST', body });
      else await api('/api/global-links/' + link.id, { method: 'PUT', body });
      closeModal(); toast(t('gl.saved')); refresh();
    } catch (e) { toast(e.message, true); }
  };
  openModal(el('div', {},
    el('h3', {}, isNew ? t('gl.new') : t('gl.edit')),
    field(t('gl.alias'), alias),
    field(t('gl.url'), url),
    field(t('gl.note'), note),
    el('div', { class: 'modal-actions' },
      !isNew ? el('button', {
        class: 'btn btn-danger', onclick: async () => {
          await api('/api/global-links/' + link.id, { method: 'DELETE' });
          closeModal(); refresh();
        },
      }, t('common.delete')) : null,
      el('button', { class: 'btn', onclick: closeModal }, t('common.cancel')),
      el('button', { class: 'btn btn-primary', onclick: save }, t('common.save')),
    ),
  ));
  alias.focus();
}

/* ---------- server detail: stats, DNS, power ---------- */

function openDetailModal(srv) {
  const statsBox = el('div', {}, el('p', { class: 'empty-note' },
    srv.ssh ? t('det.loading') : t('det.noSsh')));

  const meterClass = p => p >= 90 ? 'crit' : p >= 75 ? 'warn' : '';
  const tile = (label, value, sub, meterPct) => el('div', { class: 'stat-tile' },
    el('div', { class: 'st-label' }, label),
    el('div', { class: 'st-value' }, value),
    sub ? el('div', { class: 'st-sub' }, sub) : null,
    meterPct != null ? el('div', { class: 'meter' }, el('i', { class: meterClass(meterPct), style: `width:${Math.min(100, meterPct)}%` })) : null,
  );

  const loadStats = async () => {
    if (!srv.ssh) return;
    try {
      const st = await api(`/api/servers/${srv.id}/stats`);
      const memPct = st.mem ? st.mem.used / st.mem.total * 100 : null;
      const diskPct = st.disk ? parseInt(st.disk.pcent) : null;
      statsBox.replaceChildren(el('div', { class: 'stats-grid' },
        tile('SYSTEM', st.os || st.kernel || '—', st.kernel && st.os ? st.kernel + ' · ' + st.arch : st.arch),
        tile('UPTIME', fmtUptime(st.uptimeSec)),
        tile('LOAD', st.load || '—', st.cpus ? t('det.cores', st.cpus) + (st.cpuModel ? ' · ' + st.cpuModel : '') : null),
        st.mem ? tile('RAM', `${fmtBytes(st.mem.used)} / ${fmtBytes(st.mem.total)}`, t('det.available', fmtBytes(st.mem.available)), memPct) : null,
        st.disk ? tile('DISK /', `${fmtBytes(st.disk.used)} / ${fmtBytes(st.disk.total)}`, t('det.used', st.disk.pcent), diskPct) : null,
        st.tempC != null ? tile(t('det.temp'), st.tempC.toFixed(1) + ' °C') : null,
      ));
      if (st.disks && st.disks.length > 1) {
        const table = el('table', { class: 'dns-table' },
          el('tr', {}, el('th', {}, t('det.mount')), el('th', {}, t('det.size')), el('th', {}, t('det.usedCol'))),
          st.disks.map(d => el('tr', {},
            el('td', {}, d.mount), el('td', {}, fmtBytes(d.total)), el('td', {}, fmtBytes(d.used) + ' (' + d.pcent + ')'))));
        statsBox.append(table);
      }
    } catch (e) {
      statsBox.replaceChildren(el('p', { class: 'empty-note' }, t('det.statsErr', e.message)));
    }
  };

  const power = async action => {
    const verb = action === 'reboot' ? t('det.rebootVerb') : t('det.shutdownVerb');
    if (!confirm(t('det.powerConfirm', srv.name, srv.hostname, verb))) return;
    try {
      await api(`/api/servers/${srv.id}/power`, { method: 'POST', body: { action } });
      toast(t('det.powerSent', action));
      closeModal();
    } catch (e) { toast(e.message, true); }
  };

  const r = srv.resolved || {};
  openModal(el('div', {},
    el('h3', {}, srv.name),
    el('div', { class: 'server-meta', style: 'margin-bottom:14px' },
      el('span', {}, el('span', { class: 'k' }, 'Hostname '), el('span', { class: 'v' }, srv.hostname)),
      el('span', {}, el('span', { class: 'k' }, 'IPv4 '), el('span', { class: 'v' }, r.ipv4 || '—')),
      el('span', {}, el('span', { class: 'k' }, 'IPv6 '), el('span', { class: 'v' }, r.ipv6 || '—')),
      r.rdns ? el('span', {}, el('span', { class: 'k' }, 'rDNS '), el('span', { class: 'v' }, r.rdns)) : null,
    ),
    el('fieldset', { class: 'group' }, el('legend', {}, t('det.liveStats')), statsBox,
      srv.ssh ? el('div', { style: 'margin-top:10px' },
        el('button', { class: 'btn btn-sm', onclick: loadStats }, t('det.refresh'))) : null),
    srv.ssh ? el('fieldset', { class: 'group' }, el('legend', {}, t('det.control')),
      el('div', { style: 'display:flex;gap:10px' },
        el('button', { class: 'btn btn-accent', onclick: () => power('reboot') }, t('det.reboot')),
        el('button', { class: 'btn btn-danger', onclick: () => power('shutdown') }, t('det.shutdown')),
        el('button', { class: 'btn', onclick: () => { closeModal(); openTerminal(srv); } }, t('det.openTerm')),
      )) : null,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => { closeModal(); openServerModal(srv); } }, t('common.edit')),
      el('button', { class: 'btn btn-primary', onclick: closeModal }, t('common.close')),
    ),
  ), { wide: true });

  loadStats();
}

/* ---------- DNS tool ---------- */

$('#dnsToolBtn').addEventListener('click', () => {
  const input = textInput({ placeholder: 'example.org' });
  const result = el('div', {});
  const run = async () => {
    if (!input.value.trim()) return;
    result.replaceChildren(el('p', { class: 'empty-note' }, t('dns.running')));
    try {
      const d = await api('/api/dns?domain=' + encodeURIComponent(input.value.trim()));
      const rows = Object.entries(d.records);
      result.replaceChildren(rows.length
        ? el('table', { class: 'dns-table' },
            el('tr', {}, el('th', {}, t('dns.type')), el('th', {}, t('dns.value'))),
            rows.map(([type, vals]) => el('tr', {},
              el('td', { class: 'rt' }, type),
              el('td', {}, vals.map(v => el('div', {}, v))))))
        : el('p', { class: 'empty-note' }, t('dns.none')));
    } catch (e) { result.replaceChildren(el('p', { class: 'empty-note' }, t('dns.err', e.message))); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  openModal(el('div', {},
    el('h3', {}, t('dns.title')),
    el('div', { style: 'display:flex;gap:10px' },
      el('div', { style: 'flex:1' }, input),
      el('button', { class: 'btn btn-primary', onclick: run }, t('dns.run'))),
    result,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: closeModal }, t('common.close'))),
  ), { wide: true });
  input.focus();
});

/* ---------- settings ---------- */

$('#settingsBtn').addEventListener('click', () => {
  const s = dash?.settings || {};
  const port = el('input', { type: 'number', value: s.port, min: 1, max: 65535 });
  const pingI = el('input', { type: 'number', value: s.pingIntervalSec, min: 10 });
  const linkI = el('input', { type: 'number', value: s.linkCheckIntervalSec, min: 30 });
  const ipI = el('input', { type: 'number', value: s.publicIpIntervalSec, min: 60 });
  const langSel = el('select', {},
    el('option', { value: 'de' }, 'Deutsch'),
    el('option', { value: 'en' }, 'English'));
  langSel.value = s.language || LANG;
  const pwCur = el('input', { type: 'password', autocomplete: 'current-password' });
  const pwNew = el('input', { type: 'password', autocomplete: 'new-password' });
  const importInput = el('input', { type: 'file', accept: '.json,application/json' });

  const m = s.smtp || {};
  const smtpHost = textInput({ value: m.host || '', placeholder: 'smtp.example.com' });
  const smtpPort = el('input', { type: 'number', value: m.port || 587, min: 1, max: 65535 });
  const smtpSecurity = el('select', {},
    el('option', { value: 'none' }, t('set.encNone')),
    el('option', { value: 'starttls' }, 'STARTTLS'),
    el('option', { value: 'tls' }, 'SSL/TLS'));
  smtpSecurity.value = m.security || 'starttls';
  const SMTP_DEFAULT_PORT = { none: 25, starttls: 587, tls: 465 };
  smtpSecurity.addEventListener('change', () => { smtpPort.value = SMTP_DEFAULT_PORT[smtpSecurity.value]; });
  const smtpUser = textInput({ value: m.user || '', placeholder: 'user@example.com', autocomplete: 'off' });
  const smtpPass = el('input', {
    type: 'password', autocomplete: 'new-password',
    placeholder: m.hasPass ? t('ssh.keepPh') : t('set.smtpPassPh'),
  });
  const smtpFrom = textInput({ value: m.from || '', placeholder: 'homeserver@example.com' });
  const n = s.notify || {};
  const notifyOn = el('input', { type: 'checkbox' }); notifyOn.checked = !!n.enabled;
  const notifyTo = el('input', { type: 'email', value: n.recipient || '', placeholder: 'me@example.com' });

  const settingsBody = () => ({
    port: port.value, pingIntervalSec: pingI.value, linkCheckIntervalSec: linkI.value, publicIpIntervalSec: ipI.value,
    language: langSel.value,
    smtp: {
      host: smtpHost.value, port: smtpPort.value, security: smtpSecurity.value,
      user: smtpUser.value, from: smtpFrom.value,
      pass: smtpPass.value || undefined, // empty = keep stored password
    },
    notify: { enabled: notifyOn.checked, recipient: notifyTo.value },
  });

  const testMailBtn = el('button', { class: 'btn btn-sm' }, t('set.testMail'));
  testMailBtn.addEventListener('click', async () => {
    testMailBtn.disabled = true; testMailBtn.textContent = t('set.sending');
    try {
      // persist current form values first, then send through the stored config
      await api('/api/settings', { method: 'PUT', body: settingsBody() });
      await api('/api/test-mail', { method: 'POST', body: { recipient: notifyTo.value || undefined } });
      toast(t('set.testSent'));
    } catch (e) { toast(e.message, true); }
    finally { testMailBtn.disabled = false; testMailBtn.textContent = t('set.testMail'); }
  });

  const saveSettings = async () => {
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: settingsBody(),
      });
      closeModal();
      if (langSel.value !== LANG) { setLang(langSel.value); applyStaticI18n(); }
      if (r.portChanged) {
        toast(t('set.portChanged', r.port));
        setTimeout(() => { location.port = r.port; }, 1500);
      } else toast(t('set.saved'));
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  const changePw = async () => {
    try {
      await api('/api/password', { method: 'POST', body: { current: pwCur.value, next: pwNew.value } });
      pwCur.value = pwNew.value = '';
      toast(t('set.pwChanged'));
    } catch (e) { toast(e.message, true); }
  };

  const doImport = async () => {
    const f = importInput.files[0];
    if (!f) return toast(t('set.importFile'), true);
    try {
      const json = JSON.parse(await f.text());
      if (!confirm(t('set.importConfirm'))) return;
      const r = await api('/api/import', { method: 'POST', body: json });
      closeModal(); toast(t('set.imported', r.servers)); refresh();
    } catch (e) { toast(t('set.importErr', e.message), true); }
  };

  const panes = {
    allgemein: el('div', { class: 'settings-pane' },
      el('div', { class: 'field-row' },
        field(t('set.port'), port, t('set.portHint')),
        field(t('set.pingI'), pingI)),
      el('div', { class: 'field-row' },
        field(t('set.linkI'), linkI),
        field(t('set.ipI'), ipI)),
      field(t('set.language'), langSel),
    ),
    email: el('div', { class: 'settings-pane hidden' },
      el('fieldset', { class: 'group' }, el('legend', {}, t('set.smtp')),
        el('div', { class: 'field-row' },
          field(t('set.host'), smtpHost),
          field(t('set.smtpPort'), smtpPort),
          field(t('set.encryption'), smtpSecurity)),
        el('div', { class: 'field-row' },
          field(t('field.user'), smtpUser),
          field(t('field.password'), secretField(smtpPass))),
        field(t('set.from'), smtpFrom),
      ),
      el('fieldset', { class: 'group' }, el('legend', {}, t('set.notify')),
        checkRow(notifyOn, t('set.notifyOn')),
        field(t('set.recipient'), notifyTo),
        testMailBtn,
      ),
    ),
    passwort: el('div', { class: 'settings-pane hidden' },
      el('div', { class: 'field-row' },
        field(t('set.pwCur'), pwCur),
        field(t('set.pwNew'), pwNew, t('set.pwHint'))),
      el('button', { class: 'btn btn-primary btn-sm', onclick: changePw }, t('set.pwChange')),
    ),
    daten: el('div', { class: 'settings-pane hidden' },
      el('fieldset', { class: 'group' }, el('legend', {}, t('set.export')),
        el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
          el('a', { class: 'btn btn-sm', href: '/api/export', download: '' }, t('set.exportNo')),
          el('a', {
            class: 'btn btn-sm', href: '/api/export?secrets=1', download: '',
            title: t('set.exportWarn'),
          }, t('set.exportWith')),
        ),
      ),
      el('fieldset', { class: 'group' }, el('legend', {}, t('set.import')),
        field(t('set.importLabel'), importInput, t('set.importHint')),
        el('button', { class: 'btn btn-sm', onclick: doImport }, t('set.importBtn')),
      ),
    ),
  };

  const saveBtn = el('button', { class: 'btn btn-primary', onclick: saveSettings }, t('common.save'));
  const TABS = [['allgemein', t('set.general')], ['email', t('set.email')], ['passwort', t('set.password')], ['daten', t('set.data')]];
  const tabBtns = {};
  const select = id => {
    for (const [tid] of TABS) {
      tabBtns[tid].classList.toggle('active', tid === id);
      panes[tid].classList.toggle('hidden', tid !== id);
    }
    // save applies to Allgemein + E-Mail; the other tabs have their own buttons
    saveBtn.classList.toggle('hidden', id === 'passwort' || id === 'daten');
  };
  const tabBar = el('div', { class: 'tabs' },
    TABS.map(([id, label]) => tabBtns[id] = el('button', { class: 'tab', onclick: () => select(id) }, label)));
  select('allgemein');

  openModal(el('div', {},
    el('h3', {}, t('set.title')),
    tabBar,
    panes.allgemein, panes.email, panes.passwort, panes.daten,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: closeModal }, t('common.close')),
      saveBtn),
  ));
});

/* ===================== terminal ===================== */

let term = null, termWs = null, fitAddon = null;

function openTerminal(srv) {
  if (!srv.ssh) return toast(t('card.needSsh'), true);
  $('#termTitle').textContent = `${srv.ssh.username}@${srv.hostname}`;
  $('#termOverlay').classList.remove('hidden');

  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 14,
    theme: { background: '#101014', foreground: '#e6e6ef', cursor: '#e6e6ef' },
    cursorBlink: true,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('#termContainer'));
  fitAddon.fit();
  term.writeln('\x1b[90m' + t('term.connecting', srv.hostname) + '\x1b[0m');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  termWs = new WebSocket(`${proto}://${location.host}/ws/terminal?server=${srv.id}`);
  termWs.binaryType = 'arraybuffer';

  termWs.onmessage = ev => {
    if (typeof ev.data === 'string' && ev.data.startsWith('{')) {
      try {
        const j = JSON.parse(ev.data);
        if (j.type === 'error') { term.writeln('\r\n\x1b[31m' + j.message + '\x1b[0m'); return; }
        if (j.type === 'ready') { fitAddon.fit(); sendResize(); term.focus(); return; }
      } catch {}
    }
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  };
  termWs.onclose = () => { if (term) term.writeln('\r\n\x1b[90m' + t('term.closed') + '\x1b[0m'); };
  term.onData(data => {
    if (termWs?.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data }));
  });
  const sendResize = () => {
    if (termWs?.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  window.addEventListener('resize', onTermResize);
  function onTermResize() { if (fitAddon) { fitAddon.fit(); sendResize(); } }
  $('#termOverlay')._cleanup = () => window.removeEventListener('resize', onTermResize);
}

$('#termCloseBtn').addEventListener('click', closeTerminal);
function closeTerminal() {
  $('#termOverlay').classList.add('hidden');
  $('#termOverlay')._cleanup?.();
  try { termWs?.close(); } catch {}
  try { term?.dispose(); } catch {}
  term = null; termWs = null; fitAddon = null;
  $('#termContainer').replaceChildren();
}

/* ===================== boot ===================== */

$('#addServerBtn').addEventListener('click', () => openServerModal(null));
$('#addGlobalLinkBtn').addEventListener('click', () => openGlobalLinkModal(null));

initTheme();
applyStaticI18n();
(async () => {
  try {
    const st = await fetch('/api/status').then(r => r.json());
    if (!st.setup) showAuth(false);
    else if (!st.authenticated) showAuth(true);
    else showApp();
  } catch {
    showAuth(true);
  }
})();
