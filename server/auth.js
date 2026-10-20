'use strict';
// Password auth (scrypt) + cookie sessions, persisted so restarts keep users logged in.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14; // 14 days
const sessions = new Map(); // token -> expiry
let failedAttempts = 0;
let lockUntil = 0;

try {
  const now = Date.now();
  for (const [token, exp] of Object.entries(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')))) {
    if (exp > now) sessions.set(token, exp);
  }
} catch { /* no sessions yet */ }

function persistSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, auth) {
  if (!auth) return false;
  const candidate = crypto.scryptSync(password, auth.salt, 64);
  const stored = Buffer.from(auth.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  persistSessions();
  return token;
}

function destroySession(token) { sessions.delete(token); persistSessions(); }

// invalidate all sessions, e.g. after a password change
function destroyAllSessions() { sessions.clear(); persistSessions(); }

function validSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromReq(req) {
  return parseCookies(req.headers.cookie).hsm_session;
}

// simple brute-force brake: after 5 failures, wait 30s
function loginAllowed() { return Date.now() >= lockUntil; }
function noteLoginResult(ok) {
  if (ok) { failedAttempts = 0; return; }
  failedAttempts++;
  if (failedAttempts >= 5) { lockUntil = Date.now() + 30000; failedAttempts = 0; }
}

function middleware(store) {
  return (req, res, next) => {
    // NOTE: mounted at /api, so req.path is relative (e.g. "/status")
    if (!store.config.auth) {
      // setup not done — only allow setup endpoint
      if (req.path === '/setup' || req.path === '/status') return next();
      return res.status(403).json({ error: 'setup_required' });
    }
    const open = ['/login', '/status'];
    if (open.includes(req.path)) return next();
    if (validSession(sessionFromReq(req))) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions,
  validSession, sessionFromReq, middleware, loginAllowed, noteLoginResult,
};
