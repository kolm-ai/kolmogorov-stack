// .kolm artifact packager.
//
// A `.kolm` is a signed zip containing:
//   manifest.json     - task descriptor, hashes, training stats
//   recipes.json      - deterministic draft pack (registry slice)
//   model.gguf        - base model pointer (cloud-runtime stage 1) or
//                       file (sprint 3 once the LoRA bridge ships)
//   lora.bin          - LoRA delta (sprint 3 — empty placeholder today)
//   index.sqlite-vec  - multimodal recall index (sprint 1 — empty placeholder
//                       today; populated in sprint 1 once /v1/embed is live)
//   signature.sig     - HMAC chain anchored to the public registry
//
// We do NOT embed real model weights in the v0 artifact. The cloud signs
// a *pointer* to the base model + per-recipe drafts + recall namespace
// + LoRA pointer. `kolm run` resolves those pointers at first launch.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';

const ARTIFACT_SPEC = 'kolm-1';
const SIGN_SECRET = process.env.KOLM_ARTIFACT_SECRET || process.env.RECIPE_RECEIPT_SECRET || 'ks_artifact_dev_secret_change_in_prod';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

// Compute the K-score — the visible scoreboard for "smallest artifact that
// still passes the tests wins." We surface the five raw axes plus a single
// composite number so a UI can sort artifacts.
//
//   accuracy:        verifier pass-rate on the training positives [0..1]
//   coverage:        fraction of declared task surface the artifact handles [0..1]
//   p50_latency_us:  median run-time per call (recipe-mode = compiled fn; verified-mode = api round-trip)
//   cost_usd_per_call: marginal $ at run-time (0 for pure-recipe; >0 when routed through wrap/verified)
//   size_bytes:      total .kolm zip on disk
//
// composite is intentionally simple — bigger is better, smaller artifacts
// with higher accuracy/coverage win:
//   composite = (accuracy * coverage * 1000) / log2(size_kb + 2)
// A 5KB artifact at 100% accuracy/coverage scores ~588; a 50MB one scores ~62.
export function computeKScore({ size_bytes, accuracy, coverage, p50_latency_us, cost_usd_per_call }) {
  const acc = Math.max(0, Math.min(1, accuracy ?? 0));
  const cov = Math.max(0, Math.min(1, coverage ?? 0));
  const size_kb = (size_bytes || 0) / 1024;
  const denom = Math.log2(size_kb + 2);
  const composite = denom > 0 ? Number(((acc * cov * 1000) / denom).toFixed(2)) : 0;
  return {
    accuracy: Number(acc.toFixed(4)),
    coverage: Number(cov.toFixed(4)),
    p50_latency_us: p50_latency_us ?? null,
    cost_usd_per_call: cost_usd_per_call ?? 0,
    size_bytes: size_bytes || 0,
    composite,
    spec: 'k-score-1',
  };
}

// Build the artifact payload (the parts that end up *inside* the zip).
// Returns a list of {filename, content} entries plus the manifest.
export function buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score }) {
  const recipes_json = JSON.stringify({
    spec: 'rs-1',
    n: recipes.length,
    recipes: recipes.map(r => ({
      id: r.id,
      name: r.name,
      source: r.source,
      source_hash: r.source_hash,
      version_id: r.version_id,
      tags: r.tags || [],
      schema: r.schema || null,
    })),
  }, null, 2);

  // Empty placeholder LoRA + sqlite-vec index until Sprints 1 & 3 fill them in.
  const lora_bin = Buffer.from('');
  const index_bin = Buffer.from('');

  // model.gguf is a pointer record, not weights. `kolm run` resolves it.
  const model_pointer = JSON.stringify({
    spec: ARTIFACT_SPEC,
    base_model: base_model || 'qwen2.5-coder-7b-instruct-q4_0',
    runtime: 'cloud',
    note: 'pointer-only artifact; weights resolved on `kolm run` first launch.',
  }, null, 2);

  // evals.json — the "no eval, no compile" gate. Synthesized from the
  // user's positives at compile time; surfaced in the artifact so anyone
  // can recompute K-score by re-running them.
  const evals_obj = evals && evals.cases ? evals : {
    spec: 'rs-1-evals',
    n: 0,
    cases: [],
    notes: 'compile-time evals were not supplied; K-score uses synthesizer pass-rate only',
  };
  const evals_json = JSON.stringify(evals_obj, null, 2);

  const manifest = {
    spec: ARTIFACT_SPEC,
    job_id,
    task,
    created_at: new Date().toISOString(),
    runtime: 'cloud',  // becomes 'on-device' once Sprint 3 LoRA bridge ships
    base_model: base_model || 'qwen2.5-coder-7b-instruct-q4_0',
    recipes: {
      n: recipes.length,
      registry_hash: sha256(canonicalJson(recipes.map(r => ({ id: r.id, hash: r.source_hash })))),
    },
    lora: lora_pointer || null,
    recall: recall_namespace ? { namespace: recall_namespace } : null,
    training: training_stats || { distilled_pairs: 0, accuracy: null },
    evals: { n: evals_obj.n || (evals_obj.cases?.length || 0), spec: evals_obj.spec },
    k_score: k_score || null,  // patched after zipping for the size_bytes axis
    hashes: {
      model_pointer: sha256(Buffer.from(model_pointer)),
      recipes_json: sha256(Buffer.from(recipes_json)),
      lora_bin: sha256(lora_bin),
      index_bin: sha256(index_bin),
      evals_json: sha256(Buffer.from(evals_json)),
    },
  };
  const manifest_json = JSON.stringify(manifest, null, 2);
  const manifest_hash = sha256(Buffer.from(manifest_json));

  const sig_payload = canonicalJson({
    spec: ARTIFACT_SPEC,
    manifest_hash,
    job_id,
  });
  const hmac = crypto.createHmac('sha256', SIGN_SECRET).update(sig_payload).digest('hex');
  const signature = JSON.stringify({
    spec: ARTIFACT_SPEC,
    job_id,
    manifest_hash,
    hmac_alg: 'HMAC-SHA256',
    hmac,
    issued_at: new Date().toISOString(),
  }, null, 2);

  return {
    manifest,
    files: [
      { filename: 'manifest.json',    content: Buffer.from(manifest_json) },
      { filename: 'model.gguf',       content: Buffer.from(model_pointer) },
      { filename: 'recipes.json',     content: Buffer.from(recipes_json) },
      { filename: 'lora.bin',         content: lora_bin },
      { filename: 'index.sqlite-vec', content: index_bin },
      { filename: 'evals.json',       content: Buffer.from(evals_json) },
      { filename: 'signature.sig',    content: Buffer.from(signature) },
    ],
  };
}

