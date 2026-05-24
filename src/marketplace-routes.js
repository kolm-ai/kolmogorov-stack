// src/marketplace-routes.js
//
// W825 [T3] — HTTP routes for the Artifact Marketplace MVP.
//
// We export ONE function registerMarketplaceRoutes(r) that mounts every W825
// route onto an existing express.Router(). The one-liner mount pattern keeps
// the diff in src/router.js to one import + one call so parallel wave agents
// (WC07, WC14, W822, W824) editing router.js cannot collide on a merge.
//
// Routes (all under /v1/marketplace/w825/* to avoid collision with the W737
// /v1/marketplace/{search,listings,reviews,...} routes that already exist):
//
//   GET    /v1/marketplace/listings           — public read, browse listings.
//                                                Returns {ok, rows[], total,
//                                                page, limit, sort_by}.
//   POST   /v1/marketplace/upload             — publish a new listing.
//                                                Auth-gated; requires manifest
//                                                signature verification.
//                                                400 on signature_invalid.
//   GET    /v1/marketplace/download/:id       — stream artifact bytes.
//                                                Records download counter.
//                                                402 if listing.paid AND
//                                                tenant lacks entitlement.
//   POST   /v1/marketplace/finetune           — queue a transfer-learning
//                                                fine-tune from a marketplace
//                                                artifact_id. Auth-gated.
//   POST   /v1/marketplace/rate               — submit 1-5 star rating +
//                                                review_text. Anti-gaming:
//                                                403 unless account_age >= 7d
//                                                AND has prior download.
//   GET    /v1/marketplace/ratings/:id        — public read of aggregate
//                                                ratings + raw rating rows.
//   POST   /v1/marketplace/payout-cycle       — admin/forecast: aggregate
//                                                revenue ledger and emit
//                                                payout rows. Auth-gated.
//
// All POST routes are auth-gated. publisher_tenant_id / tenant_id on writes
// is FORCED from req.tenant_record.id so a tenant cannot register under
// another publisher's name (W411 tenant fence).
//
// Honest envelopes: empty results return {ok:true, rows:[], total:0}; error
// paths return {ok:false, error:'<code>', detail}.

import fs from 'node:fs';
import path from 'node:path';
import {
  listListings,
  getListing,
  upsertListing,
  recordDownload,
  _listingsPath,
  W825_VERTICALS,
  W825_TASK_TYPES,
  W825_HARDWARE_TARGETS,
  W825_SORT_MODES,
  MARKETPLACE_W825_VERSION,
} from './marketplace-w825.js';
import { rate, getRatings, recordDownloadEvent, MIN_ACCOUNT_AGE_DAYS } from './marketplace-ratings.js';
import { finetuneFromMarketplace } from './marketplace-finetune.js';
import { payoutCycle, recordRevenue, calcPayout } from './marketplace-payouts.js';
import { verify as ed25519Verify } from './ed25519.js';
import { tryAppendAudit } from './audit.js';

function _authOrReject(req, res) {
  const t = req && req.tenant_record;
  if (!t || !t.id) {
    res.status(401).json({
      ok: false,
      error: 'auth_required',
      hint: 'send Authorization: Bearer <ks_* or kao_* key>',
      version: MARKETPLACE_W825_VERSION,
    });
    return null;
  }
  return t;
}

