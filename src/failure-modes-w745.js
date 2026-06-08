// W745 - Failure modes dashboard (CID-keyed; complementary to W812).
//
// W745 vs W812 split:
//   - W812 (src/failure-modes.js) clusters tenant-wide capture events by
//     topic+length+vendor and surfaces a STUDENT-vs-TEACHER divergence panel
//     scoped to a tenant_id. Reads from event-store, emits weakness signals
//     back into W720 self-improvement.
//   - W745 (this file) is CID-keyed: given an artifact_cid + the bakeoff
//     rows that artifact produced + the captures those rows were generated
//     against, return a per-cluster K-Score breakdown + top-regression
//     panel + bridge link into /account/diagnose?cid=<artifact_cid>
//     (W741 diagnostic envelope).
//
// Both modules coexist on purpose. W812 answers "where is THIS TENANT
// regressing right now?" - W745 answers "where does THIS ARTIFACT diverge
// most from the bakeoff baseline?"
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 466-471):
//   [W745-1] Dashboard of where student diverges most from teacher
//   [W745-2] Cluster captures by topic/pattern, show per-cluster K-Scores
//            (W757 fingerprinting will supersede; this is the heuristic
//            placeholder - envelope is honest about it via the
//            `clustering:"heuristic_keyword_v1"` field, NOT the eventual
//            `"w757_fingerprint"` value).
//   [W745-3] "Your support bot scores 0.97 on refunds but 0.62 on billing
//            disputes" - top regressions panel.
//   [W745-4] Bridge to W741 diagnostic (link from each cluster envelope to
//            /account/diagnose?cid=<artifact_cid>).
//
// Design contract:
//   - PURE HEURISTIC. No LLM calls. clusterByKeywords() tokenises capture
//     inputs, drops a small stopword list, builds top-3 1- and 2-grams,
//     and clusters captures that share >=2 n-grams. Deterministic - same
//     input produces the same cluster_ids.
//   - clusterKScore reuses the same Wilson 95% CI methodology as
//     src/diagnostic.js (n>=30 floor; null below). The CI helper is
//     inlined rather than imported because src/diagnostic.js keeps it
//     private - we honour the same honesty floor here.
//   - topRegressions returns deltas relative to the artifact's
//     overall_k_score so the panel can rank "where the student diverges
//     most from the teacher" without per-row teacher labels.
//   - generateFailureModeReport bridges to W741 via
//     `diagnostic_link:"/account/diagnose?cid=<artifact_cid>"`.
//
// Public surface:
//   - FAILURE_MODES_VERSION ('w745-v1' - distinct from W812 'w812-v1')
//   - clusterByKeywords(captures, {min_cluster_size=10})
//   - clusterKScore(cluster, bakeoffRows)
//   - topRegressions(clusters, overall_k_score, {top_n=5})
//   - generateFailureModeReport(artifact_cid, captures, bakeoffRows)

export const FAILURE_MODES_VERSION = 'w745-v1';

// Honesty floor - Wilson 95% CI only when n >= 30 (matches src/diagnostic.js
// MIN_N_FOR_CI). Below this the CI is null and the dashboard says shaky.
const MIN_N_FOR_CI = 30;

// Minimum cluster size - below this a candidate cluster is dropped (signal
// would be noise on a 3-row bucket). Caller can override per-call.
const DEFAULT_MIN_CLUSTER_SIZE = 10;

// Top-N for top_regressions panel. Spec lists "5" implicitly via the
// per-cluster card pattern. Caller can override per-call.
const DEFAULT_TOP_N = 5;

// Tiny built-in stopword list. Kept short on purpose - the clustering is
// about TOPICAL keywords, not English grammar. Larger lists drift into
// linguistic territory that ought to be a real fingerprint model (W757).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could',
  'do', 'does', 'did', 'for', 'from', 'has', 'have', 'had', 'he', 'her',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me',
  'my', 'no', 'not', 'now', 'of', 'on', 'or', 'our', 'out', 'over', 'she',
  'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'us', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours', 'about', 'after', 'all', 'any',
  'been', 'being', 'because', 'before', 'between', 'both', 'each', 'more',
  'most', 'only', 'other', 'own', 'same', 'should', 'very',
]);

