// W263 — kolm.ai marketplace catalog.
//
// Single source of truth for the public marketplace surface at /marketplace.
// Every artifact entry MUST point to a real .kolm file on disk under
// public/registry-pack/ or examples/. K-scores and sha256 hashes are read
// from the existing public/registry-pack/manifest.json so the marketplace
// listing and the registry-pack stay in lockstep. If a backing file is
// missing at process startup, the entry is dropped from the catalog and
// `verified: false` is recorded so the UI cannot show a green badge for an
// artifact whose bytes are gone.
//
// The catalog manifest's `signature` field is a deterministic sha256 of the
// canonical JSON (sorted keys, signature/signed_at/signature_algo stripped
// before hashing). This is an anchor, not an ed25519 signature; the
// signature_algo string is "sha256-anchor" so a future wave can swap it for
// real ed25519 without breaking callers. Verifiers should recompute the
// canonical hash and compare.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { productionReady, productionReadySync } from './production-ready.js';

// adm-zip is CommonJS; pull it through createRequire so hydrate() can stay
// synchronous (W342 callers — getCatalogManifest, listArtifacts, getArtifact —
// are all sync and feed the marketplace UI/CLI in a tight loop).
const __require = createRequire(import.meta.url);
let __AdmZip = null;
function loadAdmZip() {
  if (__AdmZip !== null) return __AdmZip;
  try { __AdmZip = __require('adm-zip'); } catch { __AdmZip = false; }
  return __AdmZip;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Roots we will look in for backing .kolm files. First hit wins.
const ARTIFACT_ROOTS = [
  path.join(ROOT, 'examples'),
  path.join(ROOT, 'public', 'registry-pack'),
];

// Categories the UI surfaces as filter chips. Each artifact picks one.
export const MARKETPLACE_CATEGORIES = Object.freeze([
  'compliance',
  'data extraction',
  'classification',
  'dev tooling',
  'edge',
]);

// Compliance badges that may appear on a card. Only set on entries where
// the underlying artifact actually supports the claim (PHI redactor =>
// HIPAA + BAA; legal extractor => GDPR-friendly only because it processes
// no PII by design; everything else gets Permissive). "Verified" is a
// separate axis tracked by `verified: true` on the artifact entry and is
// rendered as its own pill.
export const MARKETPLACE_BADGES = Object.freeze([
  'HIPAA',
  'GDPR',
  'BAA',
  'Permissive',
  'Verified',
]);

// SEED CATALOG — every slug here MUST resolve to a real file on disk via
// ARTIFACT_ROOTS. The five entries below back the five .kolm files in
// public/registry-pack/ (built by scripts/build-registry-pack.js, sha256
// recorded in public/registry-pack/manifest.json). The sixth slot is the
// Predibase-style customer-support intent classifier under
// examples/predibase-style-customer-support/.
//
// The brief originally listed candidate slugs (msa-clause-extractor,
// pr-review-bot, sql-safety-classifier) but the strict constraint is "no
// fake artifacts". The canonical names below are the ones whose bytes
// actually exist; the per-slug detail pages document the real recipe.
const SEED_CATALOG = [
  {
    slug: 'phi-redactor',
    name: 'PHI Redactor',
    description: 'PHI redaction for HIPAA Safe Harbor. Strips SSN, MRN, DOB, NPI, phone, email, dates from clinical notes.',
    category: 'compliance',
    license: 'Apache-2.0',
    badges: ['HIPAA', 'BAA', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'phi-redactor.kolm'),
    download_url: '/registry-pack/phi-redactor.kolm',
    vertical: 'healthcare',
    tags: ['redaction', 'healthcare', 'phi', 'hipaa'],
  },
  {
    slug: 'invoice-parser',
    name: 'Invoice Parser',
    description: 'Extracts invoice_number, iso_date, amount, currency from AR/AP text.',
    category: 'data extraction',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'invoice-parser.kolm'),
    download_url: '/registry-pack/invoice-parser.kolm',
    vertical: 'finance',
    tags: ['extraction', 'finance', 'invoice', 'billing'],
  },
  {
    slug: 'legal-clause-extractor',
    name: 'Legal Clause Extractor',
    description: 'Pulls governing_law, parties, term_months, effective_date from NDA-style master service agreements.',
    category: 'data extraction',
    license: 'Apache-2.0',
    badges: ['GDPR', 'Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'legal-clause-extractor.kolm'),
    download_url: '/registry-pack/legal-clause-extractor.kolm',
    vertical: 'legal',
    tags: ['extraction', 'legal', 'nda', 'contracts'],
  },
  {
    slug: 'code-issue-classifier',
    name: 'Code Issue Classifier',
    description: 'Routes code-review comments into security, performance, style, test, docs, or refactor.',
    category: 'dev tooling',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'code-issue-classifier.kolm'),
    download_url: '/registry-pack/code-issue-classifier.kolm',
    vertical: 'code',
    tags: ['classification', 'code', 'review', 'devtools'],
  },
  {
    slug: 'multilingual-greeter',
    name: 'Multilingual Greeter',
    description: 'Detects english, spanish, french, german, portuguese, italian, dutch in short greetings. Sized for edge devices.',
    category: 'classification',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'multilingual-greeter.kolm'),
    download_url: '/registry-pack/multilingual-greeter.kolm',
    vertical: 'edge',
    tags: ['classification', 'edge', 'i18n', 'language'],
  },
  {
    slug: 'cs-intent-classifier',
    name: 'Customer Support Intent Classifier',
    description: 'Routes a support message into one of 10 intents (refund, cancel, billing, shipping, password_reset, account_lock, complaint, feedback, escalate, other).',
    category: 'classification',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('examples', 'predibase-style-customer-support', 'cs-intent.kolm'),
    download_url: '/v1/marketplace/cs-intent-classifier/download',
    vertical: 'support',
    tags: ['classification', 'support', 'intent', 'predibase-style'],
  },
  // W343 — claims-redactor: HIPAA Safe Harbor PHI redactor backed by
  // examples/claims-redactor/recipe.js (single-source mirror of
  // src/phi-redactor.js DETECTORS). 60 real seed rows, K-score ~0.985,
  // productionReady() true.
  {
    slug: 'claims-redactor',
    name: 'Claims Redactor (HIPAA Safe Harbor)',
    description: 'HIPAA Safe Harbor PHI redactor for healthcare claims and clinical narratives. Strips all 18 Safe Harbor identifiers plus NPI/DEA/Medicaid IDs; mints stable [PHI_<CLASS>_<INDEX>] tokens so the original can be re-injected after a teacher-API round trip. Single source of truth: examples/claims-redactor/recipe.js mirrors src/phi-redactor.js.',
    category: 'compliance',
    license: 'Apache-2.0',
    badges: ['HIPAA', 'BAA', 'Verified'],
    source_path: path.join('examples', 'claims-redactor', 'claims-redactor.kolm'),
    download_url: '/v1/marketplace/claims-redactor/download',
    vertical: 'healthcare',
    tags: ['redaction', 'healthcare', 'phi', 'hipaa', 'safe-harbor', 'claims'],
  },
  // W475 — qwen-distill-classifier: first model-class seed (artifact_class
  // distilled_model, base=Qwen/Qwen2.5-0.5B-Instruct). Bundled model_weights
  // bytes + real_eval seed provenance + production_ready=true. Recipe is a
  // TF-IDF intent classifier so the artifact runs cleanly in JS today;
  // full Qwen GGUF inference engages when users pull the GGUF.
  // Built by scripts/build-distilled-model-seed.mjs.
  {
    slug: 'qwen-distill-classifier',
    name: 'Qwen-Distilled CS Intent Classifier',
    description: 'Distilled-model artifact (artifact_class=distilled_model, base=Qwen/Qwen2.5-0.5B-Instruct) for customer-support intent routing. Production-ready: 60 real seeds, 48 train / 12 holdout, real_eval grounded K-score 0.9797. Routes a support message into one of 10 intents (refund, cancel, billing, shipping, password_reset, account_lock, complaint, feedback, escalate, other).',
    category: 'classification',
    license: 'Apache-2.0',
    badges: ['Permissive', 'Verified'],
    source_path: path.join('public', 'registry-pack', 'qwen-distill-classifier.kolm'),
    download_url: '/registry-pack/qwen-distill-classifier.kolm',
    vertical: 'support',
    tags: ['distilled', 'classification', 'support', 'intent', 'qwen', 'model'],
  },
];

