'use strict';
const { v4: uuidv4 } = require('uuid');

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || (() => {
  const k = 'denchclaw-dev-' + uuidv4();
  console.warn('[Auth] INTERNAL_API_KEY not set — ephemeral dev key generated:', k);
  return k;
})();

const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || 'growthclub';

// ─── Key → allowed-company binding (multi-tenant isolation, layer 1) ──────────
// INTERNAL_API_KEYS (optional) is a JSON object mapping each API key to the
// companies it may act for: { "<key>": ["co_a","co_b"], "<key2>": "*" }.
// "*" (or the array ["*"]) means the key may act for any company.
//
// Back-compat: if INTERNAL_API_KEYS is unset, the single INTERNAL_API_KEY is
// bound to "*" — i.e. exactly today's behavior (any X-Company-Id accepted).
// Operators opt into real per-tenant isolation by configuring INTERNAL_API_KEYS
// with explicit company sets; an out-of-set X-Company-Id then gets 403.
function buildKeyBindings() {
  const raw = process.env.INTERNAL_API_KEYS;
  const map = new Map();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('[Auth] INTERNAL_API_KEYS is not valid JSON — refusing to start:', e.message);
      throw new Error('INTERNAL_API_KEYS must be valid JSON');
    }
    for (const [key, val] of Object.entries(parsed)) {
      if (val === '*' || (Array.isArray(val) && val.includes('*'))) {
        map.set(key, '*');
      } else if (Array.isArray(val)) {
        map.set(key, new Set(val));
      } else if (typeof val === 'string') {
        map.set(key, new Set([val]));
      }
    }
  } else {
    map.set(INTERNAL_API_KEY, '*'); // single-key back-compat
  }
  return map;
}

const KEY_BINDINGS = buildKeyBindings();

// Returns the allowed-company set for a key ('*' | Set | null-if-unknown).
function allowedCompaniesFor(key) {
  return KEY_BINDINGS.has(key) ? KEY_BINDINGS.get(key) : null;
}

const ALLOWED_CIDRS = (process.env.INTERNAL_API_ALLOWED_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(s => s.trim()).filter(Boolean);

function ipAllowed(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ALLOWED_CIDRS.some(cidr => {
    const [base] = cidr.split('/');
    return ip === base || ip.startsWith(base.replace(/\.\d+$/, '.'));
  });
}

function requireAuth(req, res, next) {
  const key = req.headers['x-internal-key'];
  const allowed = key ? allowedCompaniesFor(key) : null;
  if (!key || !allowed) {
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }
  const callerIp = req.ip || req.socket?.remoteAddress || '';
  if (!ipAllowed(callerIp)) {
    console.warn('[Auth] X-Internal-Key rejected from IP:', callerIp);
    return res.status(403).json({ error: 'Internal API access denied from this address' });
  }
  const companyId = req.headers['x-company-id'] || DEFAULT_COMPANY_ID;
  // Layer-1 isolation: a bound key may only act for companies in its set.
  if (allowed !== '*' && !allowed.has(companyId)) {
    console.warn(`[Auth] key not permitted for company '${companyId}'`);
    return res.status(403).json({ error: 'company not permitted for this key' });
  }
  req.auth = {
    userId: 'internal-agent',
    companyId,
    role: 'agent',
  };
  next();
}

function getUserCompanyId(req) {
  return req.auth?.companyId || null;
}

module.exports = { requireAuth, getUserCompanyId, INTERNAL_API_KEY };
