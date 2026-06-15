// src/auth-email.js — passwordless email magic-link sign-in.
//
// The product previously had only two ways in: paste a ks_ API key, or OAuth
// (which needs Google/GitHub client IDs the deploy may not have set). That left
// a brand-new user with no email-based path — the modern default. This module
// adds it: request a one-time signed link by email, click it, and you're signed
// in (a 30-day scoped session key in an httpOnly cookie, via the same
// findOrCreateTenantByEmail path OAuth uses — which never rotates your primary
// key).
//
// Security: the token is HMAC-signed (constant-time verified), 15-minute TTL,
// and single-use (a row in magic_link_tokens is consumed on verify). The start
// endpoint is anti-enumeration: it always returns ok and never reveals the link
// in the response — the link is only ever delivered by email.

import crypto from 'node:crypto';
import { findOrCreateTenantByEmail } from './auth.js';
import { sendEmail } from './email.js';
import { isProductionRuntime } from './env.js';
import { insert, findOne, update } from './store.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function secret() {
  return process.env.KOLM_MAGICLINK_SECRET
    || process.env.RECIPE_RECEIPT_SECRET
    || (isProductionRuntime() ? null : 'dev-magiclink-secret-change-in-prod');
}

function baseUrl() {
  const b = process.env.OAUTH_REDIRECT_BASE || process.env.KOLM_PUBLIC_URL || 'http://localhost:8787';
  return String(b).replace(/\/+$/, '');
}

function sign(payload) {
  const s = secret();
  if (!s) throw new Error('magic-link secret not configured');
  return crypto.createHmac('sha256', s).update(payload).digest('hex');
}

/** Mint a single-use, 15-minute magic-link token for `email`. */
export function mintMagicToken(email, now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = now + TOKEN_TTL_MS;
  const payload = `${email}.${exp}.${nonce}`;
  const token = Buffer.from(`${payload}.${sign(payload)}`).toString('base64url');
  insert('magic_link_tokens', { nonce, email, exp, consumed_at: null, created_at: now });
  return token;
}

/** Verify a token: signature, TTL, single-use. Consumes it on success. */
export function verifyMagicToken(token, now = Date.now()) {
  let decoded;
  try { decoded = Buffer.from(String(token || ''), 'base64url').toString('utf8'); } catch { return { ok: false, error: 'malformed' }; }
  // Parse from the RIGHT — the email (the first field) can contain dots, but
  // exp (digits), nonce (hex) and sig (hex) never do. The signed payload is
  // everything before the final dot (`email.exp.nonce`).
  const sigDot = decoded.lastIndexOf('.');
  if (sigDot < 0) return { ok: false, error: 'malformed' };
  const signedPart = decoded.slice(0, sigDot);
  const sig = decoded.slice(sigDot + 1);
  const nonceDot = signedPart.lastIndexOf('.');
  const expDot = nonceDot > 0 ? signedPart.lastIndexOf('.', nonceDot - 1) : -1;
  if (nonceDot < 0 || expDot < 0) return { ok: false, error: 'malformed' };
  const email = signedPart.slice(0, expDot);
  const expStr = signedPart.slice(expDot + 1, nonceDot);
  const nonce = signedPart.slice(nonceDot + 1);
  let expected;
  try { expected = sign(signedPart); } catch { return { ok: false, error: 'not_configured' }; }
  if (sig.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, error: 'bad_signature' };
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || now > exp) return { ok: false, error: 'expired' };
  const row = findOne('magic_link_tokens', (r) => r.nonce === nonce);
  if (!row) return { ok: false, error: 'unknown' };
  if (row.consumed_at) return { ok: false, error: 'already_used' };
  update('magic_link_tokens', (r) => r.nonce === nonce, { consumed_at: now });
  return { ok: true, email };
}

function setSession(res, apiKey) {
  res.cookie('kolm_session', apiKey, {
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function mountAuthEmail(router) {
  // POST /v1/auth/email/start { email } — email a one-time sign-in link.
  router.post('/v1/auth/email/start', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'valid email required' });
    }
    if (!secret()) {
      return res.status(503).json({ ok: false, error: 'magic_link_not_configured', hint: 'set RECIPE_RECEIPT_SECRET (or KOLM_MAGICLINK_SECRET) on the server' });
    }
    let delivery = 'sent';
    try {
      const token = mintMagicToken(email);
      const link = `${baseUrl()}/v1/auth/email/verify?token=${encodeURIComponent(token)}`;
      const r = await sendEmail({
        to: email,
        subject: 'Your kolm sign-in link',
        html: `<p>Click to sign in to kolm:</p><p><a href="${link}">Sign in to kolm</a></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
        text: `Sign in to kolm: ${link}\n\nThis link expires in 15 minutes.`,
        tag: 'magic-link',
      });
      // sendEmail returns { delivered, queued }: delivered when Resend is wired,
      // queued to the local outbox otherwise (set RESEND_API_KEY to actually send).
      delivery = (r && r.delivered) ? 'sent' : (r && r.queued) ? 'queued' : 'unknown';
    } catch { delivery = 'queued'; }
    // Anti-enumeration: always 200, never reveal the link or whether the account exists.
    res.json({ ok: true, message: 'Check your email for a sign-in link.', delivery });
  });

  // GET /v1/auth/email/verify?token=... — consume the link and sign in.
  router.get('/v1/auth/email/verify', (req, res) => {
    const v = verifyMagicToken(String((req.query && req.query.token) || ''));
    if (!v.ok) {
      if (req.accepts('html')) return res.redirect(302, `/signup?email_error=${encodeURIComponent(v.error)}`);
      return res.status(400).json({ ok: false, error: v.error });
    }
    const { tenant, api_key, created } = findOrCreateTenantByEmail({
      email: v.email,
      name: v.email.split('@')[0],
      provider: 'email',
      provider_id: v.email,
    });
    setSession(res, api_key);
    if (req.accepts('html')) {
      return res.redirect(302, `/account/dashboard?auth=email&${created ? 'signup' : 'signin'}=1`);
    }
    res.json({ ok: true, api_key, created, tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan } });
  });
}