// Manifest from public/registry-pack/ — populated at startup. Used to pull
// real K-scores. If the file is missing or malformed we keep `null` so the
// UI shows "unverified" rather than a fake number.
let REGISTRY_PACK_MANIFEST = null;
function loadRegistryPackManifest() {
  if (REGISTRY_PACK_MANIFEST !== null) return REGISTRY_PACK_MANIFEST;
  try {
    const p = path.join(ROOT, 'public', 'registry-pack', 'manifest.json');
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      REGISTRY_PACK_MANIFEST = JSON.parse(raw);
    } else {
      REGISTRY_PACK_MANIFEST = { artifacts: [] };
    }
  } catch (_e) {
    REGISTRY_PACK_MANIFEST = { artifacts: [] };
  }
  return REGISTRY_PACK_MANIFEST;
}

function findRegistryPackEntry(slug) {
  const mani = loadRegistryPackManifest();
  if (!mani || !Array.isArray(mani.artifacts)) return null;
  // Match against the registry-pack `name` field (one of the 5 known names).
  return mani.artifacts.find((a) => a && a.name === slug) || null;
}

function resolveAbsolute(rel) {
  return path.join(ROOT, rel);
}

function fileExists(rel) {
  try { return fs.statSync(resolveAbsolute(rel)).isFile(); } catch (_e) { return false; }
}

