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
import rateLimit from 'express-rate-limit';
import { findOrCreateTenantByEmail, recoverKeyByEmail } from './auth.js';
import { sendEmail } from './email.js';
import { isProductionRuntime } from './env.js';
import { insert, findOne, all, update, remove, withTransaction } from './store.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// How long an already-expired (or already-consumed) magic-link row is retained
// before garbage collection. The token itself is unusable the moment it expires
// (verifyMagicToken rejects on exp) or is consumed, so this retention is purely
// for a short post-mortem/audit window; after it the row is dead weight that
// slows the table's full-scan all() queries. Override with
// KOLM_MAGICLINK_RETENTION_DAYS. Default 7 days.
function retentionMs() {
  const days = parseInt(process.env.KOLM_MAGICLINK_RETENTION_DAYS || '7', 10);
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  return d * 24 * 60 * 60 * 1000;
}

function secret() {
  return process.env.KOLM_MAGICLINK_SECRET
    || process.env.RECIPE_RECEIPT_SECRET
    || (isProductionRuntime() ? null : 'dev-magiclink-secret-change-in-prod');
}

// AUTH-05 - unified base-URL resolution. Same precedence in both auth modules:
// OAUTH_REDIRECT_BASE > KOLM_PUBLIC_URL > (prod ? https://kolm.ai : localhost).
// Magic-link and OAuth must agree so a preview/staging/self-host deploy emails a
// link that points back at ITSELF, not at prod.
function baseUrl() {
  const b = process.env.OAUTH_REDIRECT_BASE
    || process.env.KOLM_PUBLIC_URL
    || (isProductionRuntime() ? 'https://kolm.ai' : 'http://localhost:8787');
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
  // AUTH-04 - single-use consume MUST be atomic. A magic link is a bearer
  // credential; two concurrent verifies of the same token (double-click,
  // email-scanner prefetch + user click, link-preview bots) could both pass the
  // consumed_at===null check before either writes and both mint a session.
  // withTransaction (BEGIN IMMEDIATE serializes writers in sqlite mode) plus a
  // RE-READ of the row inside the lock closes the TOCTOU: the second writer
  // observes consumed_at set and bails. Mirrors claimAnonTenantAtomic.
  return withTransaction(() => {
    const row = findOne('magic_link_tokens', (r) => r.nonce === nonce);
    if (!row) return { ok: false, error: 'unknown' };
    if (row.consumed_at) return { ok: false, error: 'already_used' };
    update('magic_link_tokens', (r) => r.nonce === nonce && !r.consumed_at, { consumed_at: now });
    return { ok: true, email };
  });
}

// AUTH-03 (email lane) - garbage-collect dead magic-link rows. Removes rows
// that are no longer usable (consumed OR expired) AND old enough to be past the
// audit-retention window (created_at < now - retentionMs()). Fresh, unconsumed,
// unexpired rows always survive. Without this the magic_link_tokens table grows
// without bound and verifyMagicToken's findOne full-scan degrades linearly with
// historical sign-in volume. Returns { removed } (number of rows pruned).
export function gcMagicLinkTokens(now = Date.now()) {
  const cutoff = now - retentionMs();
  const removed = remove('magic_link_tokens', (r) => {
    if (!r) return false;
    const dead = (r.consumed_at != null) || (Number.isFinite(r.exp) && r.exp < now);
    if (!dead) return false;
    const created = Number.isFinite(r.created_at) ? r.created_at : 0;
    return created < cutoff;
  });
  return { removed };
}

// AUTH-03 (email lane) - background GC scheduler. server.js calls this once at
// startup (alongside the AUTH-03 last_used flusher) on a low-frequency unref'd
// interval (default hourly) so the table self-prunes with no external cron.
// Idempotent: a second call returns the existing timer. Returns the timer (or
// null if it could not be created). stopMagicLinkGc() clears it.
let _gcTimer = null;
export function startMagicLinkGc(logger = console) {
  if (_gcTimer) return _gcTimer;
  const ms = Number(process.env.KOLM_MAGICLINK_GC_MS || 60 * 60 * 1000);
  const everyMs = Number.isFinite(ms) && ms >= 60 * 1000 ? ms : 60 * 60 * 1000;
  const tick = () => {
    try {
      const { removed } = gcMagicLinkTokens();
      if (removed > 0 && logger && typeof logger.debug === 'function') {
        logger.debug(`[auth] pruned ${removed} dead magic-link token(s)`);
      }
    } catch (e) {
      try { (logger || console).error('[auth] magic-link gc error:', e && e.message); } catch { /* deliberate: cleanup */ }
    }
  };
  _gcTimer = setInterval(tick, everyMs);
  if (_gcTimer.unref) _gcTimer.unref();
  return _gcTimer;
}
export function stopMagicLinkGc() {
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
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

// AUTH (magic-link abuse guard) - every other credential-issuing route is rate
// limited; the magic-link start/recover routes were not, so an attacker could
// loop POST /v1/auth/email/start to email-bomb any address (Resend cost +
// sender-reputation damage) and flood magic_link_tokens with rows. The
// always-200 anti-enumeration response hid existence but did nothing to throttle
// VOLUME. We add a per-IP limiter (coalesced to /24-/48 so a rotating egress
// subnet stays bounded), a secondary stricter per-email cap, AND a short
// per-email cooldown: refuse to mint a second link if an unconsumed, unexpired
// token for that email was minted in the last COOLDOWN window. The HTTP response
// stays 200 either way (anti-enumeration preserved).
function _ipKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = req.ip || xff || req.socket?.remoteAddress || 'unknown';
  const stripped = raw.replace(/^::ffff:/, '').replace(/%.*$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(stripped)) {
    const p = stripped.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (stripped.includes(':')) return stripped.split(':').slice(0, 3).join(':') + '::/48';
  return stripped || 'unknown';
}
function _emailKey(req) {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  return email || _ipKey(req);
}
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.KOLM_MAGICLINK_IP_LIMIT || '5', 10), // ~5/IP/15min
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: true, message: 'Check your email for a sign-in link.', delivery: 'queued' },
  keyGenerator: _ipKey,
  validate: { trustProxy: false },
});
const magicLinkEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.KOLM_MAGICLINK_EMAIL_LIMIT || '5', 10), // ~5/email/hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: true, message: 'Check your email for a sign-in link.', delivery: 'queued' },
  keyGenerator: _emailKey,
  validate: { trustProxy: false },
});
const _MINT_COOLDOWN_MS = (() => {
  const s = parseInt(process.env.KOLM_MAGICLINK_COOLDOWN_S || '45', 10);
  return (Number.isFinite(s) && s >= 0 ? s : 45) * 1000;
})();
// True iff an unconsumed, unexpired magic-link token for `email` was minted
// within the cooldown window (so we should NOT mint another yet).
function _withinMintCooldown(email, now = Date.now()) {
  if (_MINT_COOLDOWN_MS <= 0) return false;
  try {
    return all('magic_link_tokens').some((r) =>
      r && r.email === email && r.consumed_at == null
      && Number.isFinite(r.exp) && r.exp > now
      && Number.isFinite(r.created_at) && (now - r.created_at) < _MINT_COOLDOWN_MS);
  } catch { return false; }
}

