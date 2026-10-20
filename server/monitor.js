'use strict';
// Background monitoring: ICMP pings per server, HTTP checks per link,
// DNS resolution of server hostnames, public IP watcher.
const { execFile } = require('child_process');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const net = require('net');
const mailer = require('./mailer');

function L(store, de, en) { return store.config.settings.language === 'en' ? en : de; }

function pingHost(host) {
  return new Promise(resolve => {
    execFile('ping', ['-c', '1', '-W', '2', host], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, rtt: null });
      const m = /time=([\d.]+) ?ms/.exec(stdout);
      resolve({ ok: true, rtt: m ? parseFloat(m[1]) : null });
    });
  });
}

// Resolve a link definition to a concrete URL.
// Links starting with "/" or ":" get the server hostname prefixed.
function resolveLinkUrl(link, server) {
  let url = (link.url || '').trim();
  if (server && (url.startsWith('/') || url.startsWith(':'))) {
    url = 'http://' + server.hostname + url;
  }
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url;
}

function checkUrl(url) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, {
        method: 'HEAD',
        timeout: 6000,
        rejectUnauthorized: false, // self-signed certs are normal on home servers
        headers: { 'user-agent': 'Homeserver-Manager/1.0 (availability check)' },
      }, res => {
        res.resume();
        // HEAD not allowed still proves the service answers
        done({ ok: res.statusCode < 500, status: res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); done({ ok: false, status: null }); });
      req.on('error', () => done({ ok: false, status: null }));
      req.end();
    } catch {
      done({ ok: false, status: null });
    }
  });
}

// TCP connect check for port-type links
function checkPort(host, port) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    const sock = net.connect({ host, port, timeout: 5000 });
    sock.on('connect', () => { sock.destroy(); done({ ok: true, status: null }); });
    sock.on('timeout', () => { sock.destroy(); done({ ok: false, status: null }); });
    sock.on('error', () => done({ ok: false, status: null }));
  });
}

async function fetchText(url, family) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000, family }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve(body.trim()));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

class Monitor {
  constructor(store) {
    this.store = store;
    this.timers = [];
  }

  start() {
    this.stop();
    const s = this.store.config.settings;
    const every = (fn, sec) => {
      fn().catch(() => {});
      const t = setInterval(() => fn().catch(() => {}), Math.max(10, sec) * 1000);
      t.unref();
      this.timers.push(t);
    };
    every(() => this.pingAll(), s.pingIntervalSec);
    every(() => this.checkLinks(), s.linkCheckIntervalSec);
    every(() => this.updatePublicIp(), s.publicIpIntervalSec);
    every(() => this.resolveAll(), 600); // re-resolve hostnames every 10 min
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  restart() { this.start(); }

  async pingAll() {
    await Promise.all(this.store.config.servers.map(async srv => {
      const r = await pingHost(srv.hostname);
      this.store.addPing(srv.id, r.ok, r.rtt);
      this.trackAvailability('servers', srv.id, r.ok, {
        kind: 'server', name: srv.name, hostname: srv.hostname,
        detail: r.ok ? null : L(this.store, 'Ping ohne Antwort', 'Ping did not respond'),
      });
    }));
  }

  // Debounced up/down tracking; sends a mail after 2 consecutive failures
  // and a recovery mail once the target answers again.
  trackAvailability(bucket, id, ok, mailInfo) {
    const settings = this.store.config.settings;
    const states = this.store.state.notify[bucket];
    const st = states[id] || (states[id] = { fails: 0, notifiedDown: false });
    if (ok) {
      const recovered = st.notifiedDown;
      st.fails = 0;
      st.notifiedDown = false;
      if (recovered && mailer.notifyActive(settings))
        mailer.sendStatusMail(settings, { ...mailInfo, down: false })
          .catch(e => console.error('E-Mail-Versand fehlgeschlagen:', e.message));
    } else {
      st.fails++;
      if (st.fails >= 2 && !st.notifiedDown) {
        st.notifiedDown = true;
        if (mailer.notifyActive(settings))
          mailer.sendStatusMail(settings, { ...mailInfo, down: true })
            .catch(e => console.error('E-Mail-Versand fehlgeschlagen:', e.message));
      }
    }
    this.store.markStateDirty();
  }

  async resolveServer(srv) {
    const out = { ipv4: null, ipv6: null, rdns: null, resolvedAt: Date.now() };
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(srv.hostname),
      dns.resolve6(srv.hostname),
    ]);
    if (v4.status === 'fulfilled') out.ipv4 = v4.value[0] || null;
    if (v6.status === 'fulfilled') out.ipv6 = v6.value[0] || null;
    // hostname may itself be a literal IP
    if (!out.ipv4 && /^\d+\.\d+\.\d+\.\d+$/.test(srv.hostname)) out.ipv4 = srv.hostname;
    if (!out.ipv6 && srv.hostname.includes(':')) out.ipv6 = srv.hostname;
    if (out.ipv4) {
      try { out.rdns = (await dns.reverse(out.ipv4))[0] || null; } catch {}
    }
    this.store.state.resolved[srv.id] = out;
    this.store.markStateDirty();
    return out;
  }

  async resolveAll() {
    await Promise.all(this.store.config.servers.map(s => this.resolveServer(s)));
  }

  collectLinks() {
    const out = [];
    for (const srv of this.store.config.servers)
      for (const svc of srv.services || [])
        for (const l of svc.links || [])
          out.push({ link: l, server: srv });
    return out;
  }

  async checkLinks() {
    const jobs = this.collectLinks().map(async ({ link, server }) => {
      const r = link.kind === 'port'
        ? (link.protocol === 'http' || link.protocol === 'https'
            ? await checkUrl(`${link.protocol}://${server.hostname}:${link.port}`)
            : await checkPort(server.hostname, link.port))
        : await checkUrl(resolveLinkUrl(link, server));
      this.store.state.links[link.id] = { ...r, checkedAt: Date.now() };
    });
    await Promise.all(jobs);
    this.store.markStateDirty();
    this.checkServiceAvailability();
  }

  // A monitored service counts as down when none of its links respond.
  checkServiceAvailability() {
    for (const srv of this.store.config.servers) {
      for (const svc of srv.services || []) {
        if (!svc.monitorAvail || !(svc.links || []).length) continue;
        const checks = svc.links.map(l => this.store.state.links[l.id]).filter(Boolean);
        if (!checks.length) continue;
        const ok = checks.some(c => c.ok);
        this.trackAvailability('services', svc.id, ok, {
          kind: 'service', name: svc.name, serverName: srv.name, hostname: srv.hostname,
          detail: ok ? null : L(this.store, 'Kein Link des Dienstes antwortet', 'No link of the service responds'),
        });
      }
    }
  }

  async updatePublicIp() {
    const ip = this.store.state.publicIp;
    const now = Date.now();
    const [v4, v6] = await Promise.allSettled([
      fetchText('https://api.ipify.org', 4),
      fetchText('https://api6.ipify.org', 6),
    ]);
    if (v4.status === 'fulfilled' && v4.value && v4.value !== ip.v4) {
      ip.v4 = v4.value;
      ip.v4ChangedAt = now;
    }
    if (v6.status === 'fulfilled' && v6.value && v6.value.includes(':') && v6.value !== ip.v6) {
      ip.v6 = v6.value;
      ip.v6ChangedAt = now;
    }
    this.store.markStateDirty();
  }
}

module.exports = { Monitor, resolveLinkUrl, pingHost };
