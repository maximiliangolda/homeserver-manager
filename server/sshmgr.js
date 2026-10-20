'use strict';
// SSH integration via ssh2: interactive terminal (WebSocket bridge),
// remote statistics, and power control.
const { Client } = require('ssh2');
const { decrypt } = require('./store');

const MSG = {
  noCreds: { de: 'Keine SSH-Zugangsdaten hinterlegt', en: 'No SSH credentials configured' },
  timeout: { de: 'Zeitüberschreitung', en: 'timeout' },
  unknownAction: { de: 'Unbekannte Aktion', en: 'Unknown action' },
  cmdFailed: { de: 'Befehl fehlgeschlagen', en: 'Command failed' },
  hostKeyMismatch: {
    de: 'Der SSH-Host-Key des Servers hat sich geändert — mögliches Sicherheitsrisiko (z. B. Neuinstallation oder Man-in-the-Middle). Bei einer bewussten Neuinstallation kann der gespeicherte Host-Key über "SSH-Host-Key vergessen" zurückgesetzt werden.',
    en: 'The server\'s SSH host key has changed — possible security risk (e.g. reinstall or man-in-the-middle). If this is an intentional reinstall, the stored host key can be reset via "Forget SSH host key".',
  },
};
const msg = (key, lang) => MSG[key][lang === 'en' ? 'en' : 'de'];

// Trust-on-first-use host key pinning: the first successful connection to a
// server records its key fingerprint; later connections must match it.
function makeHostVerifier(store, serverId) {
  return hashedKey => {
    if (!serverId) return true; // no persisted identity yet (e.g. ad-hoc test before first save)
    const known = store.state.sshHostKeys[serverId];
    if (!known) {
      store.state.sshHostKeys[serverId] = { fingerprint: hashedKey, seenAt: Date.now() };
      store.markStateDirty();
      return true;
    }
    return known.fingerprint === hashedKey;
  };
}

// onRejected() is called synchronously if the host key doesn't match the pinned
// one, so callers can turn the generic ssh2 connect error into a clear message.
function connectionOpts(server, store, onRejected) {
  const ssh = server.ssh || {};
  const verify = makeHostVerifier(store, server.id);
  const opts = {
    host: server.hostname,
    port: ssh.port || 22,
    username: ssh.username,
    readyTimeout: 10000,
    keepaliveInterval: 15000,
    hostHash: 'sha256',
    hostVerifier: hashedKey => {
      const ok = verify(hashedKey);
      if (!ok && onRejected) onRejected();
      return ok;
    },
  };
  const secret = decrypt(ssh.secret);
  if (ssh.auth === 'key') opts.privateKey = secret;
  else opts.password = secret;
  if (ssh.passphrase) opts.passphrase = decrypt(ssh.passphrase);
  return opts;
}

function withConnection(store, server, fn, lang) {
  return new Promise((resolve, reject) => {
    if (!server.ssh || !server.ssh.username) return reject(new Error(msg('noCreds', lang)));
    const conn = new Client();
    let hostKeyRejected = false;
    conn.on('ready', () => {
      Promise.resolve(fn(conn))
        .then(r => { conn.end(); resolve(r); })
        .catch(e => { conn.end(); reject(e); });
    });
    conn.on('error', e => {
      if (hostKeyRejected) return reject(new Error(msg('hostKeyMismatch', lang)));
      reject(e);
    });
    try {
      conn.connect(connectionOpts(server, store, () => { hostKeyRejected = true; }));
    } catch (e) { reject(e); }
  });
}

function execCommand(conn, command, timeoutMs = 20000, lang) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      const timer = setTimeout(() => { stream.close(); reject(new Error(msg('timeout', lang))); }, timeoutMs);
      stream.on('data', d => (out += d));
      stream.stderr.on('data', d => (errOut += d));
      stream.on('close', code => { clearTimeout(timer); resolve({ code, out, err: errOut }); });
    });
  });
}

// One compound command, field-separated so a single roundtrip yields all stats.
const STATS_CMD = [
  `echo "@@HOST@@$(hostname)"`,
  `echo "@@OS@@$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"`,
  `echo "@@KERNEL@@$(uname -sr)"`,
  `echo "@@ARCH@@$(uname -m)"`,
  `echo "@@UPTIME@@$(cut -d. -f1 /proc/uptime 2>/dev/null)"`,
  `echo "@@LOAD@@$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"`,
  `echo "@@CPUS@@$(nproc 2>/dev/null)"`,
  `echo "@@CPUMODEL@@$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2)"`,
  `echo "@@MEM@@$(free -b 2>/dev/null | awk '/^Mem:/{print $2","$3","$7}')"`,
  `echo "@@DISK@@$(df -B1 --output=size,used,avail,pcent,target / 2>/dev/null | tail -1)"`,
  `echo "@@DISKS@@$(df -B1 --output=target,size,used,pcent -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | tail -n +2 | tr '\\n' ';')"`,
  `echo "@@TEMP@@$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"`,
].join('; ');

