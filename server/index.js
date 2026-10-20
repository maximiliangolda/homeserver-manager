'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Store, encrypt, decrypt } = require('./store');
const auth = require('./auth');
const { Monitor, resolveLinkUrl } = require('./monitor');
const sshmgr = require('./sshmgr');
const dnsinfo = require('./dnsinfo');
const mailer = require('./mailer');
const { version: APP_VERSION } = require('../package.json');

const store = new Store();
const monitor = new Monitor(store);
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use('/api', auth.middleware(store));

const asyncH = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));

// user-facing message in the configured dashboard language
const L = (de, en) => store.config.settings.language === 'en' ? en : de;

// ---------- auth ----------
app.get('/api/status', (req, res) => {
  res.json({
    setup: !!store.config.auth,
    authenticated: !!store.config.auth && auth.validSession(auth.sessionFromReq(req)),
  });
});

function setSessionCookie(res) {
  const token = auth.createSession();
  res.setHeader('Set-Cookie',
    `hsm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${14 * 24 * 3600}`);
}

app.post('/api/setup', (req, res) => {
  if (store.config.auth) return res.status(400).json({ error: L('Bereits eingerichtet', 'Already set up') });
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: L('Passwort braucht mindestens 8 Zeichen', 'Password needs at least 8 characters') });
  store.config.auth = auth.hashPassword(password);
  store.saveConfig();
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  if (!auth.loginAllowed()) return res.status(429).json({ error: L('Zu viele Versuche — kurz warten', 'Too many attempts — wait a moment') });
  const ok = auth.verifyPassword((req.body || {}).password || '', store.config.auth);
  auth.noteLoginResult(ok);
  if (!ok) return res.status(401).json({ error: L('Falsches Passwort', 'Wrong password') });
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(auth.sessionFromReq(req));
  res.setHeader('Set-Cookie', 'hsm_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!auth.verifyPassword(current || '', store.config.auth))
    return res.status(401).json({ error: L('Aktuelles Passwort falsch', 'Current password is wrong') });
  if (!next || next.length < 8) return res.status(400).json({ error: L('Neues Passwort braucht mindestens 8 Zeichen', 'New password needs at least 8 characters') });
  store.config.auth = auth.hashPassword(next);
  store.saveConfig();
  auth.destroyAllSessions();
  setSessionCookie(res);
  res.json({ ok: true });
});

// ---------- dashboard ----------
const BUCKETS = 96, WINDOW_MS = 24 * 3600 * 1000; // 24h in 15-min buckets

function pingSummary(serverId) {
  const arr = store.state.pings[serverId] || [];
  const now = Date.now();
  const last = arr[arr.length - 1] || null;
  const buckets = Array.from({ length: BUCKETS }, () => ({ ok: 0, total: 0 }));
  let ok24 = 0, total24 = 0;
  for (const p of arr) {
    const age = now - p.t;
    if (age > WINDOW_MS) continue;
    const idx = Math.min(BUCKETS - 1, Math.floor((WINDOW_MS - age) / (WINDOW_MS / BUCKETS)));
    buckets[idx].total++;
    if (p.ok) { buckets[idx].ok++; ok24++; }
    total24++;
  }
  return {
    up: last ? last.ok : null,
    rtt: last && last.ok ? last.rtt : null,
    lastCheck: last ? last.t : null,
    uptime24h: total24 ? ok24 / total24 : null,
    buckets: buckets.map(b => (b.total ? b.ok / b.total : null)),
  };
}

function publicServer(srv) {
  const { ssh, ...rest } = srv;
  return {
    ...rest,
    ssh: ssh ? { username: ssh.username, port: ssh.port || 22, auth: ssh.auth || 'password', hasSecret: !!ssh.secret } : null,
    resolved: store.state.resolved[srv.id] || null,
    ping: pingSummary(srv.id),
    services: (srv.services || []).map(svc => ({
      ...svc,
      links: (svc.links || []).map(l => ({
        ...l,
        resolvedUrl: l.kind === 'port' ? null : resolveLinkUrl(l, srv),
        check: store.state.links[l.id] || null,
      })),
    })),
  };
}