function sha256File(rel) {
  try {
    const buf = fs.readFileSync(resolveAbsolute(rel));
    return {
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    };
  } catch (_e) { return null; }
}

// Hydrate a seed entry with on-disk facts. Returns an artifact record with
// fully resolved sha256/bytes/k_score/verified or `null` if the backing
// file is missing.
function hydrate(seed) {
  if (!fileExists(seed.source_path)) {
    // Drop the entry rather than ship a slug that 404s. Strict constraint
    // from the wave brief: "If a file isn't present yet, skip that entry."
    return null;
  }
  const hash = sha256File(seed.source_path);
  if (!hash) return null;
  const regEntry = findRegistryPackEntry(seed.slug);
  // K-score: prefer the registry-pack value (real, measured). If absent,
  // try a bench-report.json sibling. Else null + verified:false.
  let k_score = null;
  let k_score_source = null;
  if (regEntry && typeof regEntry.k_score === 'number') {
    k_score = regEntry.k_score;
    k_score_source = 'registry-pack-manifest';
  } else {
    // Try a sibling bench-report.json next to the artifact (cs-intent path).
    const siblingBench = path.join(path.dirname(seed.source_path), 'bench-report.json');
    if (fileExists(siblingBench)) {
      try {
        const br = JSON.parse(fs.readFileSync(resolveAbsolute(siblingBench), 'utf8'));
        // Bench report shape: paths['kolm-js'].correctness.accuracy
        const acc = br?.paths?.['kolm-js']?.correctness?.accuracy
                 ?? br?.paths?.['kolm-js']?.accuracy;
        if (typeof acc === 'number' && acc > 0) {
          k_score = acc;
          k_score_source = 'bench-report.json';
        }
      } catch (_e) { /* leave null */ }
    }
  }
  const badges = Array.isArray(seed.badges) ? [...seed.badges] : [];
  // W339/W342 unification: `verified` is the unified productionReady() verdict,
  // not a derivation of `k_score != null && badges.includes('Verified')`.
  // Read the manifest synchronously via adm-zip (already a root dep) and feed
  // it through productionReadySync(). If the .kolm has no manifest or fails to
  // parse, treat as unverified — same outcome as a failed gate.
  let verdict = { ok: false, gates: {}, reasons: ['manifest_unreadable'] };
  const AdmZip = loadAdmZip();
  if (!AdmZip) {
    verdict = { ok: false, gates: {}, reasons: ['adm-zip_unavailable'] };
  } else {
    try {
      const zip = new AdmZip(resolveAbsolute(seed.source_path));
      const entry = zip.getEntry('manifest.json');
      if (entry) {
        const manifest = JSON.parse(entry.getData().toString('utf8'));
        verdict = productionReadySync(manifest);
      } else {
        verdict = { ok: false, gates: {}, reasons: ['manifest_missing'] };
      }
    } catch (e) {
      verdict = { ok: false, gates: {}, reasons: [`verdict_failed: ${e.message}`] };
    }
  }
  // W428 P0 audit lock-in: the value derived from productionReadySync() above
  // is PROVISIONAL — the durability, executable_bundle, and eval_parity gates
  // were skipped (productionReadySync() tags its envelope with
  // `_provisional: true`). Exposing it as a public `verified: true` lets a
  // direct module consumer (CLI, third-party, future route) treat the sync
  // result as ground truth and reintroduce the verified-badge regression that
  // W342/W411 closed. We therefore expose the sync result as the EXPLICIT
  // `verified_provisional` field and keep public `verified` false here; the
  // server's __hydrateVerified() and the CLI's localList() overlay the LIVE
  // async productionReady() verdict before the row leaves the trust boundary.
  const verified_provisional = verdict.ok === true;
  const verified = false;
  // W380d k_score fallback: when neither registry-pack nor bench-report.json
  // surfaced a k_score, fall back to the gates.k_score.value computed by
  // productionReadySync() above. This is the same number the verified pill
  // uses, so the marketplace card stays internally consistent.
  if (k_score == null && typeof verdict?.gates?.k_score?.value === 'number') {
    k_score = verdict.gates.k_score.value;
    k_score_source = 'production-ready-gate';
  }
  // Honest badges: never paint Verified at the sync layer. The router /
  // CLI overlay re-adds it from the LIVE async productionReady() verdict so a
  // direct listArtifacts() consumer cannot read a `Verified` pill that was
  // never gated by the bundle + eval_parity + durability checks.
  const finalBadges = badges.filter((b) => b !== 'Verified');
  // W409x — full metadata block for the listing. Sourced from the on-disk
  // manifest where possible (license/runtime/policy/lineage) and from the
  // seed catalog where the manifest stays silent (privacy_class/device_compat).
  // The block is stable across the seed entry and the on-disk manifest so a
  // round-trip publish->list->install->install-time-recheck preserves every
  // field a buyer needs to make an install decision.
  let manifestForMeta = null;
  try {
    const AdmZip2 = loadAdmZip();
    if (AdmZip2) {
      const zip = new AdmZip2(resolveAbsolute(seed.source_path));
      const entry = zip.getEntry('manifest.json');
      if (entry) manifestForMeta = JSON.parse(entry.getData().toString('utf8'));
    }
  } catch (_e) { /* metadata best-effort; missing manifest => null metadata */ }
  const metadata = buildArtifactMetadata({
    seed, manifest: manifestForMeta, verdict, sha256: hash.sha256, bytes: hash.bytes,
  });
  return {
    slug: seed.slug,
    name: seed.name,
    description: seed.description,
    category: seed.category,
    license: seed.license,
    badges: finalBadges,
    verified,
    verified_provisional,
    gates: verdict.gates || {},
    gate_reasons: verdict.reasons || [],
    sha256: hash.sha256,
    bytes: hash.bytes,
    k_score,
    k_score_source,
    vertical: seed.vertical,
    tags: seed.tags,
    source_path: seed.source_path,
    download_url: seed.download_url,
    detail_url: `/marketplace/${seed.slug}`,
    // W409x — metadata block (author, license, runtime_target, schemas,
    // privacy_class, production_readiness_state, verified_receipt_hash,
    // device_compatibility). Listed here AND mirrored as flat fields below so
    // a `?filter=...&` API endpoint can filter without un-nesting.
    author: metadata.author,
    runtime_target: metadata.runtime_target,
    input_schema: metadata.input_schema,
    output_schema: metadata.output_schema,
    privacy_class: metadata.privacy_class,
    production_readiness_state: metadata.production_readiness_state,
    verified_receipt_hash: metadata.verified_receipt_hash,
    device_compatibility: metadata.device_compatibility,
    metadata,
  };
}