// _verifyManifestSignature(manifest_sha256, signature_b64, public_key_pem):
// honest signature check. If no signature material is provided we return
// {ok:false, reason:'missing'} so the caller can map to HTTP 400. If a
// signature is provided but no public_key is registered for the tenant, we
// return {ok:false, reason:'no_public_key'}. A real verify failure returns
// {ok:false, reason:'invalid'}.
function _verifyManifestSignature({ manifest_sha256, signature_b64, public_key_pem }) {
  if (!manifest_sha256) return { ok: false, reason: 'missing_manifest_sha256' };
  if (!signature_b64) return { ok: false, reason: 'missing_signature' };
  if (!public_key_pem) return { ok: false, reason: 'missing_public_key' };
  try {
    const sigB64Url = String(signature_b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const ok = ed25519Verify(public_key_pem, manifest_sha256, sigB64Url);
    return { ok, reason: ok ? 'ok' : 'invalid' };
  } catch (e) {
    return { ok: false, reason: 'verify_threw', detail: String(e && e.message || e) };
  }
}

// _tenantHasEntitlement(tenant, listing): paid-listing gate. For W825 MVP we
// treat the tenant as entitled when the listing's publisher == tenant (self-
// download is always allowed), OR the tenant.plan is one of the paid tiers
// (any plan != 'anon' && != 'free'), OR the tenant has an explicit
// `entitlements` map carrying the listing id.
function _tenantHasEntitlement(tenant, listing) {
  if (!tenant || !listing) return false;
  if (listing.publisher_tenant_id === tenant.id) return true;
  if (!listing.paid) return true; // free listing => always entitled
  const plan = String(tenant.plan || 'free').toLowerCase();
  if (plan && plan !== 'free' && plan !== 'anon') return true;
  if (tenant.entitlements && typeof tenant.entitlements === 'object') {
    if (tenant.entitlements[listing.id] === true) return true;
  }
  return false;
}

export function registerMarketplaceRoutes(r) {
  // ---------------- GET /v1/marketplace/listings ----------------
  // Public read. Returns {ok:true, rows, total, page, limit, sort_by, all_count}.
  r.get('/v1/marketplace/listings', (req, res) => {
    try {
      const q = req.query || {};
      const env = listListings({
        vertical: q.vertical,
        task_type: q.task_type,
        k_score_min: q.k_score_min,
        hardware: q.hardware,
        teacher: q.teacher,
        sort_by: q.sort_by,
        page: q.page,
        limit: q.limit,
        paid: q.paid === 'true' ? true : q.paid === 'false' ? false : undefined,
      });
      return res.json({ ok: true, ...env });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'marketplace_listings_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  // ---------------- GET /v1/marketplace/facets ----------------
  // Pure read: returns the enum set so the UI sidebar can render filter
  // chips without hard-coding the lists in two places.
  r.get('/v1/marketplace/facets', (req, res) => {
    return res.json({
      ok: true,
      verticals: W825_VERTICALS,
      task_types: W825_TASK_TYPES,
      hardware_targets: W825_HARDWARE_TARGETS,
      sort_modes: W825_SORT_MODES,
      version: MARKETPLACE_W825_VERSION,
    });
  });

  // ---------------- POST /v1/marketplace/upload ----------------
  // Auth-gated. Body: {artifact_uri, manifest_sha256, signature_b64,
  // public_key_pem, id, title, vertical, task_type, hardware_targets[],
  // k_score, teacher_model, paid, price_micro_usd}.
  //
  // publisher_tenant_id is FORCED from req.tenant_record.id.
  r.post('/v1/marketplace/upload', async (req, res) => {
    const tenant = _authOrReject(req, res);
    if (!tenant) return;
    try {
      const body = req.body || {};
      const sig = _verifyManifestSignature({
        manifest_sha256: body.manifest_sha256,
        signature_b64: body.signature_b64,
        public_key_pem: body.public_key_pem || tenant.publisher_public_key_pem,
      });
      if (!sig.ok) {
        return res.status(400).json({
          ok: false,
          error: 'signature_invalid',
          reason: sig.reason,
          detail: sig.detail,
          version: MARKETPLACE_W825_VERSION,
        });
      }
      const listing = upsertListing({
        id: body.id,
        publisher_tenant_id: tenant.id, // W411 tenant fence
        title: body.title,
        vertical: body.vertical,
        task_type: body.task_type,
        k_score: body.k_score,
        hardware_targets: body.hardware_targets,
        teacher_model: body.teacher_model,
        artifact_uri: body.artifact_uri,
        manifest_sha256: body.manifest_sha256,
        signature_b64: body.signature_b64,
        paid: body.paid,
        price_micro_usd: body.price_micro_usd,
      });
      // Audit row — append-only chain. Best-effort; never fail the request on
      // a chain write.
      try {
        await tryAppendAudit({
          tenant_id: tenant.id,
          op: 'marketplace.upload',
          actor: tenant.id,
          target: listing.id,
          attributes: {
            manifest_sha256: listing.manifest_sha256,
            paid: listing.paid,
            price_micro_usd: listing.price_micro_usd,
            version: MARKETPLACE_W825_VERSION,
          },
        });
      } catch (_e) { /* best-effort */ }
      return res.status(201).json({ ok: true, listing, version: MARKETPLACE_W825_VERSION });
    } catch (e) {
      if (e && e.code === 'LISTING_INVALID') {
        return res.status(400).json({
          ok: false,
          error: 'listing_invalid',
          detail: String(e.message || e),
          version: MARKETPLACE_W825_VERSION,
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'marketplace_upload_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  // ---------------- GET /v1/marketplace/download/:id ----------------
  // Auth-gated. Streams artifact_uri bytes; records download counter.
  // 402 if listing.paid AND tenant lacks entitlement.
  r.get('/v1/marketplace/download/:id', async (req, res) => {
    const tenant = _authOrReject(req, res);
    if (!tenant) return;
    try {
      const id = String(req.params.id || '');
      const listing = getListing(id);
      if (!listing) {
        return res.status(404).json({
          ok: false,
          error: 'unknown_listing_id',
          id,
          version: MARKETPLACE_W825_VERSION,
        });
      }
      if (!_tenantHasEntitlement(tenant, listing)) {
        return res.status(402).json({
          ok: false,
          error: 'payment_required',
          listing_id: listing.id,
          price_micro_usd: listing.price_micro_usd,
          hint: 'upgrade your plan or purchase entitlement to download paid listings',
          version: MARKETPLACE_W825_VERSION,
        });
      }
      // Record download counter (on the listing) + per-tenant event (for
      // anti-gaming check on the rate route).
      recordDownload(listing.id);
      recordDownloadEvent({ listing_id: listing.id, tenant_id: tenant.id });
      // Ledger row for revenue share — only paid listings.
      if (listing.paid && listing.price_micro_usd > 0) {
        await recordRevenue({
          listing_id: listing.id,
          publisher_tenant_id: listing.publisher_tenant_id,
          micro_usd: listing.price_micro_usd,
        });
      }
      // Audit (best-effort).
      try {
        await tryAppendAudit({
          tenant_id: tenant.id,
          op: 'marketplace.download',
          actor: tenant.id,
          target: listing.id,
          attributes: {
            paid: listing.paid,
            price_micro_usd: listing.price_micro_usd,
            manifest_sha256: listing.manifest_sha256,
            version: MARKETPLACE_W825_VERSION,
          },
        });
      } catch (_e) { /* best-effort */ }
      // Stream the bytes. If the artifact_uri is remote, surface as 501 — the
      // MVP only streams local files. (Future revisions can proxy s3:// / https://.)
      const uri = listing.artifact_uri;
      if (!uri) {
        return res.status(503).json({
          ok: false,
          error: 'artifact_uri_missing',
          listing_id: listing.id,
          version: MARKETPLACE_W825_VERSION,
        });
      }
      if (!_isLocalPath(uri)) {
        return res.status(501).json({
          ok: false,
          error: 'remote_artifact_uri_not_yet_streamed',
          listing_id: listing.id,
          artifact_uri: uri,
          hint: 'MVP streams local file paths only; remote URIs forthcoming',
          version: MARKETPLACE_W825_VERSION,
        });
      }
      if (!fs.existsSync(uri)) {
        return res.status(410).json({
          ok: false,
          error: 'artifact_gone',
          listing_id: listing.id,
          version: MARKETPLACE_W825_VERSION,
        });
      }
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="${listing.id}.kolm"`);
      res.set('X-Kolm-Manifest-Sha256', listing.manifest_sha256 || '');
      res.set('X-Kolm-Listing-Id', listing.id);
      res.set('X-Kolm-Marketplace-Version', MARKETPLACE_W825_VERSION);
      return fs.createReadStream(uri).pipe(res);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'marketplace_download_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  // ---------------- POST /v1/marketplace/finetune ----------------
  // Auth-gated. Queue a transfer-learning fine-tune from a marketplace artifact.
  r.post('/v1/marketplace/finetune', async (req, res) => {
    const tenant = _authOrReject(req, res);
    if (!tenant) return;
    try {
      const body = req.body || {};
      const env = await finetuneFromMarketplace({
        artifact_id: body.artifact_id || body.base_artifact_id || body.id,
        tenant_id: tenant.id,
        captures_namespace: body.captures_namespace || body.namespace,
        k_target: body.k_target,
        max_steps: body.max_steps,
      });
      if (!env.ok) {
        const status = env.error === 'unknown_artifact_id' ? 404 : 400;
        return res.status(status).json(env);
      }
      return res.status(202).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'marketplace_finetune_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  // ---------------- POST /v1/marketplace/rate ----------------
  // Auth-gated. Anti-gaming: 403 unless account_age >= 7d AND prior download.
  r.post('/v1/marketplace/rate', async (req, res) => {
    const tenant = _authOrReject(req, res);
    if (!tenant) return;
    try {
      const body = req.body || {};
      const row = rate({
        tenant,
        listing_id: body.listing_id || body.id,
        stars: body.stars != null ? body.stars : body.rating,
        review_text: body.review_text || body.text,
      });
      try {
        await tryAppendAudit({
          tenant_id: tenant.id,
          op: 'marketplace.rate',
          actor: tenant.id,
          target: row.listing_id,
          attributes: {
            stars: row.stars,
            text_len: row.review_text.length,
            version: MARKETPLACE_W825_VERSION,
          },
        });
      } catch (_e) { /* best-effort */ }
      return res.status(201).json({ ok: true, rating: row, version: MARKETPLACE_W825_VERSION });
    } catch (e) {
      if (e && e.code === 'RATING_FORBIDDEN') {
        return res.status(403).json({
          ok: false,
          error: 'rating_forbidden',
          reason: e.reason || 'gate_failed',
          detail: String(e.message || e),
          version: MARKETPLACE_W825_VERSION,
        });
      }
      if (e && e.code === 'RATING_INVALID') {
        return res.status(400).json({
          ok: false,
          error: 'rating_invalid',
          detail: String(e.message || e),
          version: MARKETPLACE_W825_VERSION,
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'marketplace_rate_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  // ---------------- GET /v1/marketplace/ratings/:id ----------------
  // Public read of aggregate ratings.
  r.get('/v1/marketplace/ratings/:id', (req, res) => {
    try {
      const id = String(req.params.id || '');
      const env = getRatings(id);
      return res.json({ ok: true, listing_id: id, ...env, version: MARKETPLACE_W825_VERSION });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'marketplace_ratings_read_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  // ---------------- POST /v1/marketplace/payout-cycle ----------------
  // Auth-gated. Forecast-only: aggregates revenue ledger and emits payout
  // audit rows. Returns the per-listing split.
  r.post('/v1/marketplace/payout-cycle', async (req, res) => {
    const tenant = _authOrReject(req, res);
    if (!tenant) return;
    try {
      const body = req.body || {};
      const env = await payoutCycle(body.period);
      return res.json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'marketplace_payout_error',
        detail: String(e && e.message || e),
        version: MARKETPLACE_W825_VERSION,
      });
    }
  });

  return r;
}

function _isLocalPath(uri) {
  if (typeof uri !== 'string' || !uri) return false;
  if (/^https?:\/\//i.test(uri)) return false;
  if (/^s3:\/\//i.test(uri)) return false;
  if (/^gs:\/\//i.test(uri)) return false;
  return true;
}
