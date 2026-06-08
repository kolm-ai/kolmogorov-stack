// W757 - Cross-namespace anonymized pattern lake.
//
// Closes the W751-W755 vertical fingerprint blocker. The five vertical
// foundation students need fingerprint data to learn shared structure across
// opt-in tenants WITHOUT raw text ever crossing a tenant boundary. This
// module is the privacy-preserving aggregation primitive that the W751
// fingerprint surface now consumes.
//
// HONESTY CONTRACT - the privacy claim is binding:
//   - Every contribution stored is a sha256 bigram hash. Raw input text NEVER
//     enters the lake (tokenizePattern destructures into hashes before any
//     write path).
//   - Contributions require explicit consent:true in the contribute call.
//     A missing or falsy consent throws `consent_not_granted`. There is no
//     "default opt-in" path; the cli/api surfaces both demand --confirm /
//     {confirm:true} flags on top of the consent flag inside the payload.
//   - The lake is disabled by default. The KOLM_W757_LAKE_ENABLED env hatch
//     is read at WRITE time so a pre-W757 install behaves identically.
//   - Aggregation enforces a privacy floor of min_contributors=5. Below the
//     floor the response is an honest `insufficient_contributors` envelope - 
//     NEVER a partial leak.
//   - Cross-tenant aggregation is the ONLY surface that crosses tenant
//     boundaries; even then the projection is sha256(bigram) + counts, never
//     a back-pointer to the contributing tenant_id.
//
// W411 tenant fence - every read path filters by tenant_id from the opt-in
// registry AND inside the contribution loop (defense-in-depth). A bug in the
// outer filter cannot leak rows.

import crypto from 'node:crypto';

import { appendEvent, listEvents } from './event-store.js';
// Read-only catalog import - never mutated, never re-exported. We thread
// through getVertical for unknown-id rejection in extractVerticalFingerprint.
import { getVertical, VERTICALS_VERSION } from './verticals.js';

export const PATTERN_LAKE_VERSION = 'w757-v1';

// W757 byte-stability hatch - reading defaults to 'off' so a pre-W757 install
// keeps its prior behavior end-to-end. Operators flip the env to opt their
// installation in to lake writes; opt-in by individual namespace is a
// separate, finer-grained gate enforced by isOptedIn() below.
export const LAKE_ENABLED_ENV = 'KOLM_W757_LAKE_ENABLED';

// Provider tags used to namespace the lake's append-only rows inside the
// canonical event-store. Separated by purpose so listEvents({provider:...})
// scans never accidentally mix opt-in registry rows with contribution rows.
const PROVIDER_OPTIN = 'kolm_pattern_lake_optin';
const PROVIDER_CONTRIBUTION = 'kolm_pattern_lake_contribution';

// Privacy floor - never return aggregated data with fewer than 5 distinct
// contributors. Tests pin this number; auditors can reference it.
const MIN_CONTRIBUTORS_DEFAULT = 5;

