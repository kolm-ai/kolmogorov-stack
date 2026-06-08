// src/span-merge.js
//
// W921 Phase-1 - pure-JS, zero-dependency span merger that fuses the
// deterministic regex tier (src/phi-redactor.js findings) with the ML/NER tier
// (src/ner-recognizer.js spans) into ONE non-overlapping redaction plan, using
// Microsoft Presidio's decision process:
//
//   1. Normalize every span from BOTH tiers to a common shape
//      { start, end, score, source:'regex'|'ner', class }  (class = phi CLASS).
//   2. Apply a LemmaContextAwareEnhancer-style context boost: +delta to a
//      span's score when a context lemma ('patient','dob','ssn',...) sits in a
//      small window around it (mirrors Presidio's +0.4-cap enhancer; we use a
//      conservative +0.2 by default).
//   3. Resolve overlaps by Presidio's tiebreak ladder:
//        longest span wins -> then highest score -> then regex-source wins.
//      The regex-source-wins tiebreak guarantees deterministic detectors are
//      never overridden by a fuzzy NER span of equal length+score.
//   4. Drop any surviving span below the per-call threshold.
//   5. Emit a non-overlapping, source-ordered plan of
//        { start, end, replacement }  where replacement is a
//        [PHI_<CLASS>_<n>] token (the SAME format phi-redactor uses) so the
//        plan applies with phi-redactor's applyPlan() shape and the resulting
//        map round-trips through phi.reinject().
//
// OUTPUT
//   mergeFindings(...) -> { plan, findings, map }
//     plan:     [{start,end,replacement}] sorted, non-overlapping
//     findings: phi-redactor-shaped findings (one per surviving span) carrying
//               class/source/score/span so the receipt can attribute each
//               redaction to a detector tier
//     map:      { '[PHI_CLASS_n]': '<original substring>' } for reinject()
//
// This module is pure and deterministic: identical inputs produce an identical
// plan/map (the regex tier is deterministic and the NER tier stamps its model
// id + threshold into the receipt, so the merge result is reproducible given
// the same tier outputs).

import crypto from 'node:crypto';

const DEFAULT_DELTA = 0.2;     // Presidio LemmaContextAwareEnhancer-style boost
const DEFAULT_THRESHOLD = 0.4; // per-call minimum surviving score (NER tier)

// Default context lemmas keyed by phi CLASS. Mirrors ner-recognizer's taxonomy
// but kept local so span-merge has no hard import cycle and stays usable
// standalone.
const DEFAULT_CONTEXT_LEMMAS = Object.freeze({
  NAME: ['patient', 'name', 'mr', 'mrs', 'ms', 'dr', 'doctor', 'physician', 'client', 'customer', 'caller'],
  DATE: ['dob', 'birth', 'born', 'birthdate', 'date', 'admitted', 'discharged'],
  GEO: ['address', 'street', 'lives', 'residence', 'resides', 'located', 'city', 'zip'],
  SSN: ['ssn', 'social', 'security'],
  MRN: ['mrn', 'record', 'chart', 'medical'],
  PHONE: ['phone', 'call', 'tel', 'cell', 'mobile', 'reach', 'number'],
  EMAIL: ['email', 'mail', 'contact'],
  ACCT: ['account', 'acct', 'card'],
});

function _sha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Map a phi-redactor finding TYPE (lowercase, e.g. 'ssn','npi','dob','email')
// onto a phi CLASS (uppercase, the token taxonomy). phi findings carry `type`,
// not `class`, so we translate. Total: defaults to 'OTHER'.
const FINDING_TYPE_TO_CLASS = Object.freeze({
  ssn: 'SSN', ssn_malformed: 'SSN',
  npi: 'NPI', npi_invalid: 'NPI',
  dea: 'DEA', medicaid: 'MEDICAID',
  dob: 'DATE', dob_malformed: 'DATE',
  mrn: 'MRN', address_fragment: 'GEO', account_no: 'ACCT',
  email: 'EMAIL', phone: 'PHONE', name: 'NAME', geo: 'GEO',
  url: 'URL', ip: 'IP', fax: 'FAX', hpid: 'HPID', acct: 'ACCT',
  lic: 'LIC', veh: 'VEH', dev: 'DEV',
});