// =====================================================================
// W409x — metadata builder + production-gate install helpers.
//
// PUBLIC SHAPE (each field MUST round-trip through the manifest -> listing ->
// install path):
//   author                       — anonymized hash (sha256 of an `author_email`
//                                   or `submitter` field) OR a display string
//   license                      — license id pulled from manifest.license.id
//                                   (fallback: seed.license)
//   runtime_target               — manifest.runtime || fallback "cloud"
//   input_schema, output_schema  — JSON schema fragments OR a string description
//                                   (compile-time recipe block may set these;
//                                   default null if the artifact doesn't declare)
//   privacy_class                — public-data-only | redacted-pii |
//                                   raw-pii-internal-only
//                                   (mapped from manifest.policy + tags)
//   production_readiness_state   — production_ready_verified |
//                                   source_generated | foundation
//                                   (production_ready_verified iff the unified
//                                   productionReady gate ok; source_generated
//                                   if the artifact ships a recipe.bundle.mjs
//                                   but has no seed_provenance; foundation
//                                   otherwise)
//   verified_receipt_hash        — manifest.signature.signature_ed25519 base64
//                                   (or the receipt.signature_ed25519 carried
//                                   in the receipt.json block; either way it
//                                   is the Ed25519 receipt hash)
//   device_compatibility         — list of profile_class strings
//                                   (manifest.compiled_targets[*].profile_class
//                                   when present; falls back to ["cloud"])
// =====================================================================

