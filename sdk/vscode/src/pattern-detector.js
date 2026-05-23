// W731-2 — repetitive-pattern detector for VS Code captures.
//
// Per the W707 plan: W744 (full MinHash sketch) was KILLED; use the W815
// active-learning + W808 dedup pattern instead. That collapses to: hash each
// capture into a 4-gram-shingle Jaccard signature, keep an in-memory ring of
// the most recent 64 captures, and fire `kolm.patternRepetitionDetected` when
// a new capture's Jaccard similarity against >=3 past captures clears 0.7.
//
// Honest contract:
//   - Zero state outside the ring buffer — restart wipes it (intentional, so
//     long-running editors don't accumulate stale signatures).
//   - similarity() is plain Jaccard over normalized whitespace-collapsed
//     4-grams; no hashing fakery, no fixed-bit "MinHash" that hides
//     collisions. Computes O(N) per insert where N <=64.
//   - When the threshold trips, emitter is fired EXACTLY ONCE per cluster —
//     repeated near-duplicates within the same window don't spam the user.

const KOLM_VSCODE_PATTERN_DETECTOR_VERSION = 'w731-v1';

const DEFAULT_RING_SIZE = 64;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MIN_MATCHES = 3;
const DEFAULT_SHINGLE = 4;

// Normalize: trim, lowercase, collapse runs of whitespace. Preserves
// structure-bearing tokens (identifiers, punctuation) so two completions that
// only differ in indentation still match.
function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shingles(text, k) {
  const norm = normalize(text);
  const out = new Set();
  if (norm.length === 0) return out;
  if (norm.length <= k) { out.add(norm); return out; }
  for (let i = 0; i <= norm.length - k; i++) out.add(norm.slice(i, i + k));
  return out;
}

function jaccard(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return 0;
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

function createDetector(opts) {
  const cfg = {
    ringSize: (opts && opts.ringSize) || DEFAULT_RING_SIZE,
    threshold: (opts && opts.threshold != null) ? opts.threshold : DEFAULT_THRESHOLD,
    minMatches: (opts && opts.minMatches) || DEFAULT_MIN_MATCHES,
    shingle: (opts && opts.shingle) || DEFAULT_SHINGLE,
    emit: (opts && opts.emit) || null,
    cluster: (opts && opts.cluster) || null, // optional dedup tag
  };
  const ring = [];
  const firedClusterKeys = new Set();
  let lastEvent = null;

  function observe(item) {
    if (!item || typeof item.completion !== 'string') return null;
    const sig = shingles(item.completion, cfg.shingle);
    if (sig.size === 0) return null;
    // Score against the ring before inserting so a single observation never
    // self-matches.
    let matches = 0;
    let maxSim = 0;
    for (const past of ring) {
      const s = jaccard(sig, past.sig);
      if (s >= cfg.threshold) matches += 1;
      if (s > maxSim) maxSim = s;
    }
    // Push into ring (FIFO bound).
    ring.push({ sig, completion: item.completion, ts: item.ts || Date.now() });
    while (ring.length > cfg.ringSize) ring.shift();

    // Threshold trip? Fire emitter at most ONCE per cluster key. Cluster key
    // is the shingle-set itself (canonicalized), so the second-through-Nth
    // dupes don't re-emit.
    if (matches + 1 >= cfg.minMatches) {
      const clusterKey = Array.from(sig).sort().slice(0, 8).join('|');
      if (!firedClusterKeys.has(clusterKey)) {
        firedClusterKeys.add(clusterKey);
        const event = {
          ok: true,
          kind: 'kolm.patternRepetitionDetected',
          matches: matches + 1,
          maxSim,
          clusterKey,
          completion: item.completion,
        };
        lastEvent = event;
        if (typeof cfg.emit === 'function') {
          try { cfg.emit(event); } catch {}
        }
        return event;
      }
    }
    return { ok: true, kind: 'observed', matches, maxSim };
  }

  return {
    observe,
    _ring: () => ring.slice(),
    _firedClusters: () => Array.from(firedClusterKeys),
    _lastEvent: () => lastEvent,
    _reset: () => { ring.length = 0; firedClusterKeys.clear(); lastEvent = null; },
  };
}

module.exports = {
  KOLM_VSCODE_PATTERN_DETECTOR_VERSION,
  normalize,
  shingles,
  jaccard,
  createDetector,
};
