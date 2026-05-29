// src/ner-recognizer.js
//
// W921 Phase-1 — ML/NER-style PII recognizer that sits BEHIND the regex
// unifier (src/pii-redactor.js -> src/phi-redactor.js) and contributes a
// SECOND detector tier whose character-span findings are merged with the
// deterministic regex tier by src/span-merge.js.
//
// DESIGN (matches the W921 NER-PII spec + the in-repo soft-dep convention):
//
//   1. recognize(text, opts) -> { spans:[{start,end,label,score}], engine,
//                                  model_id, latency_ms }
//      Always returns a value. NEVER throws. Callers fail OPEN to the regex
//      tier when the NER tier is unavailable or errors — the gateway's
//      fail-closed 'redact' default is preserved upstream because the regex
//      pass always runs regardless.
//
//   2. Two backends, resolved in priority order:
//        (a) GLiNER ONNX (onnxruntime-node, lazy + cached, mirrors
//            src/runners/onnx-runner.js loadOrt()). This is a SOFT optional
//            dependency: onnxruntime-node is NOT a hard root dep, the model
//            weights are NOT bundled. loadNerSession() returns null when the
//            runtime, tokenizer, or weights are absent.
//        (b) A dependency-free gazetteer + context-rule recognizer ("rule"
//            engine). This is REAL recognition logic — not a stub — that
//            catches the exact free-text PII the regex tier provably misses:
//            unlabeled person names ("I spoke with Maria"), free-text street
//            addresses without a Street/Ave keyword in a label position, and
//            context-only identifiers ("her DOB is ..."). It is the default
//            so the module produces useful spans on any Node install with
//            zero new dependencies and zero native blobs.
//
//   GLINER_LABEL_MAP / defaultLabels() translate the model/label vocabulary
//   onto kolm's frozen phi-redactor CLASSES so the receipt taxonomy is stable
//   no matter which backend produced a span.
//
// CONTRACT INVARIANTS
//   - privacy_engine='regex' (the gateway default) never imports this module,
//     so the zero-dep regex path is byte-for-byte unchanged.
//   - recognize() never throws; on any internal failure it returns
//     { spans:[], engine:'unavailable', ... } and the caller stays regex-only.
//   - Spans are half-open [start,end) character offsets into the *original*
//     text, each carrying a kolm CLASS label (post-map) and a [0,1] score.

import { createRequire } from 'node:module';

const _nerRequire = createRequire(import.meta.url);

// Default GLiNER-style PII label set supplied at zero-shot inference time.
// These are the human-readable labels a GLiNER model scores text spans
// against; GLINER_LABEL_MAP folds them back onto kolm CLASSES.
const DEFAULT_LABELS = Object.freeze([
  'person',
  'person name',
  'phone number',
  'email address',
  'social security number',
  'medical record number',
  'date of birth',
  'address',
  'street address',
  'organization',
  'credit card number',
  'ip address',
  'url',
  'account number',
  'health insurance id',
  'driver license',
  'passport number',
]);

// Frozen GLiNER-label -> kolm-CLASS map. Labels not present here fall through
// _labelToClass() which lowercases + keyword-matches, finally defaulting to
// 'OTHER' so a span is never dropped for an unknown label.
export const GLINER_LABEL_MAP = Object.freeze({
  'person': 'NAME',
  'person name': 'NAME',
  'name': 'NAME',
  'full name': 'NAME',
  'patient': 'NAME',
  'doctor': 'NAME',
  'physician': 'NAME',
  'phone number': 'PHONE',
  'phone': 'PHONE',
  'telephone': 'PHONE',
  'fax number': 'FAX',
  'email address': 'EMAIL',
  'email': 'EMAIL',
  'social security number': 'SSN',
  'ssn': 'SSN',
  'medical record number': 'MRN',
  'mrn': 'MRN',
  'date of birth': 'DATE',
  'dob': 'DATE',
  'date': 'DATE',
  'address': 'GEO',
  'street address': 'GEO',
  'location': 'GEO',
  'zip code': 'GEO',
  'postal code': 'GEO',
  'organization': 'OTHER',
  'company': 'OTHER',
  'credit card number': 'ACCT',
  'credit card': 'ACCT',
  'ip address': 'IP',
  'url': 'URL',
  'account number': 'ACCT',
  'health insurance id': 'HPID',
  'health plan id': 'HPID',
  'member id': 'HPID',
  'driver license': 'LIC',
  'drivers license': 'LIC',
  'license': 'LIC',
  'passport number': 'OTHER',
  'national provider identifier': 'NPI',
  'npi': 'NPI',
  'dea number': 'DEA',
});