export const PRIVACY_CLASSES = Object.freeze([
  'public-data-only',
  'redacted-pii',
  'raw-pii-internal-only',
]);

export const PRODUCTION_READINESS_STATES = Object.freeze([
  'production_ready_verified',
  'source_generated',
  'foundation',
]);

function _anonAuthor(manifest, seed) {
  // Prefer an explicit display name from the seed; fall back to a stable hash
  // of the submitter/email if the manifest carries one; final fallback is a
  // generic "anonymous" string so the field is never null.
  if (seed && typeof seed.author === 'string' && seed.author.length > 0) return seed.author;
  const candidate = (manifest && (manifest.author || manifest.submitter || manifest.signed_by)) || null;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return 'anon-' + crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 16);
  }
  return 'anonymous';
}

function _resolvePrivacyClass(manifest, seed) {
  // Explicit declaration in the manifest wins. Otherwise we infer:
  //   - PHI/HIPAA tags ⇒ redacted-pii
  //   - synthetic/public-only tags ⇒ public-data-only
  //   - default ⇒ public-data-only (least-sensitive honest default)
  const declared = manifest && manifest.privacy_class;
  if (typeof declared === 'string' && PRIVACY_CLASSES.includes(declared)) return declared;
  const seedDeclared = seed && seed.privacy_class;
  if (typeof seedDeclared === 'string' && PRIVACY_CLASSES.includes(seedDeclared)) return seedDeclared;
  const tags = (seed && seed.tags) || [];
  if (tags.some((t) => /phi|hipaa|pii|claims|redact/i.test(t))) return 'redacted-pii';
  return 'public-data-only';
}

function _resolveProductionReadinessState(verdict, manifest) {
  // W428 — only the LIVE async productionReady() verdict may flip the state
  // to 'production_ready_verified'. The sync verdict from productionReadySync()
  // carries `_provisional: true`; treating it as fully verified here would let
  // a direct listArtifacts() consumer claim production-readiness without the
  // executable_bundle + eval_parity + durability gates ever running. The
  // router/CLI overlay re-promotes from the async verdict after hydrate().
  if (verdict && verdict.ok === true && verdict._provisional !== true) {
    return 'production_ready_verified';
  }
  const sp = manifest && manifest.seed_provenance;
  // No seed_provenance but the artifact ships a recipe bundle ⇒ source_generated
  // (the source artifact exists but the production gate has not been crossed).
  if (manifest && manifest.entry && typeof manifest.entry.file === 'string') {
    return 'source_generated';
  }
  if (sp && typeof sp.seeds_hash === 'string') return 'source_generated';
  return 'foundation';
}