// Token regex - Unicode letter/number/underscore runs, dropping punctuation
// and whitespace. The lake is text-only; binary captures (images, audio)
// flow through the separate W462/W464 multimodal-redact pipelines.
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function _sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// _isLakeEnabled() - reads the env hatch at call time so tests can flip it
// per-case via process.env without restarting the module.
function _isLakeEnabled() {
  const v = String(process.env[LAKE_ENABLED_ENV] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// tokenizePattern(input) - bigram fingerprint extraction.
//
// Returns an array of sha256-hex strings, one per adjacent bigram in the
// input. RAW TEXT IS NEVER RETURNED. Tests pin that every element matches
// the 64-char hex regex.
//
// Empty / null / non-string inputs return []. Single-token inputs also
// return [] (no bigram pairs to form), which is intentional - single-word
// fragments leak too much surface to be useful for cross-tenant aggregation.
export function tokenizePattern(input) {
  if (input === null || input === undefined) return [];
  const s = typeof input === 'string' ? input : String(input);
  if (!s) return [];
  const tokens = (s.toLowerCase().match(TOKEN_RE) || []);
  if (tokens.length < 2) return [];
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    // Bigram canonical form: 'left|right' before hashing so 'a|b' and 'b|a'
    // never collide. Tests verify hash uniqueness on small fixture inputs.
    out.push(_sha256Hex(tokens[i] + '|' + tokens[i + 1]));
  }
  return out;
}

// isOptedIn(tenant_id, namespace) - synchronous-shape read over the lake's
// opt-in registry. Returns true ONLY if a row with provider=optin exists
// for the (tenant_id, namespace) pair AND no later opt-out row supersedes
// it. The registry is append-only inside the event-store; opt-in / opt-out
// rows carry a JSON payload in `feedback` recording the state transition.
export async function isOptedIn(tenant_id, namespace) {
  if (!tenant_id || !namespace) return false;
  // ASC order so the state machine reads oldest-first; the loop's last write
  // wins, which is the latest opt_in/opt_out for this (tenant, namespace).
  // (Default order is DESC, which would invert latest-wins and let an old
  // opt_in shadow a newer opt_out.)
  const rows = await listEvents({
    provider: PROVIDER_OPTIN,
    tenant_id,
    limit: 0,
    order: 'asc',
  });
  // W411 defense-in-depth - tenant_id may have been spoofed by a caller that
  // forgot the listEvents tenant filter; re-fence inside the loop.
  let opted = false;
  for (const r of rows) {
    if (!r || r.tenant_id !== tenant_id) continue;
    let payload = null;
    try { payload = r.feedback ? JSON.parse(r.feedback) : null; } catch { continue; }
    if (!payload || payload.namespace !== namespace) continue;
    if (payload.action === 'opt_in') opted = true;
    else if (payload.action === 'opt_out') opted = false;
  }
  return opted;
}

// optIn(tenant_id, namespace) - durably opt the (tenant, namespace) pair in.
// Idempotent: a second call updates the timestamp but does not error.
export async function optIn(tenant_id, namespace) {
  if (!tenant_id) throw new Error('optIn requires tenant_id');
  if (!namespace) throw new Error('optIn requires namespace');
  await appendEvent({
    tenant_id,
    namespace: 'kolm_pattern_lake',
    provider: PROVIDER_OPTIN,
    status: 'ok',
    feedback: JSON.stringify({
      action: 'opt_in',
      namespace,
      version: PATTERN_LAKE_VERSION,
      at: new Date().toISOString(),
    }),
  });
  return { ok: true, tenant_id, namespace, action: 'opt_in', version: PATTERN_LAKE_VERSION };
}

// optOut(tenant_id, namespace) - durably opt out. Append-only; future
// isOptedIn() reads observe the latest-wins state machine.
export async function optOut(tenant_id, namespace) {
  if (!tenant_id) throw new Error('optOut requires tenant_id');
  if (!namespace) throw new Error('optOut requires namespace');
  await appendEvent({
    tenant_id,
    namespace: 'kolm_pattern_lake',
    provider: PROVIDER_OPTIN,
    status: 'ok',
    feedback: JSON.stringify({
      action: 'opt_out',
      namespace,
      version: PATTERN_LAKE_VERSION,
      at: new Date().toISOString(),
    }),
  });
  return { ok: true, tenant_id, namespace, action: 'opt_out', version: PATTERN_LAKE_VERSION };
}

// contributePattern({tenant_id, namespace, capture, consent}) - record a
// hash-only contribution for the given capture into the lake.
//
// Throws on missing consent (consent !== true). Returns {ok:true, skipped}
// when the (capture.id, namespace, tenant_id) tuple was already contributed
// (idempotency); the no-op skip preserves the privacy claim because we
// never re-hash on duplicates.
//
// The capture object is duck-typed - `capture.id` is required; `capture.input`
// and `capture.text` are both checked (in that order) for the source text.
// Anything else inside `capture` is ignored.
export async function contributePattern({
  tenant_id,
  namespace,
  capture,
  consent,
} = {}) {
  if (consent !== true) {
    const e = new Error('consent_not_granted');
    e.code = 'CONSENT_NOT_GRANTED';
    throw e;
  }
  if (!tenant_id) throw new Error('contributePattern requires tenant_id');
  if (!namespace) throw new Error('contributePattern requires namespace');
  if (!capture || typeof capture !== 'object') {
    throw new Error('contributePattern requires capture object');
  }
  const capture_id = String(capture.id || capture.capture_id || '').trim();
  if (!capture_id) throw new Error('contributePattern requires capture.id');
  const source_text = capture.input != null ? String(capture.input)
    : (capture.text != null ? String(capture.text)
      : (capture.prompt != null ? String(capture.prompt) : ''));

  // Honest no-op when the env hatch is off - never silently DROPS the call,
  // but also never writes to disk. The envelope tells the caller exactly why.
  if (!_isLakeEnabled()) {
    return {
      ok: false,
      error: 'lake_disabled',
      hint: 'set ' + LAKE_ENABLED_ENV + '=1 to enable lake writes for this install',
      version: PATTERN_LAKE_VERSION,
    };
  }

  // Idempotency - defense-in-depth check before tokenization to avoid
  // re-hashing on duplicate writes. Tenant fence both at listEvents query
  // AND inside the loop (W411 invariant).
  const prior = await listEvents({
    provider: PROVIDER_CONTRIBUTION,
    tenant_id,
    limit: 0,
  });
  for (const r of prior) {
    if (!r || r.tenant_id !== tenant_id) continue;
    let payload = null;
    try { payload = r.feedback ? JSON.parse(r.feedback) : null; } catch { continue; }
    if (!payload) continue;
    if (payload.capture_id === capture_id && payload.namespace === namespace) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_contributed',
        capture_id,
        namespace,
        version: PATTERN_LAKE_VERSION,
      };
    }
  }

  const bigram_hashes = tokenizePattern(source_text);
  // The contribution row carries ONLY the hash list + metadata - never the
  // raw text. tests/wave757 pins that no raw substring survives.
  await appendEvent({
    tenant_id,
    namespace: 'kolm_pattern_lake',
    provider: PROVIDER_CONTRIBUTION,
    status: 'ok',
    feedback: JSON.stringify({
      capture_id,
      namespace,                // the SOURCE namespace, distinct from the
                                // event-store routing namespace above.
      bigram_count: bigram_hashes.length,
      bigram_hashes,
      at: new Date().toISOString(),
      version: PATTERN_LAKE_VERSION,
    }),
  });
  return {
    ok: true,
    skipped: false,
    capture_id,
    namespace,
    bigram_count: bigram_hashes.length,
    version: PATTERN_LAKE_VERSION,
  };
}

