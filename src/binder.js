// src/binder.js
//
// Compliance binder generator. Takes a .kolm artifact and emits a printable
// HTML report that a security reviewer signs off on before deployment.
//
// The deliverable looks like a one-pager an auditor can sign and file. It
// contains every piece of evidence kolm produces about an artifact, laid out
// in the order a reviewer reads:
//
//   1. Verification summary  — pass/fail/warn per check, top-of-page
//   2. Identity              — CID, artifact hash, base model, tier
//   3. K-score evidence      — composite + raw axes + gate pass/fail
//   4. Manifest hashes       — sha256 over every file inside the .kolm
//   5. Audit chain           — 5-step HMAC chain (task→seeds→recipes→evals→package)
//   6. Credential signer     — provenance credential, signer namespace, parent
//   7. Eval coverage         — case count, pass-rate, judge id
//   8. Reproduction recipe   — the four commands needed to re-verify from disk
//
// The binder is offline-verifiable: every claim it makes can be re-checked by
// running `kolm verify` against the same artifact bytes. The HTML embeds the
// recomputed CID and chain hash, so a buyer who suspects tampering can re-run
// the open-source verifier and compare. The HMAC verification itself requires
// the same RECIPE_RECEIPT_SECRET that produced the artifact — by design, only
// the issuer (and parties they share the secret with) can produce a green
// "signature verified" check. A buyer who lacks the secret still sees the
// chain structure and per-step input/output hashes; they just see the
// signature line in the "unverified" state and know to ask the issuer to
// re-sign through their own verifier.
//
// Surface:
//
//     import { buildBinder, writeBinder } from './binder.js';
//
//     const html = buildBinder(artifactPath);
//     writeBinder(artifactPath, 'out.html');
//
// CLI:
//
//     kolm verify <artifact.kolm> --binder out.html
//
// No external dependencies. The CSS is print-optimized — letter-sized pages,
// no animations, no web fonts. Opens identically in Chrome, Safari, Firefox,
// and as a PDF when "Save as PDF" is invoked from the browser's print dialog.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadArtifact, isArtifactPathCloudTrusted } from './artifact-runner.js';
import { cidFromManifestHashes, parseCid, shortCid } from './cid.js';
import { verifyCredential } from './provenance.js';
import { effectiveReceiptSecret } from './env.js';

const BINDER_SPEC = 'kolm-binder/0.1';

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtMicros(us) {
  if (us == null) return '—';
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function fmtCost(c) {
  if (c == null) return '—';
  if (c === 0) return '$0.00';
  if (c < 0.0001) return `$${c.toExponential(2)}`;
  return `$${c.toFixed(4)}`;
}

// Structural-integrity checks. Used when the artifact is cloud-trusted (the
// local CLI lacks RECIPE_RECEIPT_SECRET, so HMAC verification is impossible)
// to confirm the chain and credential are well-formed and bind to this
// exact manifest. The trust list pins the bytes-on-disk by sha256.

function chainStructuralIntegrityOk(receipt) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'receipt missing or not an object' };
  if (!Array.isArray(receipt.chain)) return { ok: false, reason: 'receipt.chain not an array' };
  if (receipt.chain.length === 0) return { ok: false, reason: 'receipt.chain is empty' };
  for (let i = 0; i < receipt.chain.length; i++) {
    const step = receipt.chain[i];
    if (!step || typeof step !== 'object') return { ok: false, reason: `step ${i} not an object` };
    for (const f of ['step', 'input_hash', 'output_hash', 'hmac']) {
      if (typeof step[f] !== 'string' || step[f].length === 0) return { ok: false, reason: `step ${i} missing field ${f}` };
    }
    // Chain link: each step's input_hash should reference the prior step's
    // output_hash. The first step's input is the task spec hash, so it has
    // no predecessor to compare against.
    if (i > 0) {
      const prior = receipt.chain[i - 1];
      if (step.input_hash !== prior.output_hash) {
        return { ok: false, reason: `step ${i} input_hash does not link to step ${i - 1} output_hash` };
      }
    }
  }
  if (typeof receipt.signature !== 'string' || receipt.signature.length === 0) {
    return { ok: false, reason: 'receipt body signature missing' };
  }
  return { ok: true };
}