function _resolveDeviceCompatibility(manifest, seed) {
  // compiled_targets is the manifest field that enumerates device profiles
  // the artifact was successfully cross-compiled for. Fall back to the seed
  // override or a generic ["cloud"] when nothing is declared.
  const ct = manifest && Array.isArray(manifest.compiled_targets) ? manifest.compiled_targets : null;
  if (ct && ct.length > 0) {
    const classes = ct
      .map((t) => (t && (t.profile_class || t.target || t.device)) || null)
      .filter((v) => typeof v === 'string' && v.length > 0);
    if (classes.length > 0) return Array.from(new Set(classes));
  }
  if (seed && Array.isArray(seed.device_compatibility) && seed.device_compatibility.length > 0) {
    return seed.device_compatibility.slice();
  }
  const runtime = (manifest && typeof manifest.runtime === 'string' && manifest.runtime) || 'cloud';
  return [runtime];
}

function _resolveSchemas(manifest, seed) {
  // Compile-time recipe blocks MAY set input_schema/output_schema; surface them
  // verbatim. Fall back to a one-line string description so the field is never
  // null (auditors and the listing UI both prefer a humanized hint over nothing).
  const fromManifest = manifest && manifest.io_schema ? manifest.io_schema : null;
  const inputSchema = (fromManifest && fromManifest.input)
    || (seed && seed.input_schema)
    || (manifest && manifest.task ? `string input (free-text). recipe task: ${String(manifest.task).slice(0, 200)}` : 'string input (free-text)');
  const outputSchema = (fromManifest && fromManifest.output)
    || (seed && seed.output_schema)
    || (manifest && manifest.export ? manifest.export : 'string output (model-defined)');
  return { input_schema: inputSchema, output_schema: outputSchema };
}

function _resolveReceiptHash(manifest) {
  // Prefer the Ed25519 signature carried in the manifest's signature block
  // (signature.signature_ed25519). Fall back to the receipt-level field where
  // applicable. Both are 88-char base64-encoded blobs for a 64-byte ed25519
  // signature; either is a stable identity for the receipt.
  const sigBlock = manifest && manifest.signature;
  if (sigBlock && typeof sigBlock.signature_ed25519 === 'string' && sigBlock.signature_ed25519.length > 0) {
    return sigBlock.signature_ed25519;
  }
  if (manifest && typeof manifest.receipt_signature_ed25519 === 'string') {
    return manifest.receipt_signature_ed25519;
  }
  // The receipt's artifact_hash is a reasonable secondary identity when no
  // signature block is present (we surface it so the listing always has a
  // non-null verified_receipt_hash field).
  if (manifest && manifest.hashes && typeof manifest.hashes.model_pointer === 'string') {
    return manifest.hashes.model_pointer;
  }
  return null;
}

export function buildArtifactMetadata({ seed, manifest, verdict, sha256, bytes }) {
  const author = _anonAuthor(manifest, seed);
  const license = (manifest && manifest.license && manifest.license.id) || (seed && seed.license) || 'unknown';
  const runtime_target = (manifest && typeof manifest.runtime === 'string' && manifest.runtime) || (seed && seed.runtime_target) || 'cloud';
  const { input_schema, output_schema } = _resolveSchemas(manifest, seed);
  const privacy_class = _resolvePrivacyClass(manifest, seed);
  const production_readiness_state = _resolveProductionReadinessState(verdict, manifest);
  const verified_receipt_hash = _resolveReceiptHash(manifest);
  const device_compatibility = _resolveDeviceCompatibility(manifest, seed);
  return {
    author,
    license,
    runtime_target,
    input_schema,
    output_schema,
    privacy_class,
    production_readiness_state,
    verified_receipt_hash,
    device_compatibility,
    sha256: sha256 || null,
    bytes: typeof bytes === 'number' ? bytes : null,
  };
}

