// W751-W755 - Vertical foundation students.
//
// Five verticals (legal, medical, code, finance, support) each get:
//   [W7Vx-1] Fingerprint capture lake by vertical - W757-blocked, honest stub
//   [W7Vx-2] Pre-train base student per vertical - W715/W757-blocked, honest stub
//   [W7Vx-3] Publish kolm-V-7b to marketplace - register with honest
//                                                       "pending compilation" envelope
//   [W7Vx-4] Landing page /verticals/V.html - case-study skeleton
//
// W751-W755 items 1+2 (vertical fingerprint + per-vertical pre-train) require
// the W757 fingerprinting pipeline + W715 cross-namespace transfer math. Both
// are still on the W707 plan but not shipped. This module ships items 3+4 now
// (marketplace stub + landing pages + CLI/API surface) and stamps items 1+2
// with an honest "blocked_by:W757" envelope so a caller invoking the future
// fingerprint surface gets a real-shape "not_yet_implemented" reply, not a
// 404 or a silent placeholder.
//
// Honesty contract (W737 marketplace integration):
//   - Stub artifacts register through src/marketplace-store.js with
//     pending_distill:true, not_kolm_compiled:true, kscore:null. NEVER fake
//     a K-Score on a stub. The marketplace surface treats kscore:null as
//     "not yet measured" (the W737 facet search already supports nulls).
//   - cid is the literal string 'pending_<id>' so a buyer browsing the
//     marketplace can see "this slot is reserved for kolm-<id>-7b but the
//     student has not been distilled yet". Once W757 + W715 ship the real
//     distill pipeline, the cid will flip to a real sha256-pinned content
//     hash and the pending_distill flag will clear.
//
// Brand-lock: NO emoji icons in the catalog data - the standing user rule
// bans emojis from shipped artifacts/files. Landing pages use pure CSS for
// visual differentiation; the vertical metadata carries only string fields.

import { registerArtifact, getListingByCid } from './marketplace-store.js';

export const VERTICALS_VERSION = 'w751-v1';
export const VERTICALS_CONTRACT_VERSION = 'w732-verticals-v1';
export const VERTICALS_DEFAULT_PUBLISHER_ID = 'kolm.ai-foundation';
export const VERTICALS_LIMITS = Object.freeze({
  max_vertical_id_chars: 64,
  max_publisher_id_chars: 128,
  max_common_tasks: 8,
  min_catalog_rows: 5,
});

const SAFE_VERTICAL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_PUBLISHER_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function _cleanText(value, maxChars) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > maxChars) return null;
  return s;
}

export function normalizeVerticalId(id) {
  const cleaned = _cleanText(id, VERTICALS_LIMITS.max_vertical_id_chars);
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase();
  return SAFE_VERTICAL_ID_RE.test(normalized) ? normalized : null;
}

export function verticalIdForEnvelope(id) {
  return normalizeVerticalId(id) || 'unknown';
}

export function normalizeVerticalPublisherId(publisher) {
  const cleaned = _cleanText(
    publisher == null || publisher === '' ? VERTICALS_DEFAULT_PUBLISHER_ID : publisher,
    VERTICALS_LIMITS.max_publisher_id_chars,
  );
  return cleaned && SAFE_PUBLISHER_ID_RE.test(cleaned) ? cleaned : VERTICALS_DEFAULT_PUBLISHER_ID;
}

