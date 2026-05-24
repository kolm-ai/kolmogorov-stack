// Capability contract + artifact lineage builder.
//
// Two manifest blocks the runtime + verifier care about:
//
//   capability — what the artifact NEEDS to run. Compared against the host's
//                device profile by src/device-capabilities.js#meetsRequirement
//                at load time. Includes minimum VRAM, supported runtimes,
//                required modalities, and (when applicable) the TEE
//                attestation flavor the artifact insists on.
//
//   lineage    — where the artifact CAME FROM. A graph of pointers back to
//                the inputs that produced it: parent artifact (re-distill),
//                source trace ids (workflow_capsule), team event head hash
//                (folded team-learning corpus), federated round id (when the
//                weights came from an FL aggregator), teacher/student info
//                (distilled_model), workflow IR hash (workflow_capsule).
//                Every pointer is a hash + the file it points to is shipped
//                inside the .kolm or referenced by a hash a verifier can
//                resolve via the catalog.
//
// Honest scope: this module BUILDS and VALIDATES the blocks. It does not
// itself decide whether the host meets the contract (device-capabilities.js
// does that) and it does not re-verify the pointed-to artifacts (the binder
// / verifier does that). It is a pure schema layer.

import crypto from 'node:crypto';

export const LINEAGE_SPEC_VERSION = 'lineage-v1';
export const CAPABILITY_SPEC_VERSION = 'capability-v1';

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX16_RE = /^[0-9a-f]{16}$/;

function _canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canon).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canon(v[k])).join(',') + '}';
}
function _shortHash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

// ── capability block ────────────────────────────────────────────────────────

// Build a capability contract for an artifact. Each field is optional; the
// resulting block records only what the artifact actually requires so a
// permissive artifact (e.g., rule-class with no special needs) ships with a
// minimal contract that meetsRequirement always satisfies.
//
// Inputs:
//   {
//     min_vram_gb:           number,                  // e.g., 2 (rule-class: 0)
//     runtimes:              ['llama-cpp','mlx'],     // any-of list
//     modalities:            ['text','image'],        // all-of list
//     min_cpu_ram_gb:        number,
//     requires_confidential_compute: bool,
//     attestation:           'pccs'|'snp-report'|'nitro-attestation'|'nras'|null,
//     min_device_profile:    'pixel-9-pro-tpu',       // pin to a specific device
//     target_arch:           'apple-silicon'|'x86_64'|'aarch64'|'wasm32',
//     notes:                 'human-readable',
//   }
//
// Validation is strict: unknown fields throw so manifests don't grow
// silently. Empty / falsy fields are dropped from the output.
const CAPABILITY_FIELDS = new Set([
  'min_vram_gb', 'runtimes', 'modalities', 'min_cpu_ram_gb',
  'requires_confidential_compute', 'attestation', 'min_device_profile',
  'target_arch', 'notes',
]);
export function buildCapability(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('capability input must be object');
  for (const k of Object.keys(input)) {
    if (!CAPABILITY_FIELDS.has(k)) throw new Error(`unknown capability field: ${k}`);
  }
  const out = { spec: CAPABILITY_SPEC_VERSION };
  if (input.min_vram_gb != null) {
    if (typeof input.min_vram_gb !== 'number' || input.min_vram_gb < 0) {
      throw new Error('min_vram_gb must be a non-negative number');
    }
    out.min_vram_gb = input.min_vram_gb;
  }
  if (input.min_cpu_ram_gb != null) {
    if (typeof input.min_cpu_ram_gb !== 'number' || input.min_cpu_ram_gb < 0) {
      throw new Error('min_cpu_ram_gb must be a non-negative number');
    }
    out.min_cpu_ram_gb = input.min_cpu_ram_gb;
  }
  if (Array.isArray(input.runtimes) && input.runtimes.length > 0) {
    for (const r of input.runtimes) if (typeof r !== 'string') throw new Error('runtimes entries must be strings');
    out.runtimes = [...input.runtimes].sort();
  }
  if (Array.isArray(input.modalities) && input.modalities.length > 0) {
    for (const m of input.modalities) if (typeof m !== 'string') throw new Error('modalities entries must be strings');
    out.modalities = [...input.modalities].sort();
  }
  if (input.requires_confidential_compute) {
    out.requires_confidential_compute = true;
    if (!input.attestation) {
      throw new Error('requires_confidential_compute=true requires an attestation field');
    }
  }
  if (input.attestation) {
    if (!['pccs', 'snp-report', 'nitro-attestation', 'nras'].includes(input.attestation)) {
      throw new Error(`unknown attestation kind: ${input.attestation}`);
    }
    out.attestation = input.attestation;
  }
  if (input.min_device_profile) {
    if (typeof input.min_device_profile !== 'string') throw new Error('min_device_profile must be string');
    out.min_device_profile = input.min_device_profile;
  }
  if (input.target_arch) {
    if (typeof input.target_arch !== 'string') throw new Error('target_arch must be string');
    out.target_arch = input.target_arch;
  }
  if (input.notes) {
    if (typeof input.notes !== 'string') throw new Error('notes must be string');
    out.notes = input.notes;
  }
  out.hash = _shortHash(_canon(out));
  return out;
}