// =============================================================================
// clusterByKeywords
//
// Pure heuristic: tokenize → drop stopwords → build top-3 1- and 2-grams →
// cluster captures sharing >=2 n-gram overlap.
//
// Returns: [{cluster_id, top_keywords:[], count, sample_cids:[]}].
// cluster_id is "cluster_<hash>" of the sorted intersection so the same
// n-gram set always produces the same id. Deterministic.
//
// Empty/invalid input → []. Captures with no usable input text are dropped.
// =============================================================================

export function clusterByKeywords(captures, opts) {
  const o = opts || {};
  const minSize = Number.isFinite(o.min_cluster_size) ? o.min_cluster_size : DEFAULT_MIN_CLUSTER_SIZE;
  if (!Array.isArray(captures) || captures.length === 0) return [];

  // Step 1 - per-capture top n-gram set.
  const rows = [];
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const text = _extractText(cap);
    if (!text) continue;
    const ngrams = _topNgrams(text, 3);
    if (ngrams.length === 0) continue;
    const id = cap.cid || cap.capture_cid || cap.event_id || cap.id;
    if (id == null) continue;
    rows.push({ cid: String(id), ngrams, ngramSet: new Set(ngrams) });
  }

  // Step 2 - greedy cluster: assign each row to the existing cluster whose
  // founder shares >=2 n-grams (best-overlap wins; ties go to the lower-index
  // existing cluster). Else start a new candidate cluster. Deterministic
  // because captures are processed in input order.
  const clusters = [];
  for (const row of rows) {
    let bestIdx = -1;
    let bestOverlap = 1; // strict-greater-than below requires we beat this
    for (let i = 0; i < clusters.length; i++) {
      const overlap = _intersectionSize(row.ngramSet, clusters[i].keySet);
      if (overlap >= 2 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(row);
      // Cluster key remains the original founder's n-gram set so the
      // cluster_id stays stable as members accumulate.
    } else {
      clusters.push({
        keySet: row.ngramSet,
        keyList: row.ngrams.slice(),
        members: [row],
      });
    }
  }

  // Step 3 - drop clusters below min_cluster_size; format the survivors.
  const out = [];
  for (const c of clusters) {
    if (c.members.length < minSize) continue;
    // top_keywords = intersection of all member ngrams, sorted alphabetically
    // for stable output. Fall back to the founder's keys when intersection
    // shrinks below 2 elements.
    let topKeywords = c.keyList.slice(0, 5);
    if (c.members.length > 1) {
      const intersection = new Set(c.keyList);
      for (let i = 1; i < c.members.length; i++) {
        for (const k of [...intersection]) {
          if (!c.members[i].ngramSet.has(k)) intersection.delete(k);
        }
      }
      if (intersection.size >= 2) {
        topKeywords = [...intersection].sort().slice(0, 5);
      }
    }
    // cluster_id = "cluster_" + 8-hex-char FNV-1a of the sorted-key string.
    // Deterministic and short enough to read in tables.
    const cluster_id = 'cluster_' + _shortHash(topKeywords.slice().sort().join('|'));
    const member_cids = c.members.map((m) => m.cid);
    out.push({
      cluster_id,
      top_keywords: topKeywords,
      count: c.members.length,
      sample_cids: member_cids.slice(0, 3),
      _all_cids: member_cids, // internal - used by clusterKScore + generateFailureModeReport
    });
  }
  // Sort by count desc; tiebreak by cluster_id asc for stable diff.
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.cluster_id < b.cluster_id ? -1 : (a.cluster_id > b.cluster_id ? 1 : 0);
  });
  return out;
}

// =============================================================================
// clusterKScore
//
// Join cluster._all_cids (or sample_cids fallback) to bakeoffRows; return
// {cluster_id, n, k_score, k_score_ci_lo, k_score_ci_hi}. Wilson 95% CI when
// n>=30; null below (honesty contract - matches src/diagnostic.js).
// =============================================================================