// settings without the encrypted SMTP password
function publicSettings() {
  const { smtp, ...rest } = store.config.settings;
  return { ...rest, smtp: { ...smtp, pass: undefined, hasPass: !!smtp.pass } };
}

app.get('/api/dashboard', (req, res) => {
  res.json({
    settings: publicSettings(),
    publicIp: store.state.publicIp,
    servers: store.config.servers.map(publicServer),
    globalLinks: store.config.globalLinks,
    windowMs: WINDOW_MS,
    version: APP_VERSION,
  });
});

// ---------- servers ----------
function applySsh(srv, body) {
  if (body.ssh === null) { srv.ssh = null; return; }
  if (!body.ssh) return;
  const cur = srv.ssh || {};
  srv.ssh = {
    username: (body.ssh.username || '').trim(),
    port: parseInt(body.ssh.port, 10) || 22,
    auth: body.ssh.auth === 'key' ? 'key' : 'password',
    secret: body.ssh.secret ? encrypt(body.ssh.secret) : cur.secret || null,
    passphrase: body.ssh.passphrase ? encrypt(body.ssh.passphrase) : cur.passphrase || null,
  };
}

app.post('/api/servers', asyncH(async (req, res) => {
  const { name, hostname, note, group, pinned } = req.body || {};
  if (!name || !hostname) return res.status(400).json({ error: L('Name und Hostname sind Pflicht', 'Name and hostname are required') });
  const srv = {
    id: store.id(), name: name.trim(), hostname: hostname.trim(), note: note || '',
    group: (group || '').trim(), pinned: !!pinned, ssh: null, services: [],
  };
  applySsh(srv, req.body);
  store.config.servers.push(srv);
  store.saveConfig();
  monitor.resolveServer(srv).catch(() => {});
  monitor.pingAll().catch(() => {});
  res.json(publicServer(srv));
}));

app.put('/api/servers/:id', asyncH(async (req, res) => {
  const srv = store.findServer(req.params.id);
  if (!srv) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  const b = req.body || {};
  const hostChanged = b.hostname && b.hostname.trim() !== srv.hostname;
  if (b.name) srv.name = b.name.trim();
  if (b.hostname) srv.hostname = b.hostname.trim();
  if (b.note !== undefined) srv.note = b.note;
  if (b.group !== undefined) srv.group = (b.group || '').trim();
  if (b.pinned !== undefined) srv.pinned = !!b.pinned;
  applySsh(srv, b);
  // a changed hostname may point at a different physical host — the old
  // pinned SSH host key would otherwise wrongly reject the new one
  if (hostChanged) delete store.state.sshHostKeys[srv.id];
  store.saveConfig();
  if (hostChanged) { monitor.resolveServer(srv).catch(() => {}); store.markStateDirty(); }
  res.json(publicServer(srv));
}));

app.delete('/api/servers/:id', (req, res) => {
  const i = store.config.servers.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  store.config.servers.splice(i, 1);
  store.saveConfig();
  store.gcState();
  res.json({ ok: true });
});

// ---------- services & links ----------
function sanitizeLinks(links) {
  return (Array.isArray(links) ? links : []).map(l => {
    const kind = l.kind === 'port' ? 'port' : 'url';
    const port = parseInt(l.port, 10) || null;
    return {
      id: l.id || store.id(),
      kind,
      alias: (l.alias || '').trim() || (kind === 'port' ? 'Port ' + port : (l.url || '').trim()),
      url: kind === 'url' ? (l.url || '').trim() : '',
      port: kind === 'port' ? port : null,
      protocol: kind === 'port' ? (['tcp', 'http', 'https'].includes(l.protocol) ? l.protocol : 'tcp') : null,
      scope: l.scope === 'local' ? 'local' : 'online',
      favorite: !!l.favorite,
    };
  }).filter(l => l.kind === 'port' ? (l.port >= 1 && l.port <= 65535) : l.url);
}

