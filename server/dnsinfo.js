'use strict';
// DNS record listing for arbitrary domains.
const dns = require('dns').promises;

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA'];

async function lookupAll(domain, lang) {
  domain = String(domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9._-]+$/i.test(domain)) throw new Error(lang === 'en' ? 'Invalid domain' : 'Ungültige Domain');
  const records = {};
  await Promise.all(TYPES.map(async type => {
    try {
      const res = await dns.resolve(domain, type);
      if (type === 'TXT') records.TXT = res.map(chunks => chunks.join(''));
      else if (type === 'MX') records.MX = res.sort((a, b) => a.priority - b.priority).map(r => `${r.priority} ${r.exchange}`);
      else if (type === 'SOA') records.SOA = [`${res.nsname} ${res.hostmaster} (serial ${res.serial}, ttl ${res.minttl})`];
      else if (type === 'SRV') records.SRV = res.map(r => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
      else if (type === 'CAA') records.CAA = res.map(r => `${r.critical} ${r.issue || r.issuewild || r.iodef || ''}`.trim());
      else records[type] = res;
    } catch { /* record type not present */ }
  }));
  return { domain, records, fetchedAt: Date.now() };
}

module.exports = { lookupAll };
