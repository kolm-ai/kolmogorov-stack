// Agent Security-Review audit - Memory Integrity Ledger (ASR-7, OFFER #10).
//
// The rag-memory analyzer (src/rag-memory-analyzer.js) answers "was a memory
// WRITE integrity-linked and attributed?" per tool. It does NOT answer the
// poisoning question a buyer actually asks: "given the writes the agent made,
// can I prove no stored memory was ALTERED between two writes?" Without a
// hash-chain over the write stream, that ASR-7 poisoning dimension is otherwise
// 'untested' - absence of a chain is not evidence of an intact one.
//
// This module builds a deterministic, append-only ledger over every memory
// WRITE op observed in result.rag_memory.memory_ops. Each ledger entry binds:
//
//     content_hash = SHA256(canonical(record))           // what was written
//     link_hash    = SHA256(prev_link_hash || content_hash)  // the chain link
//
// where prev is the prior entry's link_hash (the empty-string SHA-256 for the
// genesis entry). This is the same RFC-6962-flavoured construction the rest of
// the stack uses, so a verifier can recompute it offline with node:crypto and
// no kolm code.
//
// NON-INFLATION (binding): a control the logs never exercised is 'untested',
// never a silent 'pass'.
//   - ZERO writes observed  -> summary.untested = true, chain_intact = null,
//     and NO clean / positive finding is emitted (a clean finding would roll up
//     to a misleading ASR-7 pass under controlStatus).
//   - When a write op DECLARES a logged link hash that does not match the
//     recomputed chain, emit 'memory-integrity-broken' (severity high, ASR-7
//     pillar) so it flows into the existing rollup as a real blocker.
//   - When writes ARE observed and every declared link reconciles (or no link
//     was declared to contradict the recomputed one), chain_intact = true.
//
// Never throws: malformed input degrades to an untested-but-valid result.
//
// This module is a leaf: it imports ONLY the merkle hashing primitive (which in
// turn imports only node:crypto). No spine edits, no circular imports.

import crypto from 'node:crypto';

export const MEMORY_LEDGER_SPEC_VERSION = 'asr-memory-ledger/0.1';

const ANALYZER = 'memory-integrity-ledger';
const PILLAR = 'rag-memory'; // maps to ASR-7 via the control-mapper, like the analyzer
const EVIDENCE_CAP = 8;

// SHA-256 of the empty string - the genesis predecessor for the first link,
// matching merkle.js's MTH({}) = SHA256("") convention.
const GENESIS_PREV = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function sha256Hex(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest('hex');
}

// Deterministic, stable canonical JSON: object keys sorted recursively so the
// content_hash is independent of key order in the source log. Arrays keep order.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function lc(s) {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function tokenOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function pushSample(arr, id) {
  if (id && arr.length < EVIDENCE_CAP && !arr.includes(id)) arr.push(id);
}

function finding(f) {
  return {
    id: f.id,
    analyzer: ANALYZER,
    severity: f.severity,
    pillar: f.pillar,
    title: f.title,
    detail: f.detail,
    metric: f.metric || {},
    evidence: f.evidence || [],
    controls: f.controls || [],
  };
}

// Expand a single aggregated memory_op (per the rag-memory analyzer shape) into
// its individual WRITE records. The aggregated op carries writes:count; richer
// captures may also carry an explicit per-write list under `writes_detail` /
// `entries` / `write_records`, each item optionally declaring { key, content,
// content_hash, link_hash }. We honour the explicit list when present (so a
// gateway-captured chain can be reconciled byte-for-byte) and otherwise derive
// deterministic placeholder records from the op fields so the ledger still
// proves the write COUNT and order even from an aggregated export.
function writeRecordsOf(op) {
  if (!op || typeof op !== 'object') return [];
  // op.op === 'write' marks a write-bearing op; reads-only ops carry op:'read'.
  const isWrite = lc(op.op) === 'write' || (Number.isFinite(op.writes) && op.writes > 0);
  if (!isWrite) return [];

  const explicit =
    (Array.isArray(op.writes_detail) && op.writes_detail) ||
    (Array.isArray(op.entries) && op.entries) ||
    (Array.isArray(op.write_records) && op.write_records) ||
    null;

  const tool = tokenOrNull(op.tool) || 'memory';
  const out = [];
  if (explicit) {
    explicit.forEach((w, i) => {
      const ww = w && typeof w === 'object' ? w : {};
      out.push({
        tool,
        key: tokenOrNull(ww.key) || tokenOrNull(ww.id) || `${tool}#${i}`,
        // The exact bytes written, if captured; else a deterministic stand-in so
        // the chain still binds the op identity + position.
        content: ww.content !== undefined ? ww.content : (ww.value !== undefined ? ww.value : null),
        declared_content_hash: tokenOrNull(ww.content_hash),
        declared_link_hash: tokenOrNull(ww.link_hash) || tokenOrNull(ww.hash),
        evidence_id: tokenOrNull(ww.id) || tokenOrNull(ww.event_id) || null,
      });
    });
  } else {
    const n = Number.isFinite(op.writes) && op.writes > 0 ? op.writes : 1;
    const evidence = Array.isArray(op.evidence) ? op.evidence : [];
    for (let i = 0; i < n; i++) {
      out.push({
        tool,
        key: `${tool}#${i}`,
        content: { tool, op: 'write', tier: op.tier ?? null, seq_in_op: i, integrity: op.integrity ?? null, attribution: op.attribution ?? null },
        declared_content_hash: null,
        declared_link_hash: null,
        evidence_id: evidence[i] || evidence[0] || null,
      });
    }
  }
  return out;
}