export function mountAuthEmail(router) {
  // POST /v1/auth/email/start { email } — email a one-time sign-in link.
  router.post('/v1/auth/email/start', magicLinkLimiter, magicLinkEmailLimiter, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'valid email required' });
    }
    if (!secret()) {
      return res.status(503).json({ ok: false, error: 'magic_link_not_configured', hint: 'set RECIPE_RECEIPT_SECRET (or KOLM_MAGICLINK_SECRET) on the server' });
    }
    // Per-email cooldown: if a fresh unconsumed link already exists, do NOT mint
    // another (no new email, no new token row), but keep the anti-enumeration 200.
    if (_withinMintCooldown(email)) {
      return res.json({ ok: true, message: 'Check your email for a sign-in link.', delivery: 'queued' });
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

  // GET /v1/auth/email/verify?token=...[&mode=recover] — consume the link.
  // Default mode signs the caller in (find-or-create + session cookie). When
  // mode=recover (AUTH-06 lockout recovery), the SAME email-ownership proof is
  // used to rotate the tenant's primary key and hand back a fresh ks_ key, which
  // is the self-serve escape hatch for a tenant whose plain key was lost before
  // migration (api_key_hash unset => permanently un-authenticatable otherwise).
  router.get('/v1/auth/email/verify', (req, res) => {
    const recover = String((req.query && req.query.mode) || '') === 'recover';
    const v = verifyMagicToken(String((req.query && req.query.token) || ''));
    if (!v.ok) {
      if (req.accepts('html')) return res.redirect(302, `/signup?email_error=${encodeURIComponent(v.error)}`);
      return res.status(400).json({ ok: false, error: v.error });
    }
    if (recover) {
      const r = recoverKeyByEmail(v.email);
      if (!r.ok) {
        if (req.accepts('html')) return res.redirect(302, `/signup?email_error=${encodeURIComponent(r.reason || 'recovery_failed')}`);
        return res.status(404).json({ ok: false, error: r.reason || 'recovery_failed' });
      }
      // Drop the rotated key into the session cookie too so the browser is
      // immediately signed in with the new credential.
      setSession(res, r.api_key);
      if (req.accepts('html')) {
        return res.redirect(302, `/account/dashboard?auth=email&recovered=1`);
      }
      return res.json({ ok: true, recovered: true, api_key: r.api_key, tenant: r.tenant });
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

  // POST /v1/auth/email/recover-key { email } — AUTH-06 lockout recovery start.
  // Emails an email-verified recovery link (mode=recover). Anti-enumeration:
  // always 200, never reveals whether an account exists. Possession of the
  // emailed link is the ownership proof; the verify route does the rotation.
  router.post('/v1/auth/email/recover-key', magicLinkLimiter, magicLinkEmailLimiter, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'valid email required' });
    }
    if (!secret()) {
      return res.status(503).json({ ok: false, error: 'magic_link_not_configured', hint: 'set RECIPE_RECEIPT_SECRET (or KOLM_MAGICLINK_SECRET) on the server' });
    }
    if (_withinMintCooldown(email)) {
      return res.json({ ok: true, message: 'If that email has an account, a recovery link is on its way.', delivery: 'queued' });
    }
    let delivery = 'sent';
    try {
      const token = mintMagicToken(email);
      const link = `${baseUrl()}/v1/auth/email/verify?mode=recover&token=${encodeURIComponent(token)}`;
      const r = await sendEmail({
        to: email,
        subject: 'Your kolm key-recovery link',
        html: `<p>Click to recover access to your kolm account and get a fresh API key:</p><p><a href="${link}">Recover my kolm key</a></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email - your existing key is unchanged.</p>`,
        text: `Recover your kolm key: ${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
        tag: 'key-recovery',
      });
      delivery = (r && r.delivered) ? 'sent' : (r && r.queued) ? 'queued' : 'unknown';
    } catch { delivery = 'queued'; }
    res.json({ ok: true, message: 'If that email has an account, a recovery link is on its way.', delivery });
  });
}
