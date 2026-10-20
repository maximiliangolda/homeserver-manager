'use strict';
// E-Mail notifications via SMTP (nodemailer). HTML status mails for
// server/service availability changes plus a test mail.
const nodemailer = require('nodemailer');
const { decrypt } = require('./store');

function smtpConfigured(settings) {
  const s = settings.smtp || {};
  return !!(s.host && s.from);
}

function notifyActive(settings) {
  return smtpConfigured(settings) && !!(settings.notify && settings.notify.enabled && settings.notify.recipient);
}

function createTransport(settings) {
  const s = settings.smtp;
  const security = s.security || 'starttls';
  return nodemailer.createTransport({
    host: s.host,
    port: parseInt(s.port, 10) || 587,
    secure: security === 'tls',        // implicit TLS from the first byte (SMTPS)
    requireTLS: security === 'starttls', // fail instead of falling back to plaintext
    ignoreTLS: security === 'none',
    auth: s.user ? { user: s.user, pass: decrypt(s.pass) || '' } : undefined,
  });
}

const MAIL_TEXT = {
  de: {
    lang: 'de', locale: 'de-DE',
    testLabel: 'SMTP-Test erfolgreich',
    downLabel: 'nicht erreichbar', upLabel: 'wieder erreichbar',
    what: { server: 'Server', service: 'Dienst', test: 'Test' },
    hostname: 'Hostname', server: 'Server', when: 'Zeitpunkt', detail: 'Details',
    testBody: 'Der E-Mail-Versand des Homeserver-Managers funktioniert.',
    downBody: (what, name) => `Der ${what} <b>${name}</b> ist nicht mehr erreichbar.`,
    upBody: (what, name) => `Der ${what} <b>${name}</b> ist wieder erreichbar.`,
    footer: 'Diese Nachricht wurde automatisch vom Homeserver-Manager gesendet.',
    subject: (what, name, down) => `${down ? '⚠' : '✓'} ${what} „${name}" ${down ? 'nicht erreichbar' : 'wieder erreichbar'}`,
    testSubject: '✓ Homeserver-Manager — Test-E-Mail',
    testName: 'Test-Benachrichtigung',
    testDetail: 'Wenn du diese E-Mail liest, funktioniert der SMTP-Versand.',
    notConfigured: 'SMTP-Server ist nicht konfiguriert',
    noRecipient: 'Keine Empfänger-Adresse hinterlegt',
  },
  en: {
    lang: 'en', locale: 'en-GB',
    testLabel: 'SMTP test successful',
    downLabel: 'unreachable', upLabel: 'reachable again',
    what: { server: 'Server', service: 'Service', test: 'Test' },
    hostname: 'Hostname', server: 'Server', when: 'Time', detail: 'Details',
    testBody: 'Homeserver-Manager email delivery is working.',
    downBody: (what, name) => `The ${what.toLowerCase()} <b>${name}</b> is no longer reachable.`,
    upBody: (what, name) => `The ${what.toLowerCase()} <b>${name}</b> is reachable again.`,
    footer: 'This message was sent automatically by Homeserver-Manager.',
    subject: (what, name, down) => `${down ? '⚠' : '✓'} ${what} "${name}" ${down ? 'unreachable' : 'reachable again'}`,
    testSubject: '✓ Homeserver-Manager — test email',
    testName: 'Test notification',
    testDetail: 'If you can read this email, SMTP delivery is working.',
    notConfigured: 'SMTP server is not configured',
    noRecipient: 'No recipient address configured',
  },
};
const T = lang => MAIL_TEXT[lang === 'en' ? 'en' : 'de'];

const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Simple, mail-client-safe HTML (inline styles, table layout).
function statusHtml({ kind, name, hostname, serverName, down, detail, when, lang }) {
  const m = T(lang);
  const color = down ? '#d03b3b' : '#0ca30c';
  const label = kind === 'test' ? m.testLabel : down ? m.downLabel : m.upLabel;
  const what = kind === 'server' ? m.what.server : kind === 'test' ? m.what.test : m.what.service;
  const rows = [
    [what, name],
    hostname ? [m.hostname, hostname] : null,
    serverName ? [m.server, serverName] : null,
    [m.when, when],
    detail ? [m.detail, detail] : null,
  ].filter(Boolean).map(([k, v]) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#898781;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:6px 0;color:#0b0b0b;font-size:13px">${esc(v)}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="${m.lang}"><body style="margin:0;padding:0;background:#f0efec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0efec;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',system-ui,sans-serif">
  <tr><td style="background:${color};padding:18px 26px">
    <div style="color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.08em">HOMESERVER-MANAGER</div>
    <div style="color:#ffffff;font-size:19px;font-weight:700;margin-top:4px">${down ? '&#9888;' : '&#10003;'} ${kind === 'test' ? label : `${what} ${label}`}</div>
  </td></tr>
  <tr><td style="padding:22px 26px">
    <p style="margin:0 0 14px;color:#0b0b0b;font-size:14px;line-height:1.5">
      ${kind === 'test' ? m.testBody : down ? m.downBody(what, esc(name)) : m.upBody(what, esc(name))}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #e1e0d9;padding-top:6px">${rows}</table>
  </td></tr>
  <tr><td style="padding:14px 26px;background:#f9f9f7;border-top:1px solid #e1e0d9">
    <div style="color:#898781;font-size:11.5px">${m.footer}</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function sendStatusMail(settings, info) {
  if (!notifyActive(settings)) return;
  const lang = settings.language;
  const m = T(lang);
  const what = info.kind === 'server' ? m.what.server : m.what.service;
  const subject = m.subject(what, info.name, info.down);
  await createTransport(settings).sendMail({
    from: settings.smtp.from,
    to: settings.notify.recipient,
    subject,
    html: statusHtml({ ...info, lang, when: new Date().toLocaleString(m.locale, { dateStyle: 'medium', timeStyle: 'medium' }) }),
  });
}

async function sendTestMail(settings, recipient) {
  const lang = settings.language;
  const m = T(lang);
  if (!smtpConfigured(settings)) throw new Error(m.notConfigured);
  const to = recipient || (settings.notify && settings.notify.recipient);
  if (!to) throw new Error(m.noRecipient);
  await createTransport(settings).sendMail({
    from: settings.smtp.from,
    to,
    subject: m.testSubject,
    html: statusHtml({
      kind: 'test', name: m.testName, down: false, lang,
      detail: m.testDetail,
      when: new Date().toLocaleString(m.locale, { dateStyle: 'medium', timeStyle: 'medium' }),
    }),
  });
  return { ok: true };
}

module.exports = { sendStatusMail, sendTestMail, notifyActive, smtpConfigured };