// VERTICALS - frozen catalog of the 5 W751-W755 verticals.
//
// Schema:
//   id - lowercase string, URL-safe (matches the
//                          /verticals/<id>.html landing page filename)
//   name - human-readable title-case (UI display)
//   tagline - one-line marketing description (landing page lede)
//   target_kscore - the K-Score target the eventual distilled student
//                          should hit; surfaced on the landing page as the
//                          "goal" pill. Honest: the live kscore is null until
//                          the student is compiled, target is the spec target.
//   common_tasks - the 5 most common tasks for this vertical; the
//                          first entry doubles as the registered task_type on
//                          the marketplace stub (W737 task_type facet).
//   model_slug - canonical foundation-student slug
//                          ('kolm-<id>-7b'). Matches the marketplace listing
//                          slug AND the future kolm-pull artifact name.
//   marketplace_status - always 'pending_distill' at W751-v1 (until the
//                          W757 + W715 pipeline produces a real compile).
//
// Frozen via Object.freeze on each entry AND on the outer array. Tests pin
// the exact id order so any future re-order is a deliberate breaking change.
export const VERTICALS = Object.freeze([
  Object.freeze({
    id: 'legal',
    name: 'Legal',
    tagline: 'Contract review, discovery, citation-grounded research',
    target_kscore: 0.92,
    common_tasks: Object.freeze([
      'contract_summary',
      'citation_extraction',
      'case_law_search',
      'redline',
      'discovery_triage',
    ]),
    model_slug: 'kolm-legal-7b',
    marketplace_status: 'pending_distill',
  }),
  Object.freeze({
    id: 'medical',
    name: 'Medical',
    tagline: 'Patient summaries, coding, clinical decision support',
    target_kscore: 0.90,
    common_tasks: Object.freeze([
      'patient_summary',
      'icd10_coding',
      'soap_note',
      'triage',
      'medication_check',
    ]),
    model_slug: 'kolm-medical-7b',
    marketplace_status: 'pending_distill',
  }),
  Object.freeze({
    id: 'code',
    name: 'Code',
    tagline: 'Code review, generation, refactoring with team conventions',
    target_kscore: 0.88,
    common_tasks: Object.freeze([
      'code_review',
      'generation',
      'refactor',
      'pr_summary',
      'bug_triage',
    ]),
    model_slug: 'kolm-code-7b',
    marketplace_status: 'pending_distill',
  }),
  Object.freeze({
    id: 'finance',
    name: 'Finance',
    tagline: 'Risk analysis, compliance, structured-data extraction',
    target_kscore: 0.93,
    common_tasks: Object.freeze([
      'risk_analysis',
      'compliance_check',
      'filing_parse',
      'transaction_classification',
      'aml_screening',
    ]),
    model_slug: 'kolm-finance-7b',
    marketplace_status: 'pending_distill',
  }),
  Object.freeze({
    id: 'support',
    name: 'Support',
    tagline: 'Customer support routing, response generation, escalation',
    target_kscore: 0.91,
    common_tasks: Object.freeze([
      'response_drafting',
      'sentiment_routing',
      'ticket_summary',
      'escalation_detect',
      'kb_lookup',
    ]),
    model_slug: 'kolm-support-7b',
    marketplace_status: 'pending_distill',
  }),
]);

// W737 task-type facet supports a narrow enum (extraction/generation/
// reasoning/support). Map the vertical's first common-task to one of those
// buckets so the marketplace facet search keeps working when the stubs land.
function _mapTaskToW737Facet(task) {
  const t = String(task || '').toLowerCase();
  if (/extract|parse|coding|filing|citation|triage|summary|lookup/.test(t)) return 'extraction';
  if (/generation|drafting|refactor/.test(t)) return 'generation';
  if (/review|analysis|check|search|screening/.test(t)) return 'reasoning';
  return 'support';
}

// getVertical(id) - returns the frozen vertical entry or null.
//
// Case-insensitive on the id so /v1/verticals/LEGAL returns the same row as
// /v1/verticals/legal. Returns null (NOT throws) for an unknown id so the
// route handler can map to a 404 + honest envelope.
export function getVertical(id) {
  const want = normalizeVerticalId(id);
  if (!want) return null;
  return VERTICALS.find((v) => v.id === want) || null;
}

// listVerticals() - returns the frozen array. Exposed as a function (not a
// re-export) so the route handler can wrap it in an honest envelope without
// callers mutating the underlying frozen catalog.
export function listVerticals() {
  return VERTICALS;
}

// registerVerticalArtifact(vertical_id, publisher) - registers a stub
// artifact entry in the W737 marketplace with the honest-pending shape.
//
// The cid is 'pending_<id>' so:
//   - The slot is visible in the catalog (buyers see "kolm-<id>-7b" reserved).
//   - Filtering on pending_distill:true surfaces just the foundation roadmap.
//   - When W757+W715 produce the real compile, the new artifact registers
//     with a real sha256 cid and this stub stays in the ledger as the
//     "foundation announcement" entry (event-store append-only).
//
// Honesty contract - every field that the marketplace surface might use to
// imply readiness is explicitly null/false:
//   - kscore: null              (NEVER fake; W737 facet supports null)
//   - pending_distill: true     (visible-in-catalog pending flag)
//   - not_kolm_compiled: true   (W737 install path can reject)
//   - blocked_by: ['W757','W715'] (audit trail of what's needed)
//
// Returns the persisted listing row from src/marketplace-store.js.
export async function registerVerticalArtifact(vertical_id, publisher = 'kolm.ai-foundation') {
  const requestedId = normalizeVerticalId(vertical_id);
  const vertical = getVertical(requestedId);
  if (!vertical) {
    const e = new Error('unknown_vertical');
    e.code = 'UNKNOWN_VERTICAL';
    e.vertical_id = requestedId || 'unknown';
    throw e;
  }
  const publisherId = normalizeVerticalPublisherId(publisher);
  const manifest = {
    name: vertical.model_slug,
    description:
      'Foundation student for ' + vertical.name +
      ' - pending W751-W755 compilation (W757 fingerprinting required)',
    contract_version: VERTICALS_CONTRACT_VERSION,
    catalog_version: VERTICALS_VERSION,
    vertical: vertical.id,
    common_tasks: vertical.common_tasks.slice(),
    target_kscore: vertical.target_kscore,
    pending_distill: true,
    not_kolm_compiled: true,
    blocked_by: ['W757', 'W715'],
    // Explicit null so a manifest reader cannot interpret a missing key as
    // "K-Score is present but the value is undefined." Tests pin this.
    k_score: null,
  };
  const listing = await registerArtifact({
    cid: 'pending_' + vertical.id,
    publisher_id: publisherId,
    vertical: vertical.id,
    task_type: _mapTaskToW737Facet(vertical.common_tasks[0]),
    hardware_target: 'rtx',
    price_micro_usd_per_call: 0,
    manifest,
  });
  return listing;
}