app.post('/api/servers/:id/services', (req, res) => {
  const srv = store.findServer(req.params.id);
  if (!srv) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  const { name, note, links, monitorAvail } = req.body || {};
  if (!name) return res.status(400).json({ error: L('Name ist Pflicht', 'Name is required') });
  const svc = {
    id: store.id(), name: name.trim(), note: note || '', links: sanitizeLinks(links),
    monitorAvail: monitorAvail !== false,
  };
  (srv.services = srv.services || []).push(svc);
  store.saveConfig();
  monitor.checkLinks().catch(() => {});
  res.json(svc);
});

app.put('/api/servers/:id/services/:sid', (req, res) => {
  const srv = store.findServer(req.params.id);
  const svc = srv && (srv.services || []).find(s => s.id === req.params.sid);
  if (!svc) return res.status(404).json({ error: L('Service nicht gefunden', 'Service not found') });
  const b = req.body || {};
  if (b.name) svc.name = b.name.trim();
  if (b.note !== undefined) svc.note = b.note;
  if (b.links !== undefined) svc.links = sanitizeLinks(b.links);
  if (b.monitorAvail !== undefined) svc.monitorAvail = !!b.monitorAvail;
  store.saveConfig();
  store.gcState();
  monitor.checkLinks().catch(() => {});
  res.json(svc);
});

app.delete('/api/servers/:id/services/:sid', (req, res) => {
  const srv = store.findServer(req.params.id);
  if (!srv) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  srv.services = (srv.services || []).filter(s => s.id !== req.params.sid);
  store.saveConfig();
  store.gcState();
  res.json({ ok: true });
});

// ---------- global links ----------
app.post('/api/global-links', (req, res) => {
  const { alias, url, note } = req.body || {};
  if (!alias || !url) return res.status(400).json({ error: L('Alias und Link sind Pflicht', 'Alias and link are required') });
  const link = { id: store.id(), alias: alias.trim(), url: url.trim(), note: note || '' };
  store.config.globalLinks.push(link);
  store.saveConfig();
  res.json(link);
});

app.put('/api/global-links/:id', (req, res) => {
  const link = store.config.globalLinks.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: L('Link nicht gefunden', 'Link not found') });
  const b = req.body || {};
  if (b.alias) link.alias = b.alias.trim();
  if (b.url) link.url = b.url.trim();
  if (b.note !== undefined) link.note = b.note;
  store.saveConfig();
  res.json(link);
});

app.delete('/api/global-links/:id', (req, res) => {
  store.config.globalLinks = store.config.globalLinks.filter(l => l.id !== req.params.id);
  store.saveConfig();
  res.json({ ok: true });
});

// ---------- SSH: test, stats, power ----------
// Tests credentials without saving them. Falls back to the stored secret
// of an existing server when the form left the secret unchanged.
app.post('/api/ssh-test', asyncH(async (req, res) => {
  const b = req.body || {};
  const sshIn = b.ssh || {};
  if (!b.hostname || !sshIn.username) return res.status(400).json({ error: L('Hostname und Benutzer sind Pflicht', 'Hostname and user are required') });
  const existing = b.serverId ? store.findServer(b.serverId) : null;
  const cur = existing?.ssh || {};
  const testSrv = {
    id: existing?.id || null,
    hostname: b.hostname.trim(),
    ssh: {
      username: sshIn.username.trim(),
      port: parseInt(sshIn.port, 10) || 22,
      auth: sshIn.auth === 'key' ? 'key' : 'password',
      secret: sshIn.secret ? encrypt(sshIn.secret) : cur.secret || null,
      passphrase: sshIn.passphrase ? encrypt(sshIn.passphrase) : cur.passphrase || null,
    },
  };
  if (!testSrv.ssh.secret) return res.status(400).json({ error: L('Kein Passwort bzw. Key angegeben', 'No password or key provided') });
  try {
    res.json(await sshmgr.testConnection(store, testSrv, store.config.settings.language));
  } catch (e) {
    res.status(400).json({ error: L('SSH-Verbindung fehlgeschlagen: ', 'SSH connection failed: ') + e.message });
  }
}));