// W409x — extract a metadata block from a downloaded artifact's manifest.
// Mirrors `buildArtifactMetadata` so an `install` caller can compute the same
// block the listing surfaced. Returns null on read failure.
export function extractManifestMetadataFromBytes(buffer, seed = null) {
  const AdmZip = loadAdmZip();
  if (!AdmZip) return null;
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry('manifest.json');
    if (!entry) return null;
    const manifest = JSON.parse(entry.getData().toString('utf8'));
    return buildArtifactMetadata({
      seed,
      manifest,
      verdict: null,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
    });
  } catch (_e) { return null; }
}

// W409x — install path. Pass downloaded bytes + the marketplace listing
// row; we re-run productionReady() against the bytes (NOT the row's claim)
// and accept or reject the install accordingly. Returns
// `{ ok, reason?, written_path?, recheck:{ ok, reasons } }`.
//
// The function deliberately writes the artifact to a temp path during the
// re-check so productionReady() can unzip via adm-zip. On accept it moves
// the temp file into `destPath`; on reject it removes the temp file and
// returns without touching destPath.
export async function installArtifactFromBytes({
  buffer,
  destPath,
  listingRow = null,
  expectedSha256 = null,
  force = false,
}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('installArtifactFromBytes: buffer must be a Buffer');
  }
  if (typeof destPath !== 'string' || !destPath) {
    throw new Error('installArtifactFromBytes: destPath required');
  }
  // sha256 honesty check first — protects against compromised mirrors.
  const got = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 && got !== expectedSha256) {
    return { ok: false, reason: 'sha256_mismatch', expected: expectedSha256, got, recheck: { ok: false, reasons: ['sha256_mismatch'] } };
  }
  const tmpDir = path.dirname(destPath);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${path.basename(destPath)}.verify-${Date.now()}-${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, buffer);
  let recheck;
  try {
    recheck = await productionReady(tmpPath);
  } catch (e) {
    recheck = { ok: false, gates: {}, reasons: [`recheck_threw: ${e.message}`] };
  }
  // The marketplace listing MAY claim production_ready_verified — we never
  // trust it. The re-check verdict is authoritative; the listing claim only
  // surfaces in the rejection reason so a buyer can see the contradiction.
  const listingClaimedReady = !!(listingRow && (
    listingRow.production_readiness_state === 'production_ready_verified'
    || listingRow.verified === true
  ));
  if (!recheck.ok && !force) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return {
      ok: false,
      reason: 'production_ready_failed',
      listing_claimed_ready: listingClaimedReady,
      sha256: got,
      bytes: buffer.length,
      recheck,
    };
  }
  // Accept — move temp -> dest and surface the (possibly forced) verdict.
  try { fs.renameSync(tmpPath, destPath); }
  catch (e) {
    // EXDEV / Windows: fallback to copy+unlink
    try { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); }
    catch (e2) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new Error(`installArtifactFromBytes: rename failed: ${e.message} / ${e2.message}`);
    }
  }
  return {
    ok: true,
    forced: !recheck.ok && force,
    sha256: got,
    bytes: buffer.length,
    written_path: destPath,
    recheck,
  };
}

// Hydrate the full catalog at module-load time. We re-hydrate on each call
// to listArtifacts/getArtifact to keep tests deterministic when fixtures
// change between cases.
function hydrateAll() {
  const out = [];
  for (const seed of SEED_CATALOG) {
    const rec = hydrate(seed);
    if (rec) out.push(rec);
  }
  return out;
}

// MARKETPLACE_ARTIFACTS is exposed as a getter so callers see the current
// on-disk view, not a snapshot from module-load time. Tests that touch the
// filesystem fixtures still see fresh data.
export const MARKETPLACE_ARTIFACTS = new Proxy([], {
  get(_target, prop) {
    const arr = hydrateAll();
    const v = arr[prop];
    return typeof v === 'function' ? v.bind(arr) : (prop in arr ? arr[prop] : Reflect.get(arr, prop));
  },
});

