// W700 - W745 CID-keyed failure modes dashboard.
//
// W745 answers: where does THIS ARTIFACT diverge most from its bakeoff
// baseline? W812 remains the tenant-wide live failure-mode surface.
//
// Design contract:
//   - Pure heuristic: no LLM calls, no network, no storage.
//   - Bounded inputs: captures, bakeoff rows, text, IDs, cluster size, and
//     top-N are all capped before scoring.
//   - Honest clustering stamp: `heuristic_keyword_v1`, not the future W757
//     fingerprinting method.
//   - K-Scores are proportions in [0, 1]. Out-of-range rows are ignored.
//   - Wilson 95% CI is only emitted when n >= 30, matching diagnostic.js.
//   - Full reports carry a deterministic report_sha256 for audit snapshots.

import crypto from 'node:crypto';

export const FAILURE_MODES_VERSION = 'w745-v1';
export const FAILURE_MODES_CONTRACT_VERSION = 'w700-v1';

export const MAX_FAILURE_MODE_CAPTURES = 5000;
export const MAX_FAILURE_MODE_BAKEOFF_ROWS = 10000;
export const MAX_FAILURE_MODE_TEXT_CHARS = 8192;
export const MAX_FAILURE_MODE_WORDS = 512;
export const MAX_FAILURE_MODE_ID_BYTES = 256;
export const MAX_FAILURE_MODE_TOP_N = 50;
export const MAX_FAILURE_MODE_CLUSTER_SIZE = 1000;

const MIN_N_FOR_CI = 30;
const DEFAULT_MIN_CLUSTER_SIZE = 10;
const DEFAULT_TOP_N = 5;
const CLUSTERING = 'heuristic_keyword_v1';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

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

function _byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

function _cleanText(value, maxChars = MAX_FAILURE_MODE_TEXT_CHARS) {
  if (value == null) return '';
  const s = String(value).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function _normalizeId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || CONTROL_RE.test(s) || _byteLen(s) > MAX_FAILURE_MODE_ID_BYTES) return null;
  return s;
}

function _artifactIdEnvelope(artifactCid, generatedAt) {
  const artifact_cid = _normalizeId(artifactCid);
  if (artifact_cid) return { ok: true, artifact_cid };
  return {
    ok: false,
    error: 'artifact_cid_invalid',
    failure_modes_version: FAILURE_MODES_VERSION,
    contract_version: FAILURE_MODES_CONTRACT_VERSION,
    clustering: CLUSTERING,
    hint: 'pass artifact_cid as a bounded printable string',
    generated_at: generatedAt,
  };
}

function _boundedInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function _readCaptureId(row) {
  if (!row || typeof row !== 'object') return null;
  return _normalizeId(row.cid ?? row.capture_cid ?? row.event_id ?? row.id);
}

function _readKScore(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.k_score ?? row.kscore ?? (row.score && row.score.k_score);
  const k = Number(raw);
  if (!Number.isFinite(k) || k < 0 || k > 1) return null;
  return k;
}

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map((v) => _canonicalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = _canonicalize(value[k]);
    return out;
  }
  return value;
}

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(JSON.stringify(_canonicalize(value))).digest('hex');
}

function _withReportHash(envelope) {
  const body = { ...envelope };
  delete body.report_sha256;
  return { ...body, report_sha256: _sha256Hex(body) };
}