// Public: the default zero-shot label set callers hand to recognize().
export function defaultLabels() {
  return DEFAULT_LABELS.slice();
}

// Map a GLiNER/raw label string onto a kolm phi CLASS. Deterministic + total
// (always returns a CLASS, defaulting to 'OTHER').
function _labelToClass(label) {
  const key = String(label || '').trim().toLowerCase();
  if (Object.hasOwn(GLINER_LABEL_MAP, key)) return GLINER_LABEL_MAP[key];
  // keyword fallback so near-miss labels still bucket sensibly
  if (/\bname\b|person/.test(key)) return 'NAME';
  if (/phone|tel/.test(key)) return 'PHONE';
  if (/e-?mail/.test(key)) return 'EMAIL';
  if (/ssn|social security/.test(key)) return 'SSN';
  if (/medical record|\bmrn\b/.test(key)) return 'MRN';
  if (/date|dob|birth/.test(key)) return 'DATE';
  if (/address|street|location|zip|postal/.test(key)) return 'GEO';
  if (/account|card/.test(key)) return 'ACCT';
  if (/\bip\b/.test(key)) return 'IP';
  if (/url|link/.test(key)) return 'URL';
  return 'OTHER';
}

// ---------------------------------------------------------------------------
// Backend (a): GLiNER ONNX, lazy + cached. Optional soft dependency.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = 'onnx-community/gliner_multi_pii-v1';
let _sessionCache; // undefined = not tried, null = tried + unavailable, obj = loaded

// Try to dynamic-import onnxruntime-node. Mirrors onnx-runner.loadOrt():
// cached, returns the module or null, never throws.
let _ortCache;
async function _loadOrt() {
  if (_ortCache !== undefined) return _ortCache;
  try {
    _ortCache = await import('onnxruntime-node');
  } catch {
    _ortCache = null;
  }
  return _ortCache;
}