function _findingClass(f) {
  if (f && typeof f.class === 'string' && f.class) return f.class.toUpperCase();
  const t = String(f?.type || '').toLowerCase();
  if (Object.hasOwn(FINDING_TYPE_TO_CLASS, t)) return FINDING_TYPE_TO_CLASS[t];
  // best-effort: a bare CLASS-looking type
  if (/^[A-Z]+$/.test(f?.type || '')) return f.type;
  return 'OTHER';
}

// Pull [start,end) out of a phi finding's `span` ([s,e]) or {start,end}.
function _findingRange(f) {
  if (Array.isArray(f?.span) && f.span.length === 2) {
    return [Number(f.span[0]), Number(f.span[1])];
  }
  if (Number.isFinite(f?.start) && Number.isFinite(f?.end)) {
    return [Number(f.start), Number(f.end)];
  }
  return null;
}

/**
 * applyContextBoost - LemmaContextAwareEnhancer-style score lift. Scans a
 * window of `windowChars` (default 40) on each side of the span for any of the
 * `contextLemmas`; if found, returns score + delta (capped at 1.0), else the
 * original score. Word-boundary matched + case-insensitive.
 *
 * @param {{start:number,end:number,score:number}} span
 * @param {string} text
 * @param {string[]} contextLemmas
 * @param {number} [delta]
 * @returns {number} the (possibly boosted) score
 */
export function applyContextBoost(span, text, contextLemmas, delta = DEFAULT_DELTA, windowChars = 40) {
  if (!span || !Array.isArray(contextLemmas) || contextLemmas.length === 0) {
    return Number(span?.score) || 0;
  }
  const src = String(text || '');
  const lo = Math.max(0, span.start - windowChars);
  const hi = Math.min(src.length, span.end + windowChars);
  const before = src.slice(lo, span.start).toLowerCase();
  const after = src.slice(span.end, hi).toLowerCase();
  const window = before + ' ' + after;
  for (const lemma of contextLemmas) {
    const l = String(lemma || '').toLowerCase().trim();
    if (!l) continue;
    const re = new RegExp('(?:^|[^a-z0-9])' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)');
    if (re.test(window)) {
      return Math.min(1, (Number(span.score) || 0) + delta);
    }
  }
  return Number(span.score) || 0;
}

/**
 * resolveOverlaps - Presidio overlap resolution. Given normalized spans
 * { start, end, score, source, class }, returns the maximal non-overlapping
 * subset chosen by: longest-span-wins, then highest-score, then
 * regex-source-wins. Deterministic.
 *
 * @param {Array<{start:number,end:number,score:number,source:string,class:string}>} spans
 * @returns {Array<{start:number,end:number,score:number,source:string,class:string}>}
 */
export function resolveOverlaps(spans) {
  const list = (spans || []).filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  // Priority order: longest first, then highest score, then regex before ner,
  // then earliest start for stability.
  const sourceRank = (s) => (s === 'regex' ? 0 : 1);
  const sorted = list.slice().sort((a, b) => {
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (lb !== la) return lb - la;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    if (sourceRank(a.source) !== sourceRank(b.source)) return sourceRank(a.source) - sourceRank(b.source);
    return a.start - b.start;
  });

  const kept = [];
  const overlaps = (x, y) => x.start < y.end && y.start < x.end;
  for (const s of sorted) {
    if (kept.some((k) => overlaps(k, s))) continue;
    kept.push(s);
  }
  // Return in source order for a stable, applicable plan.
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  return kept;
}

/**
 * mergeFindings - the public merge entry point.
 *
 * @param {Array} regexFindings  phi-redactor findings (have {type,span:[s,e],...})
 * @param {Array<{start,end,label,score,raw_label?}>} nerSpans  ner-recognizer spans (label is a phi CLASS)
 * @param {{ text:string, contextLemmas?:Record<string,string[]>|string[],
 *           threshold?:number, delta?:number, labelMap?:Record<string,string> }} opts
 * @returns {{ plan:Array<{start,end,replacement}>, findings:Array, map:Record<string,string> }}
 */