// Stream the .kolm zip to a writable target (file path or HTTP response).
export function packageArtifact({ job_id, payload, outPath }) {
  return new Promise((resolve, reject) => {
    const target = outPath
      ? fs.createWriteStream(outPath)
      : null;
    const z = archiver('zip', { zlib: { level: 9 } });
    if (target) {
      z.pipe(target);
      target.on('close', () => resolve({ bytes: z.pointer() }));
    }
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    for (const f of payload.files) {
      z.append(f.content, { name: f.filename });
    }
    z.finalize();
    if (!target) {
      // caller will pipe z elsewhere
      resolve({ archive: z });
    }
  });
}

// Convenience: build + zip in one step. Returns the zip path.
//
// We zip twice when k_score is requested: once to measure size, then again
// with the size-aware K-score patched into the manifest. The double-zip is
// cheap (≤10ms for 5KB artifacts) and keeps the K-score honest — the size
// axis includes the K-score bytes themselves.
export async function buildAndZip({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, outDir }) {
  const dir = outDir || path.join(os.tmpdir(), 'kolm-artifacts');
  fs.mkdirSync(dir, { recursive: true });

  // Pass 1 — zip to measure size.
  const probePayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals });
  const outPath = path.join(dir, `${job_id}.kolm`);
  await packageArtifact({ job_id, payload: probePayload, outPath });
  const probeBytes = fs.statSync(outPath).size;

  // K-score: derive accuracy/coverage/latency/cost from training stats and
  // any supplied evals. For Sprint 1 stub: pure-recipe artifacts have
  // cost=0 (no run-time API calls), latency = compiled-fn p50 ~50us, and
  // accuracy = synthesizer pass-rate. Coverage starts at the eval count
  // ratio; if no evals supplied, it equals accuracy (best-effort).
  const accuracy = training_stats?.pass_rate_positive ?? (training_stats?.verifier_accepted ? 1.0 : 0.0);
  const coverage = evals && evals.coverage != null ? evals.coverage : accuracy;
  const k_score = computeKScore({
    size_bytes: probeBytes,
    accuracy,
    coverage,
    p50_latency_us: training_stats?.latency_p50_us ?? 50,
    cost_usd_per_call: training_stats?.cost_usd_per_call ?? 0,
  });

  // Pass 2 — repackage with the K-score in the manifest. Size delta is small
  // (~80 bytes); we re-derive K-score on the final artifact below.
  const finalPayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score });
  await packageArtifact({ job_id, payload: finalPayload, outPath });
  const stat = fs.statSync(outPath);

  // Final K-score reflects the actual on-disk size.
  finalPayload.manifest.k_score = computeKScore({
    size_bytes: stat.size,
    accuracy,
    coverage,
    p50_latency_us: training_stats?.latency_p50_us ?? 50,
    cost_usd_per_call: training_stats?.cost_usd_per_call ?? 0,
  });

  return { outPath, manifest: finalPayload.manifest, bytes: stat.size, k_score: finalPayload.manifest.k_score };
}

export function verifyManifestSignature(manifest_json, signature) {
  try {
    const sig = typeof signature === 'string' ? JSON.parse(signature) : signature;
    if (!sig || sig.spec !== ARTIFACT_SPEC || !sig.hmac) return { valid: false, reason: 'bad signature shape' };
    const manifest_hash = sha256(Buffer.from(manifest_json));
    if (manifest_hash !== sig.manifest_hash) return { valid: false, reason: 'manifest_hash mismatch' };
    const expected = crypto.createHmac('sha256', SIGN_SECRET).update(canonicalJson({
      spec: ARTIFACT_SPEC, manifest_hash, job_id: sig.job_id,
    })).digest('hex');
    let diff = 0;
    if (sig.hmac.length !== expected.length) return { valid: false, reason: 'hmac length' };
    for (let i = 0; i < sig.hmac.length; i++) diff |= sig.hmac.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0 ? { valid: true } : { valid: false, reason: 'hmac mismatch' };
  } catch (e) {
    return { valid: false, reason: String(e.message || e) };
  }
}