function _nowIso(opts) {
  if (opts && typeof opts.now_iso === 'string' && !CONTROL_RE.test(opts.now_iso)) {
    const t = Date.parse(opts.now_iso);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

// clusterByKeywords(captures, opts)
//
// Pure heuristic: tokenize, drop stopwords, build top-3 1- and 2-grams, and
// cluster captures sharing at least two n-grams.
export function clusterByKeywords(captures, opts = {}) {
  const minSize = _boundedInt(
    opts.min_cluster_size,
    DEFAULT_MIN_CLUSTER_SIZE,
    { min: 1, max: MAX_FAILURE_MODE_CLUSTER_SIZE },
  );
  const arr = Array.isArray(captures)
    ? captures.slice(0, MAX_FAILURE_MODE_CAPTURES)
    : [];
  if (arr.length === 0) return [];

  const rows = [];
  for (const cap of arr) {
    if (!cap || typeof cap !== 'object') continue;
    const text = _extractText(cap);
    if (!text) continue;
    const ngrams = _topNgrams(text, 3);
    if (ngrams.length === 0) continue;
    const cid = _readCaptureId(cap);
    if (!cid) continue;
    rows.push({ cid, ngrams, ngramSet: new Set(ngrams) });
  }

  const clusters = [];
  for (const row of rows) {
    let bestIdx = -1;
    let bestOverlap = 1;
    for (let i = 0; i < clusters.length; i += 1) {
      const overlap = _intersectionSize(row.ngramSet, clusters[i].keySet);
      if (overlap >= 2 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(row);
    } else {
      clusters.push({
        keySet: row.ngramSet,
        keyList: row.ngrams.slice(),
        members: [row],
      });
    }
  }

  const out = [];
  for (const c of clusters) {
    if (c.members.length < minSize) continue;
    let topKeywords = c.keyList.slice(0, 5);
    if (c.members.length > 1) {
      const intersection = new Set(c.keyList);
      for (let i = 1; i < c.members.length; i += 1) {
        for (const k of [...intersection]) {
          if (!c.members[i].ngramSet.has(k)) intersection.delete(k);
        }
      }
      if (intersection.size >= 2) topKeywords = [...intersection].sort().slice(0, 5);
    }
    const memberCids = c.members.map((m) => m.cid);
    const row = {
      cluster_id: 'cluster_' + _shortHash(topKeywords.slice().sort().join('|')),
      top_keywords: topKeywords,
      count: c.members.length,
      sample_cids: memberCids.slice(0, 3),
    };
    Object.defineProperty(row, '_all_cids', {
      value: memberCids,
      enumerable: false,
      configurable: false,
    });
    out.push(row);
  }
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.cluster_id < b.cluster_id ? -1 : (a.cluster_id > b.cluster_id ? 1 : 0);
  });
  return out;
}

// clusterKScore(cluster, bakeoffRows)
//
// Joins cluster capture IDs to bakeoff rows and returns a Wilson-bounded
// K-Score summary. Rows with non-finite or out-of-range scores are ignored.
export function clusterKScore(cluster, bakeoffRows) {
  if (!cluster || typeof cluster !== 'object') {
    return { cluster_id: null, n: 0, k_score: null, k_score_ci_lo: null, k_score_ci_hi: null };
  }
  const cidsAll = Array.isArray(cluster._all_cids)
    ? cluster._all_cids
    : (Array.isArray(cluster.sample_cids) ? cluster.sample_cids : []);
  const cidSet = new Set(cidsAll.map((x) => _normalizeId(x)).filter(Boolean));
  let n = 0;
  let sum = 0;
  const rows = Array.isArray(bakeoffRows)
    ? bakeoffRows.slice(0, MAX_FAILURE_MODE_BAKEOFF_ROWS)
    : [];
  for (const row of rows) {
    const id = _readCaptureId(row);
    if (!id || !cidSet.has(id)) continue;
    const k = _readKScore(row);
    if (k == null) continue;
    n += 1;
    sum += k;
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

// topRegressions(clusters, overall_k_score, opts)
//
// Returns clusters whose K-Score is below the artifact overall score, sorted
// by largest positive delta.
export function topRegressions(clusters, overall_k_score, opts = {}) {
  const topN = _boundedInt(opts.top_n, DEFAULT_TOP_N, { min: 1, max: MAX_FAILURE_MODE_TOP_N });
  if (!Array.isArray(clusters) || clusters.length === 0) return [];
  if (!Number.isFinite(overall_k_score)) return [];
  const scored = [];
  for (const c of clusters) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.k_score !== 'number' || !Number.isFinite(c.k_score)) continue;
    const delta = _round4(overall_k_score - c.k_score);
    if (delta <= 0) continue;
    scored.push({ ...c, delta_vs_overall: delta });
  }
  scored.sort((a, b) => {
    if (b.delta_vs_overall !== a.delta_vs_overall) return b.delta_vs_overall - a.delta_vs_overall;
    return String(a.cluster_id).localeCompare(String(b.cluster_id));
  });
  return scored.slice(0, topN);
}

// generateFailureModeReport(artifact_cid, captures, bakeoffRows, opts)
//
// Full W745 envelope. Bridges to W741 via diagnostic_link.
export function generateFailureModeReport(artifact_cid, captures, bakeoffRows, opts = {}) {
  const generated_at = _nowIso(opts);
  const artifact = _artifactIdEnvelope(artifact_cid, generated_at);
  if (!artifact.ok) return artifact;

  const bakeoffList = Array.isArray(bakeoffRows)
    ? bakeoffRows.slice(0, MAX_FAILURE_MODE_BAKEOFF_ROWS)
    : [];
  if (bakeoffList.length === 0) {
    return {
      ok: false,
      error: 'no_bakeoff_results_yet',
      failure_modes_version: FAILURE_MODES_VERSION,
      contract_version: FAILURE_MODES_CONTRACT_VERSION,
      artifact_cid: artifact.artifact_cid,
      clustering: CLUSTERING,
      hint: 'run `kolm bakeoff` first against this artifact_cid, then retry',
      diagnostic_link: '/account/diagnose?cid=' + encodeURIComponent(artifact.artifact_cid),
      generated_at,
    };
  }

  const captureList = Array.isArray(captures)
    ? captures.slice(0, MAX_FAILURE_MODE_CAPTURES)
    : [];
  const allK = bakeoffList.map((r) => _readKScore(r)).filter((k) => k != null);
  const overall_k_score = allK.length
    ? _round4(allK.reduce((s, k) => s + k, 0) / allK.length)
    : 0;

  const rawClusters = clusterByKeywords(captureList, {
    min_cluster_size: opts.min_cluster_size,
  });
  const clusters = rawClusters.map((c) => {
    const score = clusterKScore(c, bakeoffList);
    const delta = (typeof score.k_score === 'number')
      ? _round4(overall_k_score - score.k_score)
      : null;
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

  const top_regressions = topRegressions(clusters, overall_k_score, {
    top_n: opts.top_n,
  });

  const envelope = {
    ok: true,
    failure_modes_version: FAILURE_MODES_VERSION,
    contract_version: FAILURE_MODES_CONTRACT_VERSION,
    artifact_cid: artifact.artifact_cid,
    overall_k_score,
    clustering: CLUSTERING,
    cluster_count: clusters.length,
    clusters,
    top_regressions,
    diagnostic_link: '/account/diagnose?cid=' + encodeURIComponent(artifact.artifact_cid),
    input_summary: {
      captures_seen: captureList.length,
      captures_capped_at: MAX_FAILURE_MODE_CAPTURES,
      bakeoff_rows_seen: bakeoffList.length,
      bakeoff_rows_capped_at: MAX_FAILURE_MODE_BAKEOFF_ROWS,
      scored_bakeoff_rows: allK.length,
    },
    generated_at,
  };
  return _withReportHash(envelope);
}

function _extractText(cap) {
  if (!cap || typeof cap !== 'object') return '';
  if (typeof cap.input === 'string' && cap.input) return _cleanText(cap.input);
  if (typeof cap.prompt === 'string' && cap.prompt) return _cleanText(cap.prompt);
  if (typeof cap.user_input === 'string' && cap.user_input) return _cleanText(cap.user_input);
  if (typeof cap.query === 'string' && cap.query) return _cleanText(cap.query);
  if (typeof cap.text === 'string' && cap.text) return _cleanText(cap.text);
  if (Array.isArray(cap.messages) && cap.messages.length > 0) {
    const m = cap.messages[0];
    if (m && typeof m.content === 'string') return _cleanText(m.content);
  }
  return '';
}

function _tokenize(text) {
  return _cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, MAX_FAILURE_MODE_WORDS);
}

function _topNgrams(text, k) {
  const toks = _tokenize(text);
  if (toks.length === 0) return [];
  const counts = new Map();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  for (let i = 0; i < toks.length - 1; i += 1) {
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
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function _shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

function _wilson95(p, n) {
  if (n < 1) return { lo: 0, hi: 0 };
  const bounded = Math.max(0, Math.min(1, p));
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (bounded + z2 / (2 * n)) / denom;
  const halfwidth = (z * Math.sqrt((bounded * (1 - bounded) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - halfwidth),
    hi: Math.min(1, center + halfwidth),
  };
}

export default {
  FAILURE_MODES_VERSION,
  FAILURE_MODES_CONTRACT_VERSION,
  clusterByKeywords,
  clusterKScore,
  topRegressions,
  generateFailureModeReport,
};