function parseStats(out) {
  const get = key => {
    const m = new RegExp(`^@@${key}@@(.*)$`, 'm').exec(out);
    return m ? m[1].trim() : null;
  };
  const stats = {
    host: get('HOST'),
    os: get('OS') || null,
    kernel: get('KERNEL'),
    arch: get('ARCH'),
    uptimeSec: parseInt(get('UPTIME'), 10) || null,
    load: get('LOAD'),
    cpus: parseInt(get('CPUS'), 10) || null,
    cpuModel: get('CPUMODEL') || null,
    fetchedAt: Date.now(),
  };
  const mem = (get('MEM') || '').split(',').map(Number);
  if (mem.length === 3 && mem[0] > 0) stats.mem = { total: mem[0], used: mem[1], available: mem[2] };
  const disk = (get('DISK') || '').trim().split(/\s+/);
  if (disk.length >= 4) stats.disk = { total: +disk[0], used: +disk[1], avail: +disk[2], pcent: disk[3] };
  const temp = parseInt(get('TEMP'), 10);
  if (!isNaN(temp)) stats.tempC = Math.round(temp / 100) / 10;
  const disks = (get('DISKS') || '').split(';').map(s => s.trim()).filter(Boolean).map(row => {
    const p = row.split(/\s+/);
    return p.length >= 4 ? { mount: p[0], total: +p[1], used: +p[2], pcent: p[3] } : null;
  }).filter(Boolean);
  if (disks.length) stats.disks = disks;
  return stats;
}

// Verify credentials by opening a connection and running a trivial command.
async function testConnection(store, server, lang) {
  return withConnection(store, server, async conn => {
    await execCommand(conn, 'true', 8000, lang);
    return { ok: true };
  }, lang);
}

async function fetchStats(store, server, lang) {
  return withConnection(store, server, async conn => {
    const { out } = await execCommand(conn, STATS_CMD, 20000, lang);
    return parseStats(out);
  }, lang);
}

const POWER_COMMANDS = {
  reboot: 'sudo -n systemctl reboot 2>/dev/null || systemctl reboot 2>/dev/null || sudo -n reboot || reboot',
  shutdown: 'sudo -n systemctl poweroff 2>/dev/null || systemctl poweroff 2>/dev/null || sudo -n poweroff || poweroff',
};

async function powerAction(store, server, action, lang) {
  const cmd = POWER_COMMANDS[action];
  if (!cmd) throw new Error(msg('unknownAction', lang));
  return withConnection(store, server, async conn => {
    // connection usually drops mid-command; treat that as success
    try {
      const r = await execCommand(conn, cmd, 8000, lang);
      if (r.code !== 0 && r.err) throw new Error(r.err.trim().split('\n')[0] || msg('cmdFailed', lang));
      return { ok: true };
    } catch (e) {
      if (/timeout|closed|disconnect/i.test(e.message)) return { ok: true };
      throw e;
    }
  }, lang);
}

// WebSocket <-> SSH shell bridge for the browser terminal
function attachTerminal(ws, store, server, lang) {
  const conn = new Client();
  let closed = false;
  let hostKeyRejected = false;
  const fail = msg => {
    if (closed) return;
    try { ws.send(JSON.stringify({ type: 'error', message: msg })); } catch {}
    try { ws.close(); } catch {}
  };
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, stream) => {
      if (err) return fail(err.message);
      ws.send(JSON.stringify({ type: 'ready' }));
      stream.on('data', d => { try { ws.send(d); } catch {} });
      stream.stderr.on('data', d => { try { ws.send(d); } catch {} });
      stream.on('close', () => { try { ws.close(); } catch {} conn.end(); });
      ws.on('message', msg => {
        if (typeof msg !== 'string' && !Buffer.isBuffer(msg)) return;
        const text = msg.toString();
        if (text.startsWith('{')) {
          try {
            const j = JSON.parse(text);
            if (j.type === 'resize') return stream.setWindow(j.rows, j.cols, 0, 0);
            if (j.type === 'input') return stream.write(j.data);
          } catch {}
          return;
        }
        stream.write(text);
      });
      ws.on('close', () => { closed = true; stream.close(); conn.end(); });
    });
  });
  conn.on('error', e => fail(hostKeyRejected ? msg('hostKeyMismatch', lang) : 'SSH: ' + e.message));
  try {
    if (!server.ssh || !server.ssh.username) return fail(msg('noCreds', lang));
    conn.connect(connectionOpts(server, store, () => { hostKeyRejected = true; }));
  } catch (e) { fail(e.message); }
}

module.exports = { fetchStats, powerAction, attachTerminal, testConnection };
