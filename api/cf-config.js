// Vercel serverless function for Cloudflare zone hardening.
// Applies WAF custom rules, rate-limit rules, and Email Routing forward rules.
// Admin operations are gated by ADMIN_KEY in the x-admin-key header.
//
// Routes (path determined by ?op= query):
//   GET  /api/cf-config?op=ping
//   GET  /api/cf-config?op=zones
//   GET  /api/cf-config?op=waf
//   POST /api/cf-config?op=apply-waf
//   GET  /api/cf-config?op=rate-limit
//   POST /api/cf-config?op=apply-rate-limit
//   GET  /api/cf-config?op=email
//   POST /api/cf-config?op=apply-email
//   POST /api/cf-config?op=bootstrap

import crypto from 'node:crypto';
import * as CF from '../src/cloudflare.js';

const OP_METHODS = {
  ping: new Set(['GET']),
  zones: new Set(['GET']),
  waf: new Set(['GET']),
  'apply-waf': new Set(['POST']),
  'rate-limit': new Set(['GET']),
  'apply-rate-limit': new Set(['POST']),
  email: new Set(['GET']),
  'apply-email': new Set(['POST']),
  bootstrap: new Set(['POST']),
};

class HttpError extends Error {
  constructor(status, error, detail = null) {
    super(detail || error);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

function _header(req, name) {
  const headers = req.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function _sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest();
}

function _safeEqual(a, b) {
  return crypto.timingSafeEqual(_sha256(a), _sha256(b));
}

function _json(res, status, payload) {
  return res.status(status).json(payload);
}

function _accountId() {
  return process.env.CLOUDFLARE_ACCOUNT_ID || process.env.cloudflare_account_id || '';
}

function _apiToken() {
  return process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token || '';
}

function _configuredEnvelope(error = 'cloudflare_not_configured') {
  return {
    ok: false,
    error,
    hint: 'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars',
    have_account: !!_accountId(),
    have_token: !!_apiToken(),
  };
}

function _accountPrefix() {
  const id = _accountId();
  return id ? `${id.slice(0, 8)}...` : null;
}

function _redact(s) {
  let out = String(s || '');
  for (const secret of [_apiToken(), process.env.ADMIN_KEY, _accountId()].filter((v) => String(v || '').length >= 4)) {
    out = out.split(String(secret)).join('[redacted]');
  }
  return out
    .replace(/\/accounts\/[^/?\s]+/g, '/accounts/[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

function _errorDetail(e) {
  if (!process.env.KOLM_DEBUG) return 'operation failed';
  return _redact(e?.message || e).slice(0, 1000);
}

function _assertMethod(req, res, op) {
  const method = String(req.method || 'GET').toUpperCase();
  const allowed = OP_METHODS[op] || null;
  if (!allowed) return true;
  if (allowed.has(method)) return true;
  res.setHeader('Allow', Array.from(allowed).join(', '));
  _json(res, 405, { ok: false, error: 'method_not_allowed', op, allowed: Array.from(allowed) });
  return false;
}

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_KEY || '';
  const supplied = _header(req, 'x-admin-key');
  if (!expected || !supplied || !_safeEqual(supplied, expected)) {
    _json(res, 403, { ok: false, error: expected ? 'admin_only' : 'admin_not_configured' });
    return false;
  }
  return true;
}

function _domain(value) {
  const domain = String(value || process.env.KOLM_DOMAIN || 'kolm.ai').trim().toLowerCase().replace(/\.$/, '');
  const labels = domain.split('.');
  if (
    domain.length < 3
    || domain.length > 253
    || labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new HttpError(400, 'invalid_domain', 'domain must be a DNS zone name');
  }
  return domain;
}

function _sanitizeZone(z) {
  return {
    id: z.id,
    name: z.name,
    status: z.status,
    paused: z.paused,
    type: z.type,
  };
}

function _sanitizeSoftError(e) {
  return { ok: false, error: 'cloudflare_operation_failed', detail: _errorDetail(e) };
}

export default async function handler(req, res) {
  try {
    const op = String(req.query?.op || 'ping');
    if (!OP_METHODS[op]) {
      return _json(res, 400, { ok: false, error: 'unknown_op', op, ops: Object.keys(OP_METHODS) });
    }
    if (!_assertMethod(req, res, op)) return;

    if (!CF.cloudflareConfigured()) {
      return _json(res, 500, _configuredEnvelope());
    }

    if (op === 'ping') {
      return _json(res, 200, {
        ok: true,
        configured: true,
        account_prefix: _accountPrefix(),
        zone_id_configured: !!(process.env.CLOUDFLARE_ZONE_ID || process.env.cloudflare_zone_id),
      });
    }

    if (!requireAdmin(req, res)) return;

    if (op === 'zones') {
      const zones = await CF.listZones();
      return _json(res, 200, { ok: true, count: zones.length, zones: zones.map(_sanitizeZone) });
    }

    const domain = _domain(req.query?.domain);

    if (op === 'waf') {
      const zone_id = await CF.discoverZoneId(domain);
      const rules = await CF.listCustomRules(zone_id);
      return _json(res, 200, { ok: true, zone_id, domain, rules });
    }

    if (op === 'apply-waf') {
      const zone_id = await CF.discoverZoneId(domain);
      const rules = CF.defaultWafRules();
      await CF.putCustomRules(zone_id, rules);
      return _json(res, 200, { ok: true, zone_id, domain, applied: rules.length });
    }

    if (op === 'rate-limit') {
      const zone_id = await CF.discoverZoneId(domain);
      const rules = await CF.listRateLimitRules(zone_id);
      return _json(res, 200, {
        ok: true,
        zone_id,
        domain,
        rules,
        planned_count: CF.defaultRateLimitRules().length,
      });
    }

    if (op === 'apply-rate-limit') {
      const zone_id = await CF.discoverZoneId(domain);
      const rules = CF.defaultRateLimitRules();
      await CF.putRateLimitRules(zone_id, rules);
      return _json(res, 200, { ok: true, zone_id, domain, applied: rules.length });
    }

    if (op === 'email') {
      const zone_id = await CF.discoverZoneId(domain);
      const status = await CF.emailRoutingStatus(zone_id).catch(_sanitizeSoftError);
      const rules = await CF.listEmailRules(zone_id).catch(() => []);
      return _json(res, 200, { ok: true, zone_id, domain, status, rules });
    }

    if (op === 'apply-email') {
      const zone_id = await CF.discoverZoneId(domain);
      const enable = await CF.enableEmailRouting(zone_id)
        .then(() => ({ ok: true }))
        .catch(_sanitizeSoftError);
      const rules = CF.defaultEmailRules({ domain });
      const results = [];
      for (const r of rules) {
        try {
          await CF.putEmailRule(zone_id, r);
          results.push({ name: r.name, inbound: r.matchers?.[0]?.value, ok: true });
        } catch (e) {
          results.push({
            name: r.name,
            inbound: r.matchers?.[0]?.value,
            ok: false,
            error: 'cloudflare_email_rule_failed',
            detail: _errorDetail(e),
          });
        }
      }
      return _json(res, 200, { ok: true, zone_id, domain, enable, applied: results });
    }

    if (op === 'bootstrap') {
      const out = await CF.bootstrapZoneHardening({ domain });
      return _json(res, 200, { ok: true, ...out });
    }
  } catch (e) {
    if (e instanceof HttpError) {
      return _json(res, e.status, { ok: false, error: e.error, detail: e.detail });
    }
    return _json(res, 500, {
      ok: false,
      error: 'cf_config_api_error',
      detail: _errorDetail(e),
    });
  }
}