app.delete('/api/servers/:id/ssh-hostkey', (req, res) => {
  const srv = store.findServer(req.params.id);
  if (!srv) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  delete store.state.sshHostKeys[srv.id];
  store.markStateDirty();
  res.json({ ok: true });
});

app.get('/api/servers/:id/stats', asyncH(async (req, res) => {
  const srv = store.findServer(req.params.id);
  if (!srv) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  res.json(await sshmgr.fetchStats(store, srv, store.config.settings.language));
}));

app.post('/api/servers/:id/power', asyncH(async (req, res) => {
  const srv = store.findServer(req.params.id);
  if (!srv) return res.status(404).json({ error: L('Server nicht gefunden', 'Server not found') });
  res.json(await sshmgr.powerAction(store, srv, (req.body || {}).action, store.config.settings.language));
}));

// ---------- DNS ----------
app.get('/api/dns', asyncH(async (req, res) => {
  res.json(await dnsinfo.lookupAll(req.query.domain, store.config.settings.language));
}));

// ---------- settings, export/import ----------
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const s = store.config.settings;
  // validate all numeric fields up front so a single bad value can't silently
  // fall back to the old one — and doesn't leave other fields half-applied
  const numOrThrow = (v, min, max, label) => {
    const n = parseInt(v, 10);
    if (isNaN(n)) throw new Error(L(`Ungültiger Wert für "${label}"`, `Invalid value for "${label}"`));
    return Math.min(max, Math.max(min, n));
  };
  let port, pingIntervalSec, linkCheckIntervalSec, publicIpIntervalSec, smtpPort;
  try {
    if (b.port !== undefined) port = numOrThrow(b.port, 1, 65535, L('Port', 'Port'));
    if (b.pingIntervalSec !== undefined) pingIntervalSec = numOrThrow(b.pingIntervalSec, 10, 3600, L('Ping-Intervall', 'Ping interval'));
    if (b.linkCheckIntervalSec !== undefined) linkCheckIntervalSec = numOrThrow(b.linkCheckIntervalSec, 30, 3600, L('Link-Intervall', 'Link interval'));
    if (b.publicIpIntervalSec !== undefined) publicIpIntervalSec = numOrThrow(b.publicIpIntervalSec, 60, 86400, L('Öffentliche-IP-Intervall', 'Public IP interval'));
    if (b.smtp?.port !== undefined) smtpPort = numOrThrow(b.smtp.port, 1, 65535, L('SMTP-Port', 'SMTP port'));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (port !== undefined) s.port = port;
  if (pingIntervalSec !== undefined) s.pingIntervalSec = pingIntervalSec;
  if (linkCheckIntervalSec !== undefined) s.linkCheckIntervalSec = linkCheckIntervalSec;
  if (publicIpIntervalSec !== undefined) s.publicIpIntervalSec = publicIpIntervalSec;
  if (b.language !== undefined) s.language = b.language === 'en' ? 'en' : 'de';
  if (b.smtp) {
    const m = b.smtp;
    if (m.host !== undefined) s.smtp.host = String(m.host).trim();
    if (smtpPort !== undefined) s.smtp.port = smtpPort;
    if (m.security !== undefined) s.smtp.security = ['none', 'starttls', 'tls'].includes(m.security) ? m.security : 'starttls';
    if (m.user !== undefined) s.smtp.user = String(m.user).trim();
    if (m.from !== undefined) s.smtp.from = String(m.from).trim();
    if (m.pass) s.smtp.pass = encrypt(m.pass); // empty/undefined = keep stored password
    else if (m.pass === null) s.smtp.pass = null;
  }
  if (b.notify) {
    if (b.notify.enabled !== undefined) s.notify.enabled = !!b.notify.enabled;
    if (b.notify.recipient !== undefined) s.notify.recipient = String(b.notify.recipient).trim();
  }
  store.saveConfig();
  monitor.restart();
  const portChanged = server.address() && server.address().port !== s.port;
  res.json({ ok: true, portChanged, port: s.port });
  if (portChanged) setTimeout(() => rebind(s.port), 300);
});