// Re-validate a capability block read off the wire. Returns the block
// (frozen) on success; throws on schema or hash mismatch.
export function validateCapability(block) {
  if (!block || typeof block !== 'object') throw new Error('capability block must be object');
  if (block.spec !== CAPABILITY_SPEC_VERSION) throw new Error(`bad capability spec: ${block.spec}`);
  const { hash, ...rest } = block;
  const recomputed = _shortHash(_canon(rest));
  if (hash !== recomputed) throw new Error('capability block hash mismatch');
  return Object.freeze({ ...block });
}

// ── lineage block ───────────────────────────────────────────────────────────

// Build a lineage block. Required: source (string telling the verifier which
// pipeline produced the artifact). Optional: every pointer field that
// applies, each a hash that the verifier can resolve against the bundled or
// catalog-known artifacts/traces/teams/rounds.
//
// Inputs:
//   {
//     source:                  'rule_synthesis'|'workflow_compile'|
//                              'distillation'|'federated_aggregation'|'rebuild',
//     parent_artifact_hash:    hex64 of the artifact this one descended from,
//     source_trace_ids:        [hex32] of traces that fed compile-ir,
//     workflow_ir_hash:        hex16 IR shape hash,
//     team_event_head_hash:    hex16 head of the team event log folded in,
//     federated_round_id:      string round id from federated-learning.js,
//     teacher:                 {vendor, model, version, redaction_map_hash},
//     student_base:            {repo, revision},
//     distillation_method:     'lora'|'full-ft'|'qlora'|'prompt-distill',
//     training_corpus_hash:    hex64 of (train pairs) feed,
//     compile_seed:            string deterministic seed,
//     notes:                   string,
//   }
const LINEAGE_FIELDS = new Set([
  'source', 'parent_artifact_hash', 'source_trace_ids', 'workflow_ir_hash',
  'team_event_head_hash', 'federated_round_id', 'teacher', 'student_base',
  'distillation_method', 'training_corpus_hash', 'compile_seed', 'notes',
]);
const VALID_SOURCES = new Set([
  'rule_synthesis', 'workflow_compile', 'distillation',
  'federated_aggregation', 'rebuild',
]);
const VALID_DISTILL_METHODS = new Set([
  'lora', 'full-ft', 'qlora', 'prompt-distill',
]);