export function mergeFindings(regexFindings, nerSpans, opts = {}) {
  const text = String(opts.text == null ? '' : opts.text);
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  const delta = typeof opts.delta === 'number' ? opts.delta : DEFAULT_DELTA;
  const labelMap = opts.labelMap && typeof opts.labelMap === 'object' ? opts.labelMap : null;

  // contextLemmas may be a per-class map or a flat array (applied to all).
  const lemmasFor = (cls) => {
    if (Array.isArray(opts.contextLemmas)) return opts.contextLemmas;
    const m = (opts.contextLemmas && typeof opts.contextLemmas === 'object')
      ? opts.contextLemmas
      : DEFAULT_CONTEXT_LEMMAS;
    return m[cls] || DEFAULT_CONTEXT_LEMMAS[cls] || [];
  };

  const normalized = [];

  // --- regex tier: deterministic, score fixed at 1.0 ----------------------
  for (const f of regexFindings || []) {
    const range = _findingRange(f);
    if (!range) continue;
    const [s, e] = range;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    normalized.push({
      start: s,
      end: e,
      score: 1.0,
      source: 'regex',
      class: _findingClass(f),
      _finding: f, // carry through for findings output (raw_hash etc.)
    });
  }

  // --- ner tier: apply label map + context boost, then threshold ----------
  for (const sp of nerSpans || []) {
    const start = Number(sp.start);
    const end = Number(sp.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // span label is already a phi CLASS (ner-recognizer maps it); labelMap can
    // remap (e.g. translating raw GLiNER labels supplied by an external service).
    let cls = sp.label;
    if (labelMap && sp.raw_label && Object.hasOwn(labelMap, sp.raw_label)) {
      cls = labelMap[sp.raw_label];
    } else if (labelMap && Object.hasOwn(labelMap, sp.label)) {
      cls = labelMap[sp.label];
    }
    cls = String(cls || 'OTHER').toUpperCase();
    const boosted = applyContextBoost({ start, end, score: Number(sp.score) || 0 }, text, lemmasFor(cls), delta);
    if (boosted < threshold) continue;
    normalized.push({
      start,
      end,
      score: boosted,
      source: 'ner',
      class: cls,
      raw_label: sp.raw_label || sp.label || '',
    });
  }

  const kept = resolveOverlaps(normalized);

  // --- build plan + map with phi-compatible [PHI_<CLASS>_<n>] tokens -------
  // De-dupe identical original substrings to the SAME token (matches
  // phi-redactor's reverse-map behavior so "John ... John" -> one token).
  const counters = {};
  const reverse = new Map();   // original substring -> token
  const map = {};
  const plan = [];
  const findings = [];

  for (const s of kept) {
    const original = text.slice(s.start, s.end);
    let token;
    if (reverse.has(original)) {
      token = reverse.get(original);
    } else {
      const cls = s.class;
      counters[cls] = (counters[cls] || 0) + 1;
      token = `[PHI_${cls}_${counters[cls]}]`;
      map[token] = original;
      reverse.set(original, token);
    }
    plan.push({ start: s.start, end: s.end, replacement: token });

    findings.push({
      type: String(s.class).toLowerCase(),
      class: s.class,
      source: s.source,
      score: Number(s.score.toFixed ? s.score.toFixed(4) : s.score),
      span: [s.start, s.end],
      raw_hash: _sha256(original),
      reason: s.source === 'regex'
        ? (s._finding?.reason || 'regex detector')
        : `ner span (${s.raw_label || s.class})`,
      redacted: true,
      safe_to_send: s.source === 'regex' ? (s._finding?.safe_to_send !== false) : true,
    });
  }

  // plan must be sorted + non-overlapping for applyPlan(); resolveOverlaps
  // guarantees non-overlap, sort guarantees order.
  plan.sort((a, b) => a.start - b.start || a.end - b.end);
  findings.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);

  return { plan, findings, map };
}

/**
 * applyPlan - apply a non-overlapping plan to source text. Mirrors
 * phi-redactor's internal applyPlan so callers (and tests) can build the
 * redacted text + a token->original map directly from mergeFindings output.
 *
 * @param {string} src
 * @param {Array<{start,end,replacement}>} plan
 * @returns {{text:string, map:Record<string,string>}}
 */
export function applyPlan(src, plan) {
  const text = String(src == null ? '' : src);
  if (!plan || !plan.length) return { text, map: {} };
  const ordered = plan.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  const map = {};
  let cursor = 0;
  for (const { start, end, replacement } of ordered) {
    if (start < cursor) continue; // safety: skip overlap
    out.push(text.slice(cursor, start));
    out.push(replacement);
    map[replacement] = text.slice(start, end);
    cursor = end;
  }
  out.push(text.slice(cursor));
  return { text: out.join(''), map };
}

export const _internal = Object.freeze({
  _findingClass,
  _findingRange,
  DEFAULT_CONTEXT_LEMMAS,
  FINDING_TYPE_TO_CLASS,
});