// listArtifacts({filter}) — return the hydrated, filtered catalog.
// Filter keys (all optional, all AND-ed together):
//   category               — exact match against artifact.category
//   license                — exact match (W409x: also matches metadata.license)
//   min_k_score            — drops artifacts whose k_score is null or below the floor
//   verified               — true => only entries with verified:true
//   badge                  — string => only entries whose badges include the value
//   q                      — free-text search across slug/name/description/tags
//   runtime_target         — (W409x) exact match against artifact.runtime_target
//   privacy_class          — (W409x) exact match against artifact.privacy_class
//   device                 — (W409x) substring match against device_compatibility
//   production_readiness_state — (W409x) exact match
export function listArtifacts({ filter = {} } = {}) {
  const all = hydrateAll();
  return all.filter((a) => {
    if (filter.category && a.category !== filter.category) return false;
    // Match either the seed-level license slug ("Apache-2.0") or the
    // metadata.license value pulled from the manifest's license block.
    if (filter.license) {
      const ok = a.license === filter.license || (a.metadata && a.metadata.license === filter.license);
      if (!ok) return false;
    }
    if (filter.min_k_score != null) {
      if (a.k_score == null) return false;
      if (a.k_score < Number(filter.min_k_score)) return false;
    }
    if (filter.verified === true && !a.verified) return false;
    if (filter.badge && !a.badges.includes(filter.badge)) return false;
    if (filter.q) {
      const q = String(filter.q).toLowerCase();
      const hay = [a.slug, a.name, a.description, ...(a.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter.runtime_target && a.runtime_target !== filter.runtime_target) return false;
    if (filter.privacy_class && a.privacy_class !== filter.privacy_class) return false;
    if (filter.device) {
      const list = Array.isArray(a.device_compatibility) ? a.device_compatibility : [];
      if (!list.includes(filter.device)) return false;
    }
    if (filter.production_readiness_state && a.production_readiness_state !== filter.production_readiness_state) return false;
    return true;
  });
}

export function getArtifact(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const all = hydrateAll();
  return all.find((a) => a.slug === slug) || null;
}

// Canonical JSON: stable key ordering for deterministic hashing. Strip the
// signature block so the hash is computed over the body the signature
// covers.
function canonicalJson(v) {
  const sortRecursive = (x) => {
    if (Array.isArray(x)) return x.map(sortRecursive);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = sortRecursive(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sortRecursive(v));
}

const CATALOG_SPEC_VERSION = 'kolm-marketplace-1';
const SIGNATURE_ALGO = 'sha256-anchor';

// getCatalogManifest() — returns the full signed catalog. Signature is a
// deterministic sha256 over the canonical JSON of the manifest body (with
// signature/signed_at/signature_algo stripped). Future wave will swap this
// for an ed25519 signature; the signature_algo field carries the swap
// breadcrumb.
export function getCatalogManifest() {
  const artifacts = hydrateAll();
  const body = {
    spec: CATALOG_SPEC_VERSION,
    version: '1.0.0',
    artifacts,
  };
  const signature = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return {
    ...body,
    signed_at: new Date(0).toISOString(), // stable timestamp for deterministic hash; callers stamp real time on the wire.
    signature_algo: SIGNATURE_ALGO,
    signature,
  };
}

// Helper for the download endpoint — returns an absolute path to the
// backing file if it exists, null otherwise.
export function resolveArtifactPath(slug) {
  const a = getArtifact(slug);
  if (!a) return null;
  const abs = resolveAbsolute(a.source_path);
  if (!fileExists(a.source_path)) return null;
  return abs;
}

// Verify a catalog manifest — recompute the signature over the body and
// compare. Returns { ok, expected, got } so the caller can surface the
// mismatch.
export function verifyCatalogManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'not an object' };
  const { signature, signed_at: _sa, signature_algo: _sal, ...body } = manifest;
  const expected = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return { ok: expected === signature, expected, got: signature };
}

export const SPEC = Object.freeze({
  version: CATALOG_SPEC_VERSION,
  signature_algo: SIGNATURE_ALGO,
});