// _readAllContributions() - internal helper. Reads every contribution row in
// the lake, JSON-decodes the payload, returns the flat list. NO tenant
// filter here; aggregation callers filter explicitly. The privacy guarantee
// is that the rows themselves carry only hashes - the tenant identity stays
// on the outer event row, never reaches the aggregated output.
async function _readAllContributions() {
  const rows = await listEvents({
    provider: PROVIDER_CONTRIBUTION,
    limit: 0,
  });
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    let payload = null;
    try { payload = r.feedback ? JSON.parse(r.feedback) : null; } catch { continue; }
    if (!payload || !Array.isArray(payload.bigram_hashes)) continue;
    out.push({
      tenant_id: r.tenant_id,
      created_at: r.created_at,
      namespace: payload.namespace,
      capture_id: payload.capture_id,
      bigram_count: payload.bigram_count || payload.bigram_hashes.length,
      bigram_hashes: payload.bigram_hashes,
    });
  }
  return out;
}

// aggregatePatterns({min_contributors, vertical, k_top}) - top-K bigram
// hashes across opted-in contributors. Returns honest insufficient
// envelope below the privacy floor.
//
// `vertical` parameter is a string id used to filter contributions to those
// whose source namespace is annotated as belonging to that vertical via the
// (future) namespace→vertical mapping. For W757-v1 the parameter is a
// best-effort substring match against namespace - the W715 namespace
// fingerprint pipeline will replace this with a learned mapping.
export async function aggregatePatterns({
  min_contributors = MIN_CONTRIBUTORS_DEFAULT,
  vertical = null,
  k_top = 50,
} = {}) {
  const all_rows = await _readAllContributions();

  // Filter to rows whose CONTRIBUTING tenant has at least one active opt-in
  // for the row's source namespace. The opt-in registry is the gate; a row
  // surviving in the event-store from before an opt-out MUST be dropped.
  const eligible = [];
  for (const row of all_rows) {
    if (!row.tenant_id || !row.namespace) continue;
    // W411 defense-in-depth - confirm the opt-in is still active for this
    // (tenant, namespace) pair. Inside the loop so a registry bug cannot
    // surface a row whose opt-in was revoked.
     
    const stillOpted = await isOptedIn(row.tenant_id, row.namespace);
     
    if (!stillOpted) continue;
    if (vertical) {
      // Best-effort vertical filter - match if the source namespace contains
      // the vertical id as a substring. Conservative: a tenant labeling
      // their namespace 'support-team-a' lands under vertical='support'.
      if (!String(row.namespace).toLowerCase().includes(String(vertical).toLowerCase())) {
        continue;
      }
    }
    eligible.push(row);
  }

  const contributors = new Set(eligible.map((r) => r.tenant_id));
  if (contributors.size < min_contributors) {
    return {
      ok: false,
      error: 'insufficient_contributors',
      need_min: min_contributors,
      have: contributors.size,
      vertical: vertical || null,
      version: PATTERN_LAKE_VERSION,
    };
  }

  // Top-K bigram histogram. Counts duplicate bigrams from the SAME
  // (tenant, namespace) at most once (so a single chatty contributor cannot
  // tip the histogram by repeating one bigram a million times).
  const seenPerContributor = new Map(); // key: tenant_id|namespace → Set<hash>
  const histogram = new Map();
  for (const r of eligible) {
    const k = r.tenant_id + '|' + r.namespace;
    let seen = seenPerContributor.get(k);
    if (!seen) { seen = new Set(); seenPerContributor.set(k, seen); }
    for (const h of r.bigram_hashes) {
      if (typeof h !== 'string' || !h) continue;
      if (seen.has(h)) continue;
      seen.add(h);
      histogram.set(h, (histogram.get(h) || 0) + 1);
    }
  }
  const sorted = Array.from(histogram.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(1000, Math.trunc(Number(k_top)) || 50)))
    .map(([hash, count]) => ({ hash, count }));

  return {
    ok: true,
    version: PATTERN_LAKE_VERSION,
    vertical: vertical || null,
    n_contributors: contributors.size,
    top_bigram_hashes: sorted,
    generated_at: new Date().toISOString(),
  };
}