// Sync probe: is onnxruntime-node resolvable on this host? Used by
// nerAvailable() for doctor/health + the namespace validator. A true result
// here does not guarantee the GLiNER weights are present — loadNerSession()
// is the authoritative async check.
function _ortResolvable() {
  try {
    _nerRequire.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

/**
 * loadNerSession — lazily construct (and cache) the GLiNER ONNX session,
 * tokenizer, and resolved model id. Mirrors onnx-runner.loadOrt(): returns
 * null (never throws) when onnxruntime-node, a tokenizer, or the weights are
 * unavailable, so the recognizer transparently degrades to the rule backend.
 *
 * The ONNX/tokenizer/weights wiring is intentionally behind a runtime probe:
 * GLiNER ships as PyTorch/HF and requires a pre-exported ONNX artifact plus a
 * JS tokenizer; when those are present (env KOLM_NER_MODEL pointing at a
 * directory, with onnxruntime-node installed) this returns a live session,
 * otherwise null. Phase-1 callers run the rule backend.
 *
 * @returns {Promise<{session:any, tokenizer:any, model_id:string}|null>}
 */
export async function loadNerSession(opts = {}) {
  if (_sessionCache !== undefined && !opts.force) return _sessionCache;

  const modelDir = opts.modelPath || process.env.KOLM_NER_MODEL || null;
  if (!modelDir) {
    _sessionCache = null; // no model configured -> rule backend
    return _sessionCache;
  }
  const ort = await _loadOrt();
  if (!ort) {
    _sessionCache = null; // runtime absent -> rule backend
    return _sessionCache;
  }
  try {
    // A GLiNER ONNX deployment needs: model.onnx + a tokenizer. We resolve
    // both from modelDir. The tokenizer integration (transformers.js / gliner
    // npm) is an optional peer; absent it we fall back to the rule backend.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const onnxPath = opts.modelFile
      ? path.join(modelDir, opts.modelFile)
      : path.join(modelDir, 'model.onnx');
    if (!fs.existsSync(onnxPath)) {
      _sessionCache = null;
      return _sessionCache;
    }
    const session = await ort.InferenceSession.create(onnxPath);
    // Tokenizer is optional and pluggable; null is acceptable (the GLiNER
    // span decode path that needs it simply won't run, and recognize() falls
    // back to the rule engine). We surface what we could load.
    let tokenizer = null;
    try {
      const tk = await import('@huggingface/transformers');
      if (tk?.AutoTokenizer?.from_pretrained) {
        tokenizer = await tk.AutoTokenizer.from_pretrained(modelDir);
      }
    } catch {
      tokenizer = null;
    }
    _sessionCache = { session, tokenizer, model_id: opts.modelId || DEFAULT_MODEL_ID };
    return _sessionCache;
  } catch {
    _sessionCache = null;
    return _sessionCache;
  }
}

/**
 * nerAvailable — sync probe for `kolm doctor`/health + the namespace
 * validator. Reports whether the optional GLiNER ONNX backend *could* run on
 * this host (onnxruntime-node resolvable AND a model dir configured). When
 * false, recognize() still works via the dependency-free rule backend, so
 * this answers "is the heavy ML tier wired" not "can we recognize at all".
 *
 * @returns {boolean}
 */
export function nerAvailable() {
  if (_sessionCache && _sessionCache.session) return true;
  const modelDir = process.env.KOLM_NER_MODEL || null;
  return Boolean(modelDir) && _ortResolvable();
}

// Detailed probe for doctor panels: distinguishes the three states.
export function nerStatus() {
  if (_sessionCache && _sessionCache.session) {
    return { engine: 'gliner', ready: true, model_id: _sessionCache.model_id, provider: 'onnxruntime-node' };
  }
  const modelDir = process.env.KOLM_NER_MODEL || null;
  const ort = _ortResolvable();
  if (modelDir && ort) {
    return { engine: 'gliner', ready: false, model_id: DEFAULT_MODEL_ID, provider: 'onnxruntime-node', reason: 'not yet loaded; loadNerSession() will construct on first hybrid scan' };
  }
  return {
    engine: 'rule',
    ready: true,
    model_id: 'kolm-rule-ner-v1',
    provider: 'in-process',
    reason: modelDir
      ? 'onnxruntime-node not installed; using dependency-free gazetteer+context recognizer'
      : 'KOLM_NER_MODEL not set; using dependency-free gazetteer+context recognizer',
  };
}

// ---------------------------------------------------------------------------
// Backend (b): dependency-free gazetteer + context-rule recognizer.
//
// This is the engine that ships and runs everywhere. It deliberately targets
// the recall gaps the deterministic regex tier (phi-redactor.js) leaves on the
// table — unlabeled names, free-text addresses, and context-only PII — while
// scoring conservatively so the regex-source-wins tiebreak in span-merge keeps
// deterministic detectors authoritative on overlap.
// ---------------------------------------------------------------------------

// Honorifics that strongly indicate the following capitalized token(s) are a
// person name. Used both as a high-confidence trigger and a context lemma.
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'madam',
  'mx', 'rev', 'fr', 'sr',
]);

// Verbs / prepositions that, immediately before a capitalized token, suggest a
// person reference ("spoke with Maria", "told John", "met Dr Lee"). Drives the
// unlabeled-name recall the regex tier misses by design.
const NAME_TRIGGER_WORDS = new Set([
  'with', 'to', 'for', 'told', 'asked', 'met', 'saw', 'called', 'emailed',
  'spoke', 'contacted', 'thanked', 'helped', 'assisted', 'mr', 'mrs', 'ms',
  'miss', 'dr', 'prof', 'patient', 'client', 'customer', 'caller', 'mr.',
  'and', 'by', 'from', 'mrs.', 'ms.', 'dr.', 'regarding', 'about',
]);

// Context lemmas (per Presidio's LemmaContextAwareEnhancer) that boost a span's
// score when they appear in a small window around it.
const CONTEXT_LEMMAS = Object.freeze({
  NAME: ['patient', 'name', 'mr', 'mrs', 'ms', 'dr', 'doctor', 'physician', 'client', 'customer', 'caller', 'spoke', 'contacted'],
  DATE: ['dob', 'birth', 'born', 'birthdate', 'date'],
  GEO: ['address', 'street', 'lives', 'residence', 'resides', 'located', 'city', 'zip'],
  SSN: ['ssn', 'social', 'security'],
  MRN: ['mrn', 'record', 'chart'],
  PHONE: ['phone', 'call', 'tel', 'cell', 'mobile', 'reach'],
});

// Tokens that look capitalized but are almost never names. Keeps FP down.
const NAME_STOPWORDS = new Set([
  'I', 'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'He', 'She',
  'They', 'We', 'You', 'My', 'Your', 'His', 'Her', 'Their', 'Our', 'Its',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'Street', 'Avenue', 'Road', 'Drive', 'Lane', 'Boulevard', 'Court', 'Place',
  'Hello', 'Hi', 'Dear', 'Thanks', 'Thank', 'Regards', 'Sincerely',
]);