/**
 * analyzeMemoryIntegrity - hash-chain ledger over observed memory WRITE ops.
 *
 * @param {object} ragMemory  result.rag_memory (the rag-memory analyzer output);
 *                            reads ragMemory.memory_ops. Tolerant of bad input.
 * @returns {{
 *   spec_version: string,
 *   ledger: Array<{seq:number, op:string, key:string, content_hash:string, prev:string, link_hash:string}>,
 *   chain_intact: boolean|null,
 *   findings: object[],
 *   summary: { writes:number, untested:boolean, by_severity:object }
 * }}
 */
export function analyzeMemoryIntegrity(ragMemory) {
  const rm = ragMemory && typeof ragMemory === 'object' ? ragMemory : {};
  const memoryOps = Array.isArray(rm.memory_ops) ? rm.memory_ops : [];

  // 1. Collect every individual WRITE record across all write-bearing ops.
  const records = [];
  for (const op of memoryOps) {
    for (const w of writeRecordsOf(op)) records.push(w);
  }

  const findings = [];

  // 2. NON-INFLATION: zero writes -> untested, null, no clean finding.
  if (records.length === 0) {
    return {
      spec_version: MEMORY_LEDGER_SPEC_VERSION,
      ledger: [],
      chain_intact: null,
      findings, // intentionally empty: no clean finding for an unexercised control
      summary: { writes: 0, untested: true, by_severity: emptySeverity() },
    };
  }

  // 3. Build the hash-chain ledger and reconcile any DECLARED link hashes.
  const ledger = [];
  const brokenEvidence = [];
  let brokenLinks = 0;
  let prev = GENESIS_PREV;

  records.forEach((w, seq) => {
    // content_hash binds the exact written record. If the source declared a
    // content_hash we use the declared value as the chained content (so the
    // recomputed link can be compared to the declared link byte-for-byte);
    // otherwise we hash our canonical record.
    const contentHash = w.declared_content_hash || sha256Hex(canonical(w.content));
    const linkHash = sha256Hex(prev + contentHash);

    ledger.push({
      seq,
      op: 'write',
      key: w.key,
      content_hash: contentHash,
      prev,
      link_hash: linkHash,
    });

    // Tamper detection: a later op that DECLARES a logged link hash which does
    // not match the recomputed chain means a stored memory was altered between
    // writes (or the chain was forged). That is the poisoning blocker.
    if (w.declared_link_hash && w.declared_link_hash.toLowerCase() !== linkHash.toLowerCase()) {
      brokenLinks++;
      pushSample(brokenEvidence, w.evidence_id || `${w.key}@${seq}`);
    }

    prev = linkHash;
  });

  const chainIntact = brokenLinks === 0;

  if (brokenLinks > 0) {
    findings.push(finding({
      id: 'memory-integrity-broken',
      severity: 'high',
      pillar: PILLAR,
      title: 'Memory integrity chain broken (stored memory altered between writes)',
      detail: `The memory write ledger reconciled ${ledger.length} write(s) and found ${brokenLinks} link(s) whose declared chain hash does not match the recomputed hash-chain. A mismatched link means a stored memory entry was altered between writes or its integrity chain was forged - the model will act on the altered entry the moment it is recalled (ASR-7 memory poisoning). Treat the affected entries as compromised, re-derive the chain from the gateway capture, and confirm no recalled turn consumed the altered content.`,
      metric: { writes: ledger.length, broken_links: brokenLinks },
      evidence: brokenEvidence.slice(0, EVIDENCE_CAP),
    }));
  }
  // No clean / positive finding when chain_intact === true: the intact chain is
  // reported via chain_intact:true + summary, never as a finding that would roll
  // up to a misleading ASR-7 'pass'. Same discipline as the untested branch.

  return {
    spec_version: MEMORY_LEDGER_SPEC_VERSION,
    ledger,
    chain_intact: chainIntact,
    findings,
    summary: {
      writes: ledger.length,
      untested: false,
      by_severity: tallySeverity(findings),
    },
  };
}

function emptySeverity() {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function tallySeverity(findings) {
  const out = emptySeverity();
  for (const f of findings) {
    const sev = f && f.severity;
    if (sev && sev in out) out[sev]++;
  }
  return out;
}

export default analyzeMemoryIntegrity;