export function buildLineage(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('lineage input must be object');
  for (const k of Object.keys(input)) {
    if (!LINEAGE_FIELDS.has(k)) throw new Error(`unknown lineage field: ${k}`);
  }
  if (!input.source) throw new Error('lineage.source required');
  if (!VALID_SOURCES.has(input.source)) throw new Error(`unknown lineage source: ${input.source}`);
  const out = { spec: LINEAGE_SPEC_VERSION, source: input.source };

  if (input.parent_artifact_hash) {
    if (!HEX64_RE.test(input.parent_artifact_hash)) throw new Error('parent_artifact_hash must be hex64');
    out.parent_artifact_hash = input.parent_artifact_hash;
  }
  if (input.source_trace_ids) {
    if (!Array.isArray(input.source_trace_ids)) throw new Error('source_trace_ids must be array');
    for (const t of input.source_trace_ids) {
      if (!HEX32_RE.test(t)) throw new Error(`source_trace_id must be hex32: ${t}`);
    }
    out.source_trace_ids = [...input.source_trace_ids].sort();
  }
  if (input.workflow_ir_hash) {
    if (!HEX16_RE.test(input.workflow_ir_hash)) throw new Error('workflow_ir_hash must be hex16');
    out.workflow_ir_hash = input.workflow_ir_hash;
  }
  if (input.team_event_head_hash) {
    if (!HEX16_RE.test(input.team_event_head_hash)) throw new Error('team_event_head_hash must be hex16');
    out.team_event_head_hash = input.team_event_head_hash;
  }
  if (input.federated_round_id) {
    if (typeof input.federated_round_id !== 'string') throw new Error('federated_round_id must be string');
    out.federated_round_id = input.federated_round_id;
  }
  if (input.teacher) {
    if (!input.teacher.vendor || !input.teacher.model) {
      throw new Error('teacher requires {vendor, model}');
    }
    out.teacher = {
      vendor: String(input.teacher.vendor),
      model: String(input.teacher.model),
    };
    if (input.teacher.version) out.teacher.version = String(input.teacher.version);
    if (input.teacher.redaction_map_hash) {
      if (!HEX16_RE.test(input.teacher.redaction_map_hash)) {
        throw new Error('teacher.redaction_map_hash must be hex16');
      }
      out.teacher.redaction_map_hash = input.teacher.redaction_map_hash;
    }
  }
  if (input.student_base) {
    if (!input.student_base.repo) throw new Error('student_base requires {repo}');
    out.student_base = { repo: String(input.student_base.repo) };
    if (input.student_base.revision) out.student_base.revision = String(input.student_base.revision);
  }
  if (input.distillation_method) {
    if (!VALID_DISTILL_METHODS.has(input.distillation_method)) {
      throw new Error(`unknown distillation_method: ${input.distillation_method}`);
    }
    out.distillation_method = input.distillation_method;
  }
  if (input.training_corpus_hash) {
    if (!HEX64_RE.test(input.training_corpus_hash)) throw new Error('training_corpus_hash must be hex64');
    out.training_corpus_hash = input.training_corpus_hash;
  }
  if (input.compile_seed) {
    if (typeof input.compile_seed !== 'string') throw new Error('compile_seed must be string');
    out.compile_seed = input.compile_seed;
  }
  if (input.notes) {
    if (typeof input.notes !== 'string') throw new Error('notes must be string');
    out.notes = input.notes;
  }

  // Source-specific required fields. distillation and workflow_compile both
  // make claims that must be backed by something concrete.
  if (out.source === 'distillation' && !out.teacher) {
    throw new Error("source='distillation' requires teacher info");
  }
  if (out.source === 'distillation' && !out.student_base) {
    throw new Error("source='distillation' requires student_base info");
  }
  if (out.source === 'workflow_compile' && !out.workflow_ir_hash) {
    throw new Error("source='workflow_compile' requires workflow_ir_hash");
  }
  if (out.source === 'workflow_compile' && (!out.source_trace_ids || out.source_trace_ids.length === 0)) {
    throw new Error("source='workflow_compile' requires source_trace_ids");
  }
  if (out.source === 'federated_aggregation' && !out.federated_round_id) {
    throw new Error("source='federated_aggregation' requires federated_round_id");
  }

  out.hash = _shortHash(_canon(out));
  return out;
}