export function clusterKScore(cluster, bakeoffRows) {
  if (!cluster || typeof cluster !== 'object') {
    return { cluster_id: null, n: 0, k_score: null, k_score_ci_lo: null, k_score_ci_hi: null };
  }
  const cidsAll = Array.isArray(cluster._all_cids) ? cluster._all_cids
    : (Array.isArray(cluster.sample_cids) ? cluster.sample_cids : []);
  const cidSet = new Set(cidsAll.map((x) => String(x)));
  let n = 0;
  let sum = 0;
  if (Array.isArray(bakeoffRows)) {
    for (const row of bakeoffRows) {
      if (!row || typeof row !== 'object') continue;
      const id = row.cid || row.capture_cid || row.event_id || row.id;
      if (id == null) continue;
      if (!cidSet.has(String(id))) continue;
      const k = Number(row.k_score);
      if (!Number.isFinite(k)) continue;
      n += 1;
      sum += k;
    }
  }
  if (n === 0) {
    return {
      cluster_id: cluster.cluster_id,
      n: 0,
      k_score: null,
      k_score_ci_lo: null,
      k_score_ci_hi: null,
    };
  }
  const mean = sum / n;
  let ciLo = null;
  let ciHi = null;
  if (n >= MIN_N_FOR_CI) {
    const w = _wilson95(mean, n);
    ciLo = _round4(w.lo);
    ciHi = _round4(w.hi);
  }
  return {
    cluster_id: cluster.cluster_id,
    n,
    k_score: _round4(mean),
    k_score_ci_lo: ciLo,
    k_score_ci_hi: ciHi,
  };
}

// =============================================================================
// topRegressions
//
// Sort clusters by (overall_k_score - cluster.k_score) desc; take top_n.
// Clusters with non-numeric k_score are dropped (no signal). Each output row
// carries a `delta_vs_overall` field for display.
// =============================================================================

export function topRegressions(clusters, overall_k_score, opts) {
  const o = opts || {};
  const topN = Number.isFinite(o.top_n) ? o.top_n : DEFAULT_TOP_N;
  if (!Array.isArray(clusters) || clusters.length === 0) return [];
  if (!Number.isFinite(overall_k_score)) return [];
  const scored = [];
  for (const c of clusters) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.k_score !== 'number' || !Number.isFinite(c.k_score)) continue;
    const delta = _round4(overall_k_score - c.k_score);
    scored.push(Object.assign({}, c, { delta_vs_overall: delta }));
  }
  scored.sort((a, b) => b.delta_vs_overall - a.delta_vs_overall);
  return scored.slice(0, topN);
}

// =============================================================================
// generateFailureModeReport
//
// Full envelope. Bridges to W741 via diagnostic_link.
//
// Returns:
//   {
//     ok:true,
//     failure_modes_version:'w745-v1',
//     artifact_cid,
//     overall_k_score,
//     clustering:'heuristic_keyword_v1',     // honest about the W757 placeholder
//     cluster_count,
//     clusters:[{cluster_id, top_keywords, n, k_score, k_score_ci_*,
//                delta_vs_overall, sample_cids[:3]}],
//     top_regressions:[...],
//     diagnostic_link:'/account/diagnose?cid=<artifact_cid>',  // W745-4 bridge
//     generated_at,
//   }
//
// Honest envelope `no_bakeoff_results_yet` when bakeoffRows is empty.
// =============================================================================