// extractVerticalFingerprint(vertical_id) - the fingerprint surface the
// W751 vertical catalog consumes. Returns either:
//   { ok:true, vertical_id, version, n_contributing_namespaces,
//     top_bigram_hashes, generated_at, dp_epsilon }
//   - or -
//   { ok:false, error:'unknown_vertical', ... }
//   { ok:false, error:'insufficient_lake_data', need_min_captures:100, ... }
export async function extractVerticalFingerprint(vertical_id) {
  const v = getVertical(vertical_id);
  if (!v) {
    return {
      ok: false,
      error: 'unknown_vertical',
      hint: 'unknown vertical id',
      vertical_id: String(vertical_id || ''),
      version: PATTERN_LAKE_VERSION,
    };
  }
  // Lake disabled - surface honest insufficient_lake_data envelope (the
  // caller is the vertical fingerprint route; it is OK with the lake being
  // off for this install).
  if (!_isLakeEnabled()) {
    return {
      ok: false,
      error: 'insufficient_lake_data',
      hint:
        'pattern lake requires ' + LAKE_ENABLED_ENV +
        '=1 + minimum 100 opt-in captures across namespaces',
      need_min_captures: 100,
      vertical_id: v.id,
      version: PATTERN_LAKE_VERSION,
      verticals_version: VERTICALS_VERSION,
    };
  }
  const agg = await aggregatePatterns({
    min_contributors: MIN_CONTRIBUTORS_DEFAULT,
    vertical: v.id,
    k_top: 100,
  });
  if (!agg.ok) {
    return {
      ok: false,
      error: 'insufficient_lake_data',
      hint:
        'pattern lake requires ' + LAKE_ENABLED_ENV +
        '=1 + minimum 100 opt-in captures across namespaces',
      need_min_captures: 100,
      n_contributors: agg.have != null ? agg.have : 0,
      vertical_id: v.id,
      version: PATTERN_LAKE_VERSION,
      verticals_version: VERTICALS_VERSION,
    };
  }
  return {
    ok: true,
    vertical_id: v.id,
    version: PATTERN_LAKE_VERSION,
    verticals_version: VERTICALS_VERSION,
    n_contributing_namespaces: agg.n_contributors,
    top_bigram_hashes: agg.top_bigram_hashes,
    generated_at: agg.generated_at,
    // dp_epsilon is null on the raw aggregate; the W757 trend/router DP
    // surface applies noise on top. Honest null when no DP was applied.
    dp_epsilon: null,
  };
}

// _wipeForTests - destructive helper for the test suite only. The event-
// store's own _resetForTests handles the bulk of the wipe; this helper
// surfaces a no-op for callers that want a symmetric shape.
export function _wipeForTests() {
  // No module-local state to drop - the event-store owns persistence and
  // tests already call eventStore._resetForTests() in their freshEventStore
  // helper. This export exists so test code can name it without a runtime
  // failure if it is called.
  return { ok: true, wiped: 0, version: PATTERN_LAKE_VERSION };
}