export function validateLineage(block) {
  if (!block || typeof block !== 'object') throw new Error('lineage block must be object');
  if (block.spec !== LINEAGE_SPEC_VERSION) throw new Error(`bad lineage spec: ${block.spec}`);
  const { hash, ...rest } = block;
  const recomputed = _shortHash(_canon(rest));
  if (hash !== recomputed) throw new Error('lineage block hash mismatch');
  return Object.freeze({ ...block });
}

// Convenience: build a combined block to attach to a manifest at the top
// level (manifest.capability + manifest.lineage). Returns null fields when
// the caller passes nothing for either side, so legacy artifacts stay
// schema-compatible.
export function buildManifestBlocks({ capability, lineage } = {}) {
  return {
    capability: capability ? buildCapability(capability) : null,
    lineage: lineage ? buildLineage(lineage) : null,
  };
}

export default {
  CAPABILITY_SPEC_VERSION,
  LINEAGE_SPEC_VERSION,
  buildCapability,
  validateCapability,
  buildLineage,
  validateLineage,
  buildManifestBlocks,
};

// =============================================================================
// W739 — Model Lineage Tracking: parent_cid chain + walk + perf comparison.
//
// W707-W835 plan items W739-1..W739-4:
//
//   W739-1  Each .kolm references its parent artifact via a manifest
//           `parent_cid` field. The field is OPTIONAL (root / first-of-line
//           artifacts carry parent_cid:null). The W460 byte-stability law
//           applies: when parent_cid is null/absent the slot is OMITTED from
//           artifact_hash_input so pre-W739 artifacts remain byte-identical.
//
//   W739-2  `kolm diff <a.kolm> <b.kolm>` shows performance delta + roll-back
//           recommendation. See src/kolm-diff.js for the file-IO wrapper that
//           calls compareArtifactPerformance below.
//
//   W739-3  A/B test versions in production. The lineage walk + diff give
//           operators the data they need; the routing layer that uses it
//           lands in W777. For W739 the chain + diff are the foundation.
//
//   W739-4  Model lineage tracking baked into the file format itself — the
//           hash chain anchored at parent_cid means a tamperer cannot rewrite
//           history without invalidating every descendant's receipt.
//
// Symbols below are namespaced to W739 so they cannot collide with the
// older `buildLineage` / `validateLineage` schema-block helpers above.
// =============================================================================

export const LINEAGE_VERSION = 'w739-v1';

const PARENT_CID_RE = /^[0-9a-f]{64}$/;

// W739-1 — set a parent_cid on a manifest. The cid MUST be sha256-hex
// (64 lowercase hex chars) OR explicitly null. Anything else throws so a
// malformed lineage pointer is caught at build time, not at the first
// `kolm lineage <cid>` walk on a deployed artifact.
export function setParentCid(manifest, parent_cid) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('setParentCid: manifest must be an object');
  }
  if (parent_cid === null || parent_cid === undefined) {
    // The honest "no parent" case. Strip any stale key so byte-stability
    // (W460) holds: the absent key MUST collapse identically to null.
    const out = { ...manifest };
    delete out.parent_cid;
    return out;
  }
  if (typeof parent_cid !== 'string' || !PARENT_CID_RE.test(parent_cid)) {
    throw new Error(
      'setParentCid: parent_cid must be sha256-hex (64 lowercase hex chars) or null; got ' +
      JSON.stringify(parent_cid),
    );
  }
  return { ...manifest, parent_cid };
}

// W739-1 — read a parent_cid off a manifest. Returns null when absent or
// when the manifest carries the explicit null sentinel.
export function getParentCid(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const v = manifest.parent_cid;
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !PARENT_CID_RE.test(v)) return null;
  return v;
}

