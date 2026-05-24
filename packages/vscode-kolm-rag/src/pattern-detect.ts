// W819-2 — repetition-cluster detection over captured insertions.
//
// Clusters captured insertions by token-shingle similarity. Cosine over a
// bag-of-tokens vector is the primary score; Jaccard is also exposed (used
// by W819-4 routing). No external ML deps — pure TS.
//
// Cluster labels (boilerplate/tests/docstrings) are surfaced via a small
// rule-based classifier over the cluster's representative text:
//   - tests        → identifier 'test' / 'describe' / 'it(' / 'assert' present
//   - docstrings   → comment-like opening (/** … */, ''', """, # …)
//   - boilerplate  → none of the above (default for code clusters)
//
// Honest contract: classifier is a coarse heuristic, NOT a model. A cluster
// containing several `assert` calls inside a non-test file may still be
// labeled 'tests' — this is intentional (test-shaped code is test-shaped
// code).

import type { Capture } from './capture-queue';

export const PATTERN_DETECT_VERSION = 'w819-v1';

export type ClusterLabel = 'boilerplate' | 'tests' | 'docstrings' | 'other';

export interface Cluster {
  readonly id: string;
  readonly label: ClusterLabel;
  readonly size: number;
  readonly members: readonly string[]; // capture ids
  /** Fingerprint shingle keys — used by W819-4 routing for Jaccard match. */
  readonly fingerprint: readonly string[];
  readonly representative: string;
  readonly cohesion: number; // mean pairwise cosine within cluster
}

export interface PatternDetectOptions {
  readonly shingleSize?: number; // default 3 (token trigrams)
  readonly minClusterSize?: number; // default 2
  readonly cosineThreshold?: number; // default 0.5
}

// ---------------------------------------------------------------------------
// Token + shingle utilities
// ---------------------------------------------------------------------------

/** Split into code-relevant tokens. Pure: identifiers + numbers + symbols. */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Match identifiers (alphanumeric + underscore), or single non-space symbols.
  // Lowercased so cosine/Jaccard are case-insensitive — distill targets
  // surface form, not exact case.
  const matches = text.toLowerCase().match(/[a-z_][a-z0-9_]*|[0-9]+|[^\sa-z0-9_]/g);
  return matches ?? [];
}

/** Sliding token shingles (n-grams). Returns string keys for set ops. */
export function shingleTokens(tokens: readonly string[], n: number): string[] {
  if (n <= 0 || tokens.length === 0) return [];
  if (tokens.length <= n) return [tokens.join(' ')];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/** Cosine on bag-of-shingles vectors. Pure-TS, no matrix lib. */
export function cosineBag(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const va = new Map<string, number>();
  const vb = new Map<string, number>();
  for (const s of a) va.set(s, (va.get(s) ?? 0) + 1);
  for (const s of b) vb.set(s, (vb.get(s) ?? 0) + 1);
  let dot = 0;
  for (const [k, v] of va) {
    const bv = vb.get(k);
    if (bv !== undefined) dot += v * bv;
  }
  let na = 0;
  for (const v of va.values()) na += v * v;
  let nb = 0;
  for (const v of vb.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Jaccard over shingle sets. Used by W819-4 routing fingerprint match. */
export function jaccardShingles(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter += 1;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

// ---------------------------------------------------------------------------
// Classifier — rule-based, NOT a model.
// ---------------------------------------------------------------------------

export function classifyCluster(representative: string): ClusterLabel {
  if (typeof representative !== 'string' || representative.length === 0) {
    return 'other';
  }
  const lower = representative.toLowerCase();
  // Docstrings first — they often live inside test/boilerplate blocks too.
  if (
    /\/\*\*[\s\S]*\*\//.test(representative) ||
    /(^|\n)\s*'''[\s\S]*?'''/.test(representative) ||
    /(^|\n)\s*"""[\s\S]*?"""/.test(representative) ||
    /(^|\n)\s*#\s+\w/.test(lower)
  ) {
    return 'docstrings';
  }
  if (
    /\b(?:describe|it|test|expect|assert|assertequals|should)\s*\(/.test(lower) ||
    /import\s+\{[^}]*\b(test|assert|expect)\b/.test(lower)
  ) {
    return 'tests';
  }
  // Boilerplate: import blocks, constructor scaffolding, getter/setter pairs.
  if (
    /^\s*(?:import|from|require)\b/m.test(lower) ||
    /\bconstructor\s*\(/.test(lower) ||
    /\bget\s+\w+\s*\(\s*\)\s*\{/.test(lower) ||
    /\bset\s+\w+\s*\(/.test(lower)
  ) {
    return 'boilerplate';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Clusterer — agglomerative single-link with cosine threshold.
// ---------------------------------------------------------------------------

interface InternalCluster {
  members: Capture[];
  shingleSets: string[][];
}

let __clusterCounter = 0;
function nextClusterId(): string {
  __clusterCounter += 1;
  return 'clu_' + Date.now().toString(36) + '_' + __clusterCounter.toString(36);
}

export function clusterCaptures(
  captures: ReadonlyArray<Capture>,
  opts: PatternDetectOptions = {}
): Cluster[] {
  const shingleSize = Math.max(1, opts.shingleSize ?? 3);
  const minClusterSize = Math.max(1, opts.minClusterSize ?? 2);
  const cosineThreshold = Math.min(
    1,
    Math.max(0, opts.cosineThreshold ?? 0.5)
  );

  const groups: InternalCluster[] = [];
  for (const cap of captures) {
    const toks = tokenize(cap.text);
    const sh = shingleTokens(toks, shingleSize);
    if (sh.length === 0) continue;

    let placed = false;
    for (const g of groups) {
      // Score against the cluster's representative (first member) to keep
      // this O(N) instead of O(N^2). Single-link agglomerative-ish.
      const sim = cosineBag(sh, g.shingleSets[0]);
      if (sim >= cosineThreshold) {
        g.members.push(cap);
        g.shingleSets.push(sh);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ members: [cap], shingleSets: [sh] });
    }
  }

  const out: Cluster[] = [];
  for (const g of groups) {
    if (g.members.length < minClusterSize) continue;
    const rep = g.members[0].text;
    // Pairwise cohesion: mean cosine over (rep, other) pairs.
    let cohesionSum = 0;
    let cohesionN = 0;
    for (let i = 1; i < g.shingleSets.length; i++) {
      cohesionSum += cosineBag(g.shingleSets[0], g.shingleSets[i]);
      cohesionN += 1;
    }
    const cohesion = cohesionN === 0 ? 1 : cohesionSum / cohesionN;
    // Fingerprint = top-K distinct shingles from the representative (sorted
    // for determinism). Used by W819-4 routing.
    const fingerprintSet = new Set(g.shingleSets[0]);
    const fingerprint = Array.from(fingerprintSet).sort().slice(0, 32);
    out.push({
      id: nextClusterId(),
      label: classifyCluster(rep),
      size: g.members.length,
      members: g.members.map((m) => m.id),
      fingerprint,
      representative: rep,
      cohesion,
    });
  }
  // Largest clusters first — status-bar consumes head.
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** Test seam — reset internal counter for deterministic test ids. */
export function _resetForTests(): void {
  __clusterCounter = 0;
}