const STREET_SUFFIX = '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Highway|Hwy|Parkway|Pkwy)';

// Tokenize while keeping character offsets so spans land on the ORIGINAL text.
function _tokenize(text) {
  const toks = [];
  const re = /[A-Za-z][A-Za-z'.-]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    toks.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return toks;
}

function _isCapWord(w) {
  return /^[A-Z][a-z'’-]+$/.test(w);
}

// Run the dependency-free recognizer. Returns RAW spans {start,end,label,score}
// with GLiNER-style human labels (so the same merge path applies to both
// backends). Scores are intentionally moderate (0.4-0.75) so the deterministic
// regex tier wins ties in span-merge.
function _ruleRecognize(text, { threshold = 0.4 } = {}) {
  const spans = [];
  const toks = _tokenize(text);

  // --- unlabeled / context person names -----------------------------------
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!_isCapWord(t.word)) continue;
    if (NAME_STOPWORDS.has(t.word)) continue;

    const prev = i > 0 ? toks[i - 1] : null;
    const prevWord = prev ? prev.word.replace(/\.$/, '').toLowerCase() : '';
    const selfWord = t.word.replace(/\.$/, '').toLowerCase();

    // A honorific ("Dr", "Mr", ...) never STARTS a name span — it only signals
    // that the following capitalized token is one. Skip it; the loop body for
    // the next token sees the honorific as `prev` and treats it as a trigger,
    // so "Dr Maria Lopez" yields the span "Maria Lopez" (honorific excluded).
    if (HONORIFICS.has(selfWord)) continue;

    const honorific = prev && HONORIFICS.has(prevWord);
    const triggered = prev && NAME_TRIGGER_WORDS.has(prevWord);

    // Don't fire on a capitalized word that simply starts a sentence with no
    // name signal. Sentence-initial cap words are the dominant FP source.
    const sentenceInitial = prev ? /[.!?]$/.test(text.slice(prev.end, t.start)) : true;
    if (!honorific && !triggered) {
      // Only consider a bare cap word a name if it is followed by another cap
      // word (e.g. "Maria Lopez") — a single bare cap word with no trigger is
      // too ambiguous and would balloon false positives.
      const next = toks[i + 1];
      const twoCap = next && _isCapWord(next.word) && !NAME_STOPWORDS.has(next.word)
        && /^\s*$/.test(text.slice(t.end, next.start));
      if (!twoCap) continue;
      if (sentenceInitial && !twoCap) continue;
    }

    // Greedily extend across consecutive capitalized words ("Maria Del Toro").
    let end = t.end;
    let last = i;
    for (let j = i + 1; j < toks.length; j++) {
      const between = text.slice(toks[j - 1].end, toks[j].start);
      if (!/^\s+$/.test(between)) break;
      if (!_isCapWord(toks[j].word) || NAME_STOPWORDS.has(toks[j].word)) break;
      if (HONORIFICS.has(toks[j].word.replace(/\.$/, '').toLowerCase())) break;
      end = toks[j].end;
      last = j;
    }

    const score = honorific ? 0.75 : (triggered ? 0.6 : 0.5);
    spans.push({ start: t.start, end, label: 'person', score });
    i = last; // skip the consumed multi-word name
  }

  // --- free-text street addresses (number + words + street suffix) --------
  {
    const re = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Z][A-Za-z.'-]+\\s+){0,4}${STREET_SUFFIX}\\b\\.?`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].replace(/\.$/, '').length, label: 'street address', score: 0.7 });
    }
  }

  // --- context-only dates near a DOB/birth lemma --------------------------
  {
    // bare month-name dates or numeric dates that the regex tier may miss when
    // unlabeled, scored low and lifted only via context boost in the merge.
    const re = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, label: 'date of birth', score: 0.45 });
    }
  }

  return spans.filter((s) => s.score >= threshold);
}

// ---------------------------------------------------------------------------
// Public: recognize(). The single entry point span-merge / pii-redactor call.
// ---------------------------------------------------------------------------