// W739-1 / W739-4 — walk a lineage chain starting at `leafCid` by following
// parent_cid pointers. The loader is dependency-injected so this module
// stays pure (tests pass a mock; the router passes a tenant-fenced
// loader; the CLI passes a local-artifacts loader). Cycle-safe via a
// visited Set — a malicious or corrupted chain that loops back on
// itself terminates with truncated:true instead of running forever.
//
// loadArtifact(cid) → { manifest, k_score, created_at, parent_cid }
//   The loader returns null/undefined when the cid is unknown so a
//   dangling pointer surfaces as the END of the chain rather than a
//   thrown exception.
//
// Returns:
//   { ok:true, chain:[{cid, parent_cid, k_score, created_at}], depth, truncated }
//   { ok:false, error:'leaf_not_found' | 'load_failure', detail, hint }
export async function walkLineage(loadArtifact, leafCid, opts = {}) {
  if (typeof loadArtifact !== 'function') {
    throw new Error('walkLineage: loadArtifact must be a function');
  }
  if (typeof leafCid !== 'string' || leafCid.length === 0) {
    return {
      ok: false,
      error: 'leaf_cid_required',
      hint: 'walkLineage requires a non-empty leaf cid string',
      version: LINEAGE_VERSION,
    };
  }
  const max_depth = (opts && Number.isFinite(opts.max_depth) && opts.max_depth > 0)
    ? Math.min(1000, Math.floor(opts.max_depth))
    : 10;
  const chain = [];
  const visited = new Set();
  let cursor = leafCid;
  let truncated = false;
  for (let depth = 0; depth < max_depth; depth++) {
    if (visited.has(cursor)) {
      // Cycle detected — the chain folded back on itself. Stop walking
      // and surface truncated:true so the operator sees the loop.
      truncated = true;
      break;
    }
    visited.add(cursor);
    let row;
    try {
      row = await loadArtifact(cursor);
    } catch (e) {
      if (depth === 0) {
        return {
          ok: false,
          error: 'load_failure',
          detail: (e && e.message) || String(e),
          cid: cursor,
          hint: 'leaf artifact load failed; pass a valid cid known to the loader',
          version: LINEAGE_VERSION,
        };
      }
      // Mid-chain load failure: stop walking but surface what we have so
      // an operator sees partial lineage rather than nothing.
      truncated = true;
      break;
    }
    if (!row || typeof row !== 'object') {
      if (depth === 0) {
        return {
          ok: false,
          error: 'leaf_not_found',
          cid: cursor,
          hint: 'loader returned null for leaf cid; the artifact may not exist locally',
          version: LINEAGE_VERSION,
        };
      }
      // Parent pointer dangled — record the gap and stop.
      truncated = true;
      break;
    }
    const parent_cid = (typeof row.parent_cid === 'string' && PARENT_CID_RE.test(row.parent_cid))
      ? row.parent_cid
      : null;
    chain.push({
      cid: cursor,
      parent_cid,
      k_score: (row.k_score === null || row.k_score === undefined) ? null : row.k_score,
      created_at: row.created_at || null,
    });
    if (!parent_cid) break;
    cursor = parent_cid;
  }
  // If we hit max_depth and the last row STILL had a parent_cid, the chain
  // was longer than max_depth — flag truncated:true.
  if (!truncated && chain.length === max_depth) {
    const tail = chain[chain.length - 1];
    if (tail && tail.parent_cid) truncated = true;
  }
  return {
    ok: true,
    chain,
    depth: chain.length,
    truncated,
    version: LINEAGE_VERSION,
  };
}

