'use strict';
// JSON-backed persistence. config.json holds everything the user configures,
// state.json holds volatile monitoring data (ping history, link states, public IP).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');

const DEFAULT_CONFIG = {
  settings: {
    port: 4680,
    pingIntervalSec: 30,
    linkCheckIntervalSec: 120,
    publicIpIntervalSec: 300,
    language: 'de', // de|en — UI, Mails und Fehlermeldungen
    smtp: { host: '', port: 587, security: 'starttls' /* none|starttls|tls */, user: '', pass: null /* enc */, from: '' },
    notify: { enabled: false, recipient: '' },
  },
  auth: null, // { hash, salt } — set during setup
  servers: [], // { id, name, hostname, note, group, pinned, ssh: {username, port, auth:'password'|'key', secret(enc)}, services: [...] }
  globalLinks: [], // { id, alias, url, note }
};

const DEFAULT_STATE = {
  publicIp: { v4: null, v6: null, v4ChangedAt: null, v6ChangedAt: null },
  // pings[serverId] = [{ t, ok, rtt }], capped
  pings: {},
  // resolved[serverId] = { ipv4, ipv6, rdns, resolvedAt }
  resolved: {},
  // links[linkId] = { ok, status, checkedAt }
  links: {},
  // notify.servers[serverId] / notify.services[serviceId] = { fails, notifiedDown }
  notify: { servers: {}, services: {} },
  // sshHostKeys[serverId] = { fingerprint, seenAt } — trust-on-first-use pinning
  sshHostKeys: {},
};

const PING_HISTORY_MAX = 5760; // 48h at 30s interval

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- encryption for SSH secrets (AES-256-GCM, key kept outside config) ---
function getKey() {
  ensureDir();
  try {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc.toString('hex');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, data] = blob.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

class Store {
  constructor() {
    this.config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    this.state = readJson(STATE_FILE, DEFAULT_STATE);
    // fill in any newly introduced defaults
    this.config.settings = { ...DEFAULT_CONFIG.settings, ...this.config.settings };
    this.config.settings.smtp = { ...DEFAULT_CONFIG.settings.smtp, ...this.config.settings.smtp };
    // migrate legacy boolean `secure` to the `security` dropdown value
    if ('secure' in this.config.settings.smtp) {
      this.config.settings.smtp.security = this.config.settings.smtp.secure ? 'tls' : 'starttls';
      delete this.config.settings.smtp.secure;
    }
    this.config.settings.notify = { ...DEFAULT_CONFIG.settings.notify, ...this.config.settings.notify };
    for (const k of Object.keys(DEFAULT_STATE)) {
      if (this.state[k] === undefined) this.state[k] = structuredClone(DEFAULT_STATE[k]);
    }
    this._stateDirty = false;
    setInterval(() => this.flushState(), 15000).unref();
  }

  saveConfig() { writeJsonAtomic(CONFIG_FILE, this.config); }
  markStateDirty() { this._stateDirty = true; }
  flushState() {
    if (!this._stateDirty) return;
    this._stateDirty = false;
    writeJsonAtomic(STATE_FILE, this.state);
  }

  id() { return crypto.randomBytes(8).toString('hex'); }

  findServer(id) { return this.config.servers.find(s => s.id === id); }

  addPing(serverId, ok, rtt) {
    const arr = this.state.pings[serverId] || (this.state.pings[serverId] = []);
    arr.push({ t: Date.now(), ok, rtt: rtt ?? null });
    if (arr.length > PING_HISTORY_MAX) arr.splice(0, arr.length - PING_HISTORY_MAX);
    this.markStateDirty();
  }

  // drop state for entities that no longer exist
  gcState() {
    const serverIds = new Set(this.config.servers.map(s => s.id));
    for (const id of Object.keys(this.state.pings)) if (!serverIds.has(id)) delete this.state.pings[id];
    for (const id of Object.keys(this.state.resolved)) if (!serverIds.has(id)) delete this.state.resolved[id];
    const linkIds = new Set();
    for (const s of this.config.servers)
      for (const svc of s.services || [])
        for (const l of svc.links || []) linkIds.add(l.id);
    for (const g of this.config.globalLinks) linkIds.add(g.id);
    for (const id of Object.keys(this.state.links)) if (!linkIds.has(id)) delete this.state.links[id];
    const svcIds = new Set();
    for (const s of this.config.servers) for (const svc of s.services || []) svcIds.add(svc.id);
    for (const id of Object.keys(this.state.notify.servers)) if (!serverIds.has(id)) delete this.state.notify.servers[id];
    for (const id of Object.keys(this.state.notify.services)) if (!svcIds.has(id)) delete this.state.notify.services[id];
    for (const id of Object.keys(this.state.sshHostKeys)) if (!serverIds.has(id)) delete this.state.sshHostKeys[id];
    this.markStateDirty();
  }
}

module.exports = { Store, encrypt, decrypt, DATA_DIR };