// registerAllVerticalStubs(publisher) - bulk-register all 5 verticals.
//
// Idempotent: if a stub for a given slug already exists (the slug is
// 'pending_<id>' which is also the cid, and getListingByCid is checked
// before re-registering), we skip the row. Re-runs are safe.
//
// Returns { registered:[slug, ...], skipped:[slug, ...] } so the route
// handler can report the diff.
export async function registerAllVerticalStubs(publisher = 'kolm.ai-foundation') {
  const registered = [];
  const skipped = [];
  const publisherId = normalizeVerticalPublisherId(publisher);
  for (const v of VERTICALS) {
    const cid = 'pending_' + v.id;
    const existing = await getListingByCid(cid);
    if (existing) {
      skipped.push(v.model_slug);
      continue;
    }
    await registerVerticalArtifact(v.id, publisherId);
    registered.push(v.model_slug);
  }
  return {
    ok: true,
    version: VERTICALS_VERSION,
    contract_version: VERTICALS_CONTRACT_VERSION,
    registered,
    skipped,
    total: VERTICALS.length,
  };
}

// verticalFingerprintStub(vertical_id) - W751 honest envelope for the W757-
// blocked fingerprint surface.
//
// SYNC contract preserved (W751 #7 + #14 sibling tests pin the literal
// envelope shape). The W757 pattern lake is ASYNCHRONOUS by necessity (it
// reads the event-store) so wiring it directly into this function would
// break the sync sibling test contract and the express route handler that
// invokes `res.json(verticalFingerprintStub(req.params.id))` without await.
//
// The W757 lake surface is exposed as src/pattern-lake.js#extractVerticalFingerprint
// (async). New code SHOULD call that surface directly:
//
//     import { extractVerticalFingerprint } from './pattern-lake.js';
//     const fp = await extractVerticalFingerprint(vertical_id);
//
// This stub kept its name + sync signature to preserve byte-stable behavior
// for callers that linked against the pre-W757 envelope shape. The W757
// route handlers (POST /v1/lake/* + the trends GET) use the lake module
// directly; the legacy GET /v1/verticals/:id/fingerprint continues to call
// this sync stub for backward compatibility.
export function verticalFingerprintStub(vertical_id) {
  const v = getVertical(vertical_id);
  // Even unknown verticals return the same not-yet-shipped envelope when this
  // helper is called directly. The route maps unknown-id to 404 first; direct
  // callers still get a bounded, non-leaky identifier.
  return {
    ok: false,
    error: 'w757_not_shipped',
    blocked_by: 'W757',
    vertical: v ? v.id : verticalIdForEnvelope(vertical_id),
    hint:
      'vertical fingerprint extraction requires W757 - coming in plan. ' +
      'Until then, capture per-namespace via /v1/capture/log and distill ' +
      'through /v1/distill. For the W757-wired async surface, call ' +
      'extractVerticalFingerprint(id) from src/pattern-lake.js.',
    version: VERTICALS_VERSION,
    contract_version: VERTICALS_CONTRACT_VERSION,
    // W757 sub-envelope (additive; pre-W757 callers see {ok,error,blocked_by,
    // vertical,hint,version} verbatim). The async lake surface is the canonical
    // path; this hint helps a consumer discover it.
    lake_surface_async: 'src/pattern-lake.js#extractVerticalFingerprint',
    lake_version: 'w757-v1',
  };
}