// W739-2 — compare two artifacts' performance metadata. Operators use this
// to decide whether to roll back a freshly-shipped artifact.
//
// Inputs (both meta objects look like):
//   { k_score: {composite, faithfulness, coverage, calibration, ...}, ... }
//   The legacy shape (top-level numbers, no nested k_score) is also accepted.
//
// Thresholds:
//   - ANY axis dropping by more than 0.02 between A → B  → 'roll_back'
//   - ALL axes improving OR unchanged                    → 'promote'
//   - Otherwise (mixed: some improve, some regress <=0.02)  → 'inconclusive'
//
// Returns:
//   { ok:true, deltas:{...}, regression_summary, recommendation, version }
//   where `deltas[axis] = b - a` (positive = improvement, negative = regression).
export function compareArtifactPerformance(a_meta, b_meta) {
  const REGRESSION_THRESHOLD = 0.02;
  if (!a_meta || typeof a_meta !== 'object') {
    return {
      ok: false,
      error: 'a_meta_required',
      hint: 'compareArtifactPerformance: a_meta must be an object with k_score axes',
      version: LINEAGE_VERSION,
    };
  }
  if (!b_meta || typeof b_meta !== 'object') {
    return {
      ok: false,
      error: 'b_meta_required',
      hint: 'compareArtifactPerformance: b_meta must be an object with k_score axes',
      version: LINEAGE_VERSION,
    };
  }
  // Accept either {k_score:{...}} or {composite,faithfulness,...} at top level.
  const a_axes = (a_meta.k_score && typeof a_meta.k_score === 'object') ? a_meta.k_score : a_meta;
  const b_axes = (b_meta.k_score && typeof b_meta.k_score === 'object') ? b_meta.k_score : b_meta;
  // Track every numeric axis that exists in BOTH inputs. Non-numeric or
  // missing-on-either-side axes are silently dropped — we never invent a
  // delta for a field we cannot measure.
  const SHARED_AXES = new Set();
  for (const k of Object.keys(a_axes || {})) {
    if (typeof a_axes[k] === 'number' && typeof b_axes[k] === 'number') {
      SHARED_AXES.add(k);
    }
  }
  const deltas = {};
  let bigDropAxes = [];       // delta < -threshold → roll_back
  let smallDropAxes = [];     // -threshold <= delta < 0 → inconclusive (not a roll-back, but not a clean promote)
  let improveAxes = [];        // delta > 0
  let unchangedAxes = [];      // delta === 0
  for (const axis of SHARED_AXES) {
    const a_v = a_axes[axis];
    const b_v = b_axes[axis];
    const d = Number((b_v - a_v).toFixed(6));
    deltas[axis] = d;
    if (d < -REGRESSION_THRESHOLD) bigDropAxes.push({ axis, delta: d });
    else if (d < 0) smallDropAxes.push({ axis, delta: d });
    else if (d > 0) improveAxes.push({ axis, delta: d });
    else unchangedAxes.push({ axis, delta: d });
  }
  let recommendation;
  let regression_summary;
  if (SHARED_AXES.size === 0) {
    recommendation = 'inconclusive';
    regression_summary = 'no shared numeric axes between a and b — cannot compare';
  } else if (bigDropAxes.length > 0) {
    recommendation = 'roll_back';
    regression_summary = `regression on ${bigDropAxes.length} axis${bigDropAxes.length === 1 ? '' : 'es'}: ` +
      bigDropAxes.map(r => `${r.axis}=${r.delta.toFixed(4)}`).join(', ');
  } else if (smallDropAxes.length === 0 && improveAxes.length > 0) {
    // No drop ANYWHERE + at least one axis improved = clean promote.
    recommendation = 'promote';
    regression_summary = `no regression; ${improveAxes.length} axis${improveAxes.length === 1 ? '' : 'es'} improved`;
  } else if (smallDropAxes.length > 0) {
    // Mixed — some axes worsened (but not past the regression threshold) and
    // possibly others improved. Cannot cleanly promote; cannot demand
    // roll-back either. Inconclusive: ship the comparison, let the operator
    // decide.
    recommendation = 'inconclusive';
    regression_summary = `mixed: ${smallDropAxes.length} axis${smallDropAxes.length === 1 ? '' : 'es'} worsened by < ${REGRESSION_THRESHOLD}; ` +
      `${improveAxes.length} improved, ${unchangedAxes.length} unchanged`;
  } else {
    // All unchanged.
    recommendation = 'inconclusive';
    regression_summary = `no measurable change across ${SHARED_AXES.size} axis${SHARED_AXES.size === 1 ? '' : 'es'}`;
  }
  return {
    ok: true,
    deltas,
    regression_summary,
    recommendation,
    axes_compared: Array.from(SHARED_AXES).sort(),
    version: LINEAGE_VERSION,
  };
}