export function generateFailureModeReport(artifact_cid, captures, bakeoffRows, opts) {
  const o = opts || {};
  const generated_at = new Date().toISOString();
  if (!artifact_cid || typeof artifact_cid !== 'string') {
    return {
      ok: false,
      error: 'artifact_cid_required',
      failure_modes_version: FAILURE_MODES_VERSION,
      clustering: 'heuristic_keyword_v1',
      hint: 'pass artifact_cid as the first argument',
      generated_at,
    };
  }
  if (!Array.isArray(bakeoffRows) || bakeoffRows.length === 0) {
    return {
      ok: false,
      error: 'no_bakeoff_results_yet',
      failure_modes_version: FAILURE_MODES_VERSION,
      artifact_cid,
      clustering: 'heuristic_keyword_v1',
      hint: 'run `kolm bakeoff` first against this artifact_cid, then retry',
      diagnostic_link: '/account/diagnose?cid=' + encodeURIComponent(artifact_cid),
      generated_at,
    };
  }
  const captureList = Array.isArray(captures) ? captures : [];
  // Overall k_score - unweighted mean over bakeoff rows (matches W741).
  const allK = bakeoffRows
    .map((r) => Number(r && r.k_score))
    .filter((k) => Number.isFinite(k));
  const overall_k_score = allK.length
    ? _round4(allK.reduce((s, k) => s + k, 0) / allK.length)
    : 0;

  // Cluster + score.
  const rawClusters = clusterByKeywords(captureList, {
    min_cluster_size: Number.isFinite(o.min_cluster_size) ? o.min_cluster_size : DEFAULT_MIN_CLUSTER_SIZE,
  });
  const clusters = rawClusters.map((c) => {
    const score = clusterKScore(c, bakeoffRows);
    const delta = (typeof score.k_score === 'number') ? _round4(overall_k_score - score.k_score) : null;
    return {
      cluster_id: c.cluster_id,
      top_keywords: c.top_keywords,
      count: c.count,
      sample_cids: c.sample_cids,
      n: score.n,
      k_score: score.k_score,
      k_score_ci_lo: score.k_score_ci_lo,
      k_score_ci_hi: score.k_score_ci_hi,
      delta_vs_overall: delta,
    };
  });

  const topN = Number.isFinite(o.top_n) ? o.top_n : DEFAULT_TOP_N;
  const top_regressions = topRegressions(clusters, overall_k_score, { top_n: topN });

  return {
    ok: true,
    failure_modes_version: FAILURE_MODES_VERSION,
    artifact_cid,
    overall_k_score,
    clustering: 'heuristic_keyword_v1', // W745-2 honesty - NOT 'w757_fingerprint' yet
    cluster_count: clusters.length,
    clusters,
    top_regressions,
    diagnostic_link: '/account/diagnose?cid=' + encodeURIComponent(artifact_cid),
    generated_at,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function _extractText(cap) {
  if (typeof cap.input === 'string' && cap.input) return cap.input;
  if (typeof cap.prompt === 'string' && cap.prompt) return cap.prompt;
  if (typeof cap.user_input === 'string' && cap.user_input) return cap.user_input;
  if (typeof cap.query === 'string' && cap.query) return cap.query;
  if (typeof cap.text === 'string' && cap.text) return cap.text;
  if (Array.isArray(cap.messages) && cap.messages.length > 0) {
    const m = cap.messages[0];
    if (m && typeof m.content === 'string') return m.content;
  }
  return '';
}

function _tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= 3 && !STOPWORDS.has(t));
}

function _topNgrams(text, k) {
  const toks = _tokenize(text);
  if (toks.length === 0) return [];
  // 1-grams + 2-grams, frequency-counted. Top-k by count desc, alphabetical
  // tiebreak for determinism.
  const counts = new Map();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  for (let i = 0; i < toks.length - 1; i++) {
    const bg = toks[i] + ' ' + toks[i + 1];
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
  });
  return entries.slice(0, k).map((e) => e[0]);
}

function _intersectionSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function _shortHash(s) {
  // Deterministic FNV-1a 32-bit hex. Avoids node:crypto so the helper is
  // pure-JS portable - clusterByKeywords stays usable in any runtime.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// Wilson 95% CI on a 0..1 proportion. Caller enforces n>=MIN_N_FOR_CI.
// Inlined intentionally - src/diagnostic.js keeps the same helper private,
// and we want clusterKScore to honour the identical honesty floor.
function _wilson95(p, n) {
  if (n < 1) return { lo: 0, hi: 0 };
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfwidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - halfwidth),
    hi: Math.min(1, center + halfwidth),
  };
}

export default {
  FAILURE_MODES_VERSION,
  clusterByKeywords,
  clusterKScore,
  topRegressions,
  generateFailureModeReport,
};