function credentialStructuralIntegrityOk(credential, manifest) {
  if (!credential || typeof credential !== 'object') return { ok: false, reason: 'credential missing or not an object' };
  if (credential.spec !== 'kolm-credential/0.1') return { ok: false, reason: `unexpected spec ${credential.spec}` };
  for (const f of ['type', 'claim_generator', 'artifact_hash', 'cid', 'signature', 'signature_alg', 'signed_at']) {
    if (typeof credential[f] !== 'string' || credential[f].length === 0) {
      return { ok: false, reason: `credential missing field ${f}` };
    }
  }
  if (!credential.assertions || typeof credential.assertions !== 'object') {
    return { ok: false, reason: 'credential.assertions missing or not an object' };
  }
  // The credential's cid must match the manifest's cid: the credential
  // is bound to this artifact, not some other one.
  if (manifest && manifest.cid && credential.cid !== manifest.cid) {
    return { ok: false, reason: `credential cid does not match manifest cid` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Verification harness — runs every check the binder reports on. Each check
// returns `{ name, status: 'pass'|'fail'|'warn', detail }`. A failing check
// produces a red row at the top of the binder and a non-zero exit code from
// the CLI; a warning produces a yellow row but keeps the binder valid.
// ---------------------------------------------------------------------------

async function verifyArtifact(bundle) {
  const checks = [];

  // Cloud-trust detection. When the artifact bytes are recorded in
  // ~/.kolm/cloud-trusted.json (set by `kolm compile` cloud path on download),
  // the local CLI does not hold the RECIPE_RECEIPT_SECRET that signed the
  // chain. The deeper HMAC checks below then switch to structural-integrity
  // mode: we confirm the chain and credential are well-formed and bind to
  // this exact manifest, but skip the HMAC seal. The artifact's sha256 in the
  // trust list is the proof we downloaded these exact bytes.
  const cloudTrustedSha = bundle.signature_mode === 'cloud-trusted'
    ? isArtifactPathCloudTrusted(bundle.artifact_path)
    : null;

  // 1. Signature already verified by loadArtifact — if we got here, the
  // legacy signature.sig HMAC matched, or the artifact is cloud-trusted.
  checks.push({
    name: 'Manifest signature (legacy HMAC)',
    status: bundle.signature_valid ? 'pass' : 'fail',
    detail: bundle.signature_valid
      ? (bundle.signature_mode === 'cloud-trusted'
          ? 'cloud-signed; trusted via local list (artifact sha256 in ~/.kolm/cloud-trusted.json)'
          : 'signature.sig HMAC matches manifest.json sha256')
      : 'signature.sig did not verify (mismatch)',
  });

  // 2. CID round-trip — recompute from manifest hashes, compare to embedded.
  const manifest = bundle.manifest;
  if (manifest.hashes) {
    let recomputed;
    try { recomputed = cidFromManifestHashes(manifest.hashes); }
    catch (e) { recomputed = `error: ${e.message}`; }
    const matches = recomputed === manifest.cid;
    checks.push({
      name: 'Content identifier (CID) round-trip',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `recomputed CID matches manifest.cid: ${shortCid(manifest.cid)}`
        : `embedded ${manifest.cid} ≠ recomputed ${recomputed}`,
    });
  } else {
    checks.push({
      name: 'Content identifier (CID) round-trip',
      status: 'warn',
      detail: 'manifest is missing the hashes block — cannot recompute CID',
    });
  }

  // 3. Receipt chain — every step's HMAC verifies under the same secret.
  // If the secret isn't available we report "structural" pass + "unverified".
  // When the artifact is cloud-trusted (sha256 recorded in
  // ~/.kolm/cloud-trusted.json by `kolm compile` cloud path), HMAC verification
  // is impossible locally (the cloud holds the secret) so we fall back to a
  // structural-integrity check: chain shape valid, each step well-formed,
  // step output_hash threads into the next step's input_hash.
  const receipt = bundle.receipt;
  if (!receipt) {
    checks.push({
      name: 'Audit chain (HMAC receipt)',
      status: 'warn',
      detail: 'no receipt.json found; this is pre-v0.1 artifact format',
    });
  } else {
    const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
    const chainStructureOk = chainStructuralIntegrityOk(receipt);
    if (cloudTrustedSha) {
      // Cloud-trust path. Structural check stands in for HMAC verification
      // because the cloud holds the signing secret. The bytes-on-disk are
      // pinned by sha256 in ~/.kolm/cloud-trusted.json.
      checks.push({
        name: 'Audit chain (HMAC receipt)',
        status: chainStructureOk.ok ? 'pass' : 'fail',
        detail: chainStructureOk.ok
          ? `structural integrity verified across ${receipt.chain?.length || 0} steps (cloud-signed; HMAC chain seal trusted via cloud-trust list)`
          : `chain structural integrity failed: ${chainStructureOk.reason}`,
      });
    } else if (!secret) {
      checks.push({
        name: 'Audit chain (HMAC receipt)',
        status: 'warn',
        detail: `chain structure ok (${receipt.chain?.length || 0} steps); HMAC unverified — RECIPE_RECEIPT_SECRET not present in this environment`,
      });
    } else {
      const chainOk = (receipt.chain || []).every(step => {
        const expected = hmacHex(secret, canonicalJson({
          step: step.step, input_hash: step.input_hash, output_hash: step.output_hash,
        }));
        return expected === step.hmac;
      });
      const bodyOk = (() => {
        const { signature, ...rest } = receipt;
        return hmacHex(secret, canonicalJson(rest)) === signature;
      })();
      checks.push({
        name: 'Audit chain (HMAC receipt)',
        status: (chainOk && bodyOk) ? 'pass' : 'fail',
        detail: (chainOk && bodyOk)
          ? `chain verified across ${receipt.chain.length} steps; receipt body signature verified`
          : (!chainOk ? 'chain step HMAC mismatch' : 'receipt body signature mismatch'),
      });
    }
  }

  // 4. K-score gate — composite ≥ 0.85.
  const k = manifest.k_score;
  if (!k) {
    checks.push({
      name: 'K-score gate',
      status: 'fail',
      detail: 'manifest carries no k_score block',
    });
  } else if (k.composite >= (k.gate || 0.85)) {
    checks.push({
      name: 'K-score gate',
      status: 'pass',
      detail: `composite ${k.composite.toFixed(4)} ≥ gate ${(k.gate || 0.85).toFixed(2)}`,
    });
  } else {
    checks.push({
      name: 'K-score gate',
      status: 'fail',
      detail: `composite ${k.composite.toFixed(4)} below gate ${(k.gate || 0.85).toFixed(2)}; artifact should not be deployed`,
    });
  }

  // 5. Provenance credential. Re-read it from the zip because loadArtifact
  // doesn't surface it. Older artifacts pre-date kolm-credential/0.1 and a
  // missing credential is a warning, not a failure.
  let credential = null;
  try {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(bundle.artifact_path);
    const e = zip.getEntries().find(x => x.entryName === 'credential.json');
    if (e) credential = JSON.parse(e.getData().toString('utf8'));
  } catch { /* swallow — credential is optional */ }

  if (!credential) {
    checks.push({
      name: 'Provenance credential',
      status: 'warn',
      detail: 'no credential.json found (artifact built before kolm-credential/0.1)',
    });
  } else {
    const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
    const credStructure = credentialStructuralIntegrityOk(credential, bundle.manifest);
    if (cloudTrustedSha) {
      // Cloud-trust path. The credential signature was produced with the
      // cloud's secret which the local CLI does not hold. Confirm the
      // credential is well-formed and binds to this exact manifest, then
      // trust the signature via the cloud-trust list.
      checks.push({
        name: 'Provenance credential',
        status: credStructure.ok ? 'pass' : 'fail',
        detail: credStructure.ok
          ? `credential structure verified (${credential.spec}; cloud-signed; signature trusted via cloud-trust list)`
          : `credential structural integrity failed: ${credStructure.reason}`,
      });
    } else if (!secret) {
      checks.push({
        name: 'Provenance credential',
        status: 'warn',
        detail: `credential present (${credential.spec || 'unknown spec'}); signature unverified without RECIPE_RECEIPT_SECRET`,
      });
    } else {
      const r = verifyCredential(credential, secret);
      checks.push({
        name: 'Provenance credential',
        status: r.valid ? 'pass' : 'fail',
        detail: r.valid
          ? `credential signature verified (${credential.spec})`
          : `credential signature failed: ${r.reason}`,
      });
    }
  }

  // 6. Eval coverage — at least one case ran. When every case is
  // auto-synthesized from the task description (no user-provided examples),
  // downgrade to warn so the buyer knows the gate cleared on synthetic eval
  // input. One real user-provided case is enough to flip the status to pass.
  const evals = bundle.evals;
  const cases = evals?.cases || [];
  const n = cases.length;
  const autoN = cases.filter(c => c && c.auto_synthesized).length;
  if (n === 0) {
    checks.push({
      name: 'Eval coverage',
      status: 'warn',
      detail: 'artifact ships zero eval cases — K-score reflects training pass-rate only',
    });
  } else if (autoN === n) {
    checks.push({
      name: 'Eval coverage',
      status: 'warn',
      detail: `${n} eval case${n === 1 ? '' : 's'} shipped (all auto-synthesized from task description; add real cases via kolm new --from <template>)`,
    });
  } else {
    checks.push({
      name: 'Eval coverage',
      status: 'pass',
      detail: `${n} eval case${n === 1 ? '' : 's'} embedded${autoN > 0 ? ` (${autoN} auto-synthesized, ${n - autoN} user-provided)` : ''}; judge_id=${manifest.judge_id || 'unknown'}`,
    });
  }

  return { checks, credential };
}

// ---------------------------------------------------------------------------
// HTML rendering. Single-file print-friendly layout.
// ---------------------------------------------------------------------------

function renderHead(bundle) {
  const m = bundle.manifest;
  const title = `${esc(m.task || 'kolm artifact')} — compliance binder`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  @page { size: letter; margin: 0.6in 0.7in; }
  * { box-sizing: border-box; }
  body {
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a; background: #fff; margin: 0; padding: 32px;
    max-width: 880px; margin-inline: auto;
  }
  h1, h2, h3 { color: #020617; margin: 0 0 8px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-top: 28px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  h3 { font-size: 13px; font-weight: 600; margin-top: 14px; margin-bottom: 6px; }
  p { margin: 6px 0; color: #334155; }
  .subhead { color: #64748b; font-size: 12px; margin-bottom: 22px; }
  .grid { display: grid; grid-template-columns: 160px 1fr; gap: 4px 16px; margin: 8px 0; }
  .grid dt { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; padding-top: 2px; }
  .grid dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #0f172a; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px; vertical-align: top; }
  th { color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; background: #f8fafc; }
  td code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .status.pass { background: #dcfce7; color: #14532d; }
  .status.fail { background: #fee2e2; color: #7f1d1d; }
  .status.warn { background: #fef3c7; color: #78350f; }
  .check-row { display: grid; grid-template-columns: 90px 1fr; gap: 14px; align-items: start; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
  .check-name { font-weight: 600; }
  .check-detail { color: #475569; font-size: 12px; }
  .summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px 20px; margin: 16px 0 24px; }
  .summary .verdict { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .verdict.pass { color: #14532d; }
  .verdict.fail { color: #7f1d1d; }
  .verdict.warn { color: #78350f; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 11px; }
  .kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; background: #f1f5f9; padding: 2px 6px; border-radius: 3px; }
  pre { background: #0f172a; color: #f8fafc; padding: 12px 14px; border-radius: 4px; font-size: 11px; overflow-x: auto; margin: 8px 0; }
  pre code { color: inherit; font-family: inherit; }
  .axis-row { display: grid; grid-template-columns: 110px 70px 90px 1fr; gap: 12px; align-items: center; padding: 4px 0; font-size: 12px; }
  .axis-name { color: #64748b; }
  .axis-value { font-family: ui-monospace, monospace; font-weight: 600; }
  .axis-bar { background: #e2e8f0; height: 8px; border-radius: 4px; position: relative; overflow: hidden; }
  .axis-bar > i { display: block; height: 100%; background: #0f172a; }
  .step { padding: 8px 0; border-bottom: 1px dotted #e2e8f0; }
  .step:last-child { border-bottom: none; }
  .step-label { font-weight: 600; font-size: 12px; }
  .step-meta { color: #64748b; font-size: 11px; margin-top: 2px; }
  @media print {
    body { padding: 0; }
    h2 { page-break-after: avoid; }
    .summary, table, .step, .axis-row { page-break-inside: avoid; }
  }
</style>
</head>`;
}

function renderSummary(checks, manifest) {
  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const verdict = failed > 0 ? 'fail' : (warned > 0 ? 'warn' : 'pass');
  const verdictText = failed > 0
    ? `${failed} check${failed === 1 ? '' : 's'} failed — do not deploy`
    : warned > 0
      ? `passes with ${warned} warning${warned === 1 ? '' : 's'} — review below`
      : `all ${checks.length} checks passed`;
  const rows = checks.map(c => `
    <div class="check-row">
      <div><span class="status ${c.status}">${c.status}</span></div>
      <div>
        <div class="check-name">${esc(c.name)}</div>
        <div class="check-detail">${esc(c.detail)}</div>
      </div>
    </div>`).join('');
  return `
<section class="summary">
  <div class="verdict ${verdict}">${esc(verdictText)}</div>
  <p style="margin: 4px 0 0; color: #64748b;">artifact ${esc(shortCid(manifest.cid || ''))} · base ${esc(manifest.base_model || 'unknown')} · ${esc(manifest.created_at || '')}</p>
</section>
<section>
  <h2>Verification summary</h2>
  ${rows}
</section>`;
}

function renderIdentity(manifest) {
  const k = manifest.k_score || {};
  return `
<section>
  <h2>Identity</h2>
  <dl class="grid">
    <dt>Task</dt><dd>${esc(manifest.task || '—')}</dd>
    <dt>Spec</dt><dd>${esc(manifest.spec || '—')}</dd>
    <dt>Tier</dt><dd>${esc(manifest.tier || 'recipe')}</dd>
    <dt>Base model</dt><dd>${esc(manifest.base_model || '—')}</dd>
    <dt>Runtime</dt><dd>${esc(manifest.runtime || '—')}</dd>
    <dt>Job ID</dt><dd>${esc(manifest.job_id || '—')}</dd>
    <dt>CID</dt><dd>${esc(manifest.cid || '—')}</dd>
    <dt>Created at</dt><dd>${esc(manifest.created_at || '—')}</dd>
    <dt>Target device</dt><dd>${esc(manifest.target_device || 'unpinned')}</dd>
    <dt>Train device</dt><dd>${esc(manifest.train_device || 'unpinned')}</dd>
    <dt>Judge</dt><dd>${esc(manifest.judge_id || '—')}</dd>
    <dt>Size on disk</dt><dd>${fmtBytes(k.size_bytes)}</dd>
  </dl>
</section>`;
}

function renderKScore(manifest) {
  const k = manifest.k_score;
  if (!k) return `<section><h2>K-score</h2><p>No K-score embedded in this artifact.</p></section>`;
  const axes = [
    { name: 'Accuracy',  weight: 0.40, norm: k.accuracy,      raw: k.accuracy.toFixed(4) },
    { name: 'Size',      weight: 0.15, norm: k.size_score,    raw: fmtBytes(k.size_bytes) },
    { name: 'Latency',   weight: 0.15, norm: k.latency_score, raw: fmtMicros(k.p50_latency_us) },
    { name: 'Cost',      weight: 0.15, norm: k.cost_score,    raw: fmtCost(k.cost_usd_per_call) + ' / call' },
    { name: 'Coverage',  weight: 0.15, norm: k.coverage,      raw: k.coverage.toFixed(4) },
  ];
  const rows = axes.map(a => `
    <div class="axis-row">
      <div class="axis-name">${esc(a.name)} (${(a.weight * 100).toFixed(0)}%)</div>
      <div class="axis-value">${a.norm.toFixed(4)}</div>
      <div class="axis-bar"><i style="width: ${(a.norm * 100).toFixed(1)}%"></i></div>
      <div class="mono" style="color: #64748b">${esc(a.raw)}</div>
    </div>`).join('');
  const gate = k.gate || 0.85;
  const verdictText = k.composite >= gate
    ? `composite ${k.composite.toFixed(4)} ≥ gate ${gate.toFixed(2)} — artifact ships`
    : `composite ${k.composite.toFixed(4)} below gate ${gate.toFixed(2)} — artifact should not ship`;
  return `
<section>
  <h2>K-score evidence</h2>
  <p>K = 0.40·A + 0.15·S + 0.15·L + 0.15·C + 0.15·V, on the unit interval. The gate is ${gate.toFixed(2)}.</p>
  ${rows}
  <p style="margin-top: 12px;"><span class="status ${k.composite >= gate ? 'pass' : 'fail'}">${k.composite >= gate ? 'pass' : 'fail'}</span> &nbsp; ${esc(verdictText)}</p>
</section>`;
}

function renderHashes(manifest) {
  const h = manifest.hashes || {};
  const rows = Object.keys(h).sort().map(k => `
    <tr>
      <td class="mono">${esc(k)}</td>
      <td class="mono">${esc(h[k])}</td>
    </tr>`).join('');
  return `
<section>
  <h2>Manifest hashes</h2>
  <p>sha256 over each file inside the .kolm zip. The CID is derived from this table via canonical JSON.</p>
  <table>
    <thead><tr><th style="width: 180px">File</th><th>sha256</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderChain(receipt) {
  if (!receipt || !receipt.chain) {
    return `<section><h2>Audit chain</h2><p>No receipt.json found.</p></section>`;
  }
  const rows = receipt.chain.map((step, i) => `
    <div class="step">
      <div class="step-label">${i + 1}. ${esc(step.step)}</div>
      <div class="step-meta">in &nbsp;<span class="mono">${esc(step.input_hash)}</span></div>
      <div class="step-meta">out <span class="mono">${esc(step.output_hash)}</span></div>
      <div class="step-meta">hmac <span class="mono">${esc(step.hmac)}</span></div>
    </div>`).join('');
  return `
<section>
  <h2>Audit chain</h2>
  <p>Five-step HMAC chain. Each step seals the previous step's output hash. A verifier with the receipt secret recomputes every step's HMAC to detect tampering.</p>
  ${rows}
  <p style="margin-top: 12px;"><strong>Receipt body signature:</strong> <code class="mono">${esc(receipt.signature || '—')}</code></p>
  <p><strong>Signature algorithm:</strong> ${esc(receipt.signature_alg || '—')} &nbsp; <strong>Signed at:</strong> ${esc(receipt.signed_at || '—')} &nbsp; <strong>Signed by:</strong> ${esc(receipt.signed_by || '—')}</p>
</section>`;
}

function renderCredential(credential) {
  if (!credential) {
    return `<section><h2>Provenance credential</h2><p>Not present — artifact predates kolm-credential/0.1.</p></section>`;
  }
  const a = credential.assertions || {};
  const rows = Object.keys(a).sort().map(k => `
    <tr><td class="mono">${esc(k)}</td><td class="mono">${esc(String(a[k] ?? '—'))}</td></tr>
  `).join('');
  return `
<section>
  <h2>Provenance credential</h2>
  <p>Self-contained credential binding the artifact to its assertions. Schema: <code>${esc(credential.spec || '—')}</code>. Verifies under the same secret as the receipt chain.</p>
  <dl class="grid">
    <dt>Type</dt><dd>${esc(credential.type || '—')}</dd>
    <dt>Claim generator</dt><dd>${esc(credential.claim_generator || '—')}</dd>
    <dt>Artifact hash</dt><dd>${esc(credential.artifact_hash || '—')}</dd>
    <dt>CID</dt><dd>${esc(credential.cid || '—')}</dd>
    <dt>Signature alg</dt><dd>${esc(credential.signature_alg || '—')}</dd>
    <dt>Signed at</dt><dd>${esc(credential.signed_at || '—')}</dd>
    <dt>Signature</dt><dd>${esc(credential.signature || '—')}</dd>
  </dl>
  <h3>Assertions</h3>
  <table>
    <thead><tr><th style="width: 220px">Key</th><th>Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderEvals(evals, manifest) {
  if (!evals || !evals.cases || !evals.cases.length) {
    return `<section><h2>Eval coverage</h2><p>No eval cases embedded.</p></section>`;
  }
  const sample = evals.cases.slice(0, 5);
  const rows = sample.map((c, i) => {
    const input = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    const expected = typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected);
    return `
    <tr>
      <td>${i + 1}</td>
      <td class="mono">${esc(input.slice(0, 120))}${input.length > 120 ? '…' : ''}</td>
      <td class="mono">${esc(expected.slice(0, 120))}${expected.length > 120 ? '…' : ''}</td>
    </tr>`;
  }).join('');
  return `
<section>
  <h2>Eval coverage</h2>
  <p><strong>${evals.cases.length}</strong> case${evals.cases.length === 1 ? '' : 's'} embedded. Judge: <code>${esc(manifest.judge_id || '—')}</code>. Eval set hash: <code class="mono">${esc(manifest.evals?.hash || '—')}</code>.</p>
  <table>
    <thead><tr><th style="width: 30px">#</th><th>Input</th><th>Expected</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${evals.cases.length > 5 ? `<p style="color: #64748b;">Showing first 5 of ${evals.cases.length}.</p>` : ''}
</section>`;
}

function renderReproduction(artifactPath, manifest) {
  const name = path.basename(artifactPath);
  return `
<section>
  <h2>Reproduce this binder</h2>
  <p>Any reviewer with the artifact bytes can regenerate this report. The K-score, hashes, CID, and chain structure are deterministic; the HMAC verification rows turn green when the same receipt secret is present in the environment.</p>
  <pre><code># 1. Verify the artifact bytes match the embedded CID
kolm inspect ${esc(name)} | grep cid

# 2. Recompute K-score from the artifact bytes
kolm score ${esc(name)}

# 3. Re-run the embedded eval set and check pass-rate
kolm eval ${esc(name)}

# 4. Regenerate this binder
kolm verify ${esc(name)} --binder out.html</code></pre>
</section>`;
}

function renderFooter(artifactPath) {
  const now = new Date().toISOString();
  return `
<div class="footer">
  <p>Generated ${esc(now)} from ${esc(path.basename(artifactPath))} · binder spec <code>${esc(BINDER_SPEC)}</code></p>
  <p>This binder is offline-verifiable: every claim it makes is derived from the .kolm bytes plus (for signature verification) the receipt secret held by the issuer. See <a href="https://kolm.ai/spec">kolm.ai/spec</a> for the full schema.</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * Build the binder HTML for an artifact at `artifactPath`. Returns
 * `{ html, checks, verdict, manifest, receipt }`. Throws if the artifact is
 * malformed or fails signature verification.
 */
export async function buildBinder(artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`binder: artifact not found: ${artifactPath}`);
  }
  const bundle = loadArtifact(artifactPath);
  const { checks, credential } = await verifyArtifact(bundle);

  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const verdict = failed > 0 ? 'fail' : (warned > 0 ? 'warn' : 'pass');

  const html = [
    renderHead(bundle),
    `<body>`,
    `<h1>${esc(bundle.manifest.task || 'kolm artifact')}</h1>`,
    `<p class="subhead">Compliance binder · ${esc(BINDER_SPEC)} · ${esc(path.basename(artifactPath))}</p>`,
    renderSummary(checks, bundle.manifest),
    renderIdentity(bundle.manifest),
    renderKScore(bundle.manifest),
    renderHashes(bundle.manifest),
    renderChain(bundle.receipt),
    renderCredential(credential),
    renderEvals(bundle.evals, bundle.manifest),
    renderReproduction(artifactPath, bundle.manifest),
    renderFooter(artifactPath),
    `</body></html>`,
  ].join('\n');

  return {
    html,
    checks,
    verdict,
    manifest: bundle.manifest,
    receipt: bundle.receipt,
    credential,
  };
}

/**
 * Write the binder to `outPath` and return the same shape as buildBinder.
 */
export async function writeBinder(artifactPath, outPath) {
  const result = await buildBinder(artifactPath);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, result.html, 'utf8');
  return { ...result, out_path: outPath, bytes: Buffer.byteLength(result.html, 'utf8') };
}

export const BINDER = { spec: BINDER_SPEC };