app.post('/api/test-mail', asyncH(async (req, res) => {
  try {
    res.json(await mailer.sendTestMail(store.config.settings, (req.body || {}).recipient));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.get('/api/export', (req, res) => {
  const includeSecrets = req.query.secrets === '1';
  const out = {
    _type: 'homeserver-manager-config',
    _version: 1,
    exportedAt: new Date().toISOString(),
    settings: publicSettings(), // SMTP password never leaves the server

    servers: store.config.servers.map(srv => ({
      ...srv,
      ssh: srv.ssh ? {
        username: srv.ssh.username, port: srv.ssh.port, auth: srv.ssh.auth,
        ...(includeSecrets ? { secret: decrypt(srv.ssh.secret), passphrase: decrypt(srv.ssh.passphrase) } : {}),
      } : null,
    })),
    globalLinks: store.config.globalLinks,
  };
  res.setHeader('Content-Disposition', `attachment; filename="homeserver-manager-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(out);
});

app.post('/api/import', (req, res) => {
  const b = req.body || {};
  if (b._type !== 'homeserver-manager-config' || !Array.isArray(b.servers))
    return res.status(400).json({ error: L('Keine gültige Homeserver-Manager-Konfiguration', 'Not a valid Homeserver-Manager configuration') });
  const cur = store.config.settings;
  const inSmtp = { ...(b.settings || {}).smtp };
  delete inSmtp.pass; delete inSmtp.hasPass;
  store.config.settings = {
    ...cur, ...b.settings,
    port: cur.port,
    smtp: { ...cur.smtp, ...inSmtp, pass: cur.smtp.pass }, // keep stored SMTP password
    notify: { ...cur.notify, ...(b.settings || {}).notify },
  };
  store.config.servers = b.servers.map(srv => ({
    id: srv.id || store.id(),
    name: srv.name || 'Server',
    hostname: srv.hostname || '',
    note: srv.note || '',
    group: (srv.group || '').trim(),
    pinned: !!srv.pinned,
    ssh: srv.ssh && srv.ssh.username ? {
      username: srv.ssh.username,
      port: srv.ssh.port || 22,
      auth: srv.ssh.auth === 'key' ? 'key' : 'password',
      secret: srv.ssh.secret ? encrypt(srv.ssh.secret) : null,
      passphrase: srv.ssh.passphrase ? encrypt(srv.ssh.passphrase) : null,
    } : null,
    services: (srv.services || []).map(svc => ({
      id: svc.id || store.id(),
      name: svc.name || 'Service',
      note: svc.note || '',
      monitorAvail: svc.monitorAvail !== false,
      links: sanitizeLinks(svc.links),
    })),
  }));
  store.config.globalLinks = (b.globalLinks || []).map(l => ({
    id: l.id || store.id(), alias: l.alias || l.url, url: l.url, note: l.note || '',
  })).filter(l => l.url);
  store.saveConfig();
  store.gcState();
  monitor.restart();
  res.json({ ok: true, servers: store.config.servers.length });
});

// ---------- static frontend ----------
app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- server + websocket terminal ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws/terminal') return socket.destroy();
  if (!auth.validSession(auth.sessionFromReq(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const srv = store.findServer(url.searchParams.get('server'));
  if (!srv) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => sshmgr.attachTerminal(ws, store, srv, store.config.settings.language));
});

function rebind(port) {
  server.close(() => {
    server.listen(port, () => console.log(`Homeserver-Manager läuft jetzt auf Port ${port}`));
  });
  // force-close keep-alive connections so close() completes
  server.closeAllConnections?.();
}

process.on('SIGINT', () => { store.flushState(); process.exit(0); });
process.on('SIGTERM', () => { store.flushState(); process.exit(0); });

server.listen(store.config.settings.port, () => {
  console.log(`Homeserver-Manager läuft auf http://localhost:${store.config.settings.port}`);
  monitor.start();
});