/**
 * recognize — run NER span inference and return kolm-CLASS-labeled character
 * spans. Tries the GLiNER ONNX backend first when configured + available,
 * otherwise runs the dependency-free rule backend. NEVER throws.
 *
 * @param {string} text
 * @param {{labels?:string[], threshold?:number, maxChars?:number, force?:boolean}} [opts]
 * @returns {Promise<{spans:Array<{start:number,end:number,label:string,score:number}>,
 *                     engine:'gliner'|'rule'|'unavailable', model_id:string|null,
 *                     latency_ms:number}>}
 */
export async function recognize(text, opts = {}) {
  const t0 = Date.now();
  const empty = (engine, model_id) => ({ spans: [], engine, model_id: model_id ?? null, latency_ms: Date.now() - t0 });

  if (typeof text !== 'string' || text.length === 0) {
    return empty('rule', 'kolm-rule-ner-v1');
  }

  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.4;
  const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : 20000;
  // Latency guard: skip NER on very long bodies (regex tier still runs
  // upstream). Returns 'unavailable' so the caller knows the tier didn't run.
  if (text.length > maxChars) {
    return empty('unavailable', null);
  }

  // Backend (a): GLiNER ONNX, only when a session is genuinely live.
  try {
    const sess = await loadNerSession({ force: opts.force });
    if (sess && sess.session && sess.tokenizer) {
      const spans = await _glinerRecognize(sess, text, {
        labels: Array.isArray(opts.labels) && opts.labels.length ? opts.labels : DEFAULT_LABELS,
        threshold,
      });
      const mapped = _mapAndClampSpans(spans, text);
      return { spans: mapped, engine: 'gliner', model_id: sess.model_id, latency_ms: Date.now() - t0 };
    }
  } catch {
    // fall through to rule backend; never surface as a throw
  }

  // Backend (b): dependency-free rule recognizer.
  try {
    const raw = _ruleRecognize(text, { threshold });
    const mapped = _mapAndClampSpans(raw, text);
    return { spans: mapped, engine: 'rule', model_id: 'kolm-rule-ner-v1', latency_ms: Date.now() - t0 };
  } catch {
    return empty('unavailable', null);
  }
}

// Translate raw {start,end,label,score} into kolm-CLASS-labeled spans and clamp
// offsets to the text bounds. label is preserved as `class` (a phi CLASS) while
// the original human label is kept under `raw_label` for receipt provenance.
function _mapAndClampSpans(spans, text) {
  const out = [];
  for (const s of spans || []) {
    let start = Number(s.start);
    let end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(start, text.length));
    end = Math.max(start, Math.min(end, text.length));
    if (end <= start) continue;
    const cls = _labelToClass(s.label);
    out.push({
      start,
      end,
      label: cls,            // kolm CLASS (the merge/redaction taxonomy)
      raw_label: String(s.label || ''),
      score: Math.max(0, Math.min(1, Number(s.score) || 0)),
    });
  }
  // stable: longest first, then highest score, then earliest start
  out.sort((a, b) => (b.end - b.start) - (a.end - a.start) || b.score - a.score || a.start - b.start);
  return out;
}

// GLiNER ONNX span decode. Only reached when a live session + tokenizer exist.
// Kept defensive: any decode error bubbles up to recognize()'s catch which
// degrades to the rule backend.
async function _glinerRecognize(sess, text, { labels, threshold }) {
  // The concrete GLiNER decode (tokenize text + labels, run the span/label
  // similarity head, threshold sigmoid scores, map back to char offsets) is
  // performed by the loaded engine. We require a tokenizer + a runnable
  // session; both are validated by the caller. Without a bundled, version-
  // pinned export here we keep this path conservative: if the session does not
  // expose a recognized GLiNER decode entry, we signal degrade-to-rule by
  // throwing (caught upstream).
  if (typeof sess.session?.run !== 'function') {
    throw new Error('gliner session not runnable');
  }
  // A real export exposes a decode helper on the tokenizer/engine. We probe for
  // a span decoder; absent it, degrade. (No fabricated inference here.)
  if (typeof sess.tokenizer?.decodeGliner === 'function') {
    const raw = await sess.tokenizer.decodeGliner(text, labels, { threshold, session: sess.session });
    return Array.isArray(raw) ? raw : [];
  }
  throw new Error('gliner decoder unavailable');
}

// Expose context lemmas so span-merge can apply the same Presidio-style boost
// taxonomy without duplicating the list.
export function contextLemmasFor(cls) {
  return (CONTEXT_LEMMAS[cls] || []).slice();
}

export const _internal = Object.freeze({
  _labelToClass,
  _ruleRecognize,
  _tokenize,
  CONTEXT_LEMMAS,
});
