#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'binder-contract-matrix.json');
const SCHEMA = 'kolm.binder_contract_matrix.v1';
const UPDATED_AT = '2026-06-18';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const SUMMARY = args.has('--summary');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function lineNumber(text, idx) {
  return text.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}

function extractImports(src) {
  const rows = [];
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
    const from = m[2];
    rows.push({
      from,
      spec: m[1].replace(/\s+/g, ' ').trim(),
      line: lineNumber(src, m.index),
      category: importCategory(from),
    });
  }
  return rows.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
}

function importCategory(from) {
  if (from.startsWith('node:')) return 'node_builtin';
  if (from === 'adm-zip') return 'zip_parser_dependency';
  if (from === './artifact-runner.js' || from === './env.js') return 'artifact_loader_or_env';
  if (from === './audit.js') return 'audit_chain';
  if (/(provenance|cid|lineage|workflow|confidential|ed25519|sigstore|attestation|supersession|licensing|holdout|recipe-class|export)/.test(from)) {
    return 'proof_policy_validator';
  }
  return 'local_dependency';
}

function extractExports(src) {
  return [...src.matchAll(/^export\s+(async\s+)?(function|const)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({
      name: m[3],
      kind: m[2],
      async: !!m[1],
      line: lineNumber(src, m.index),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function requiredExports() {
  return [
    'buildBinder',
    'writeBinder',
    'verifyArtifactStructured',
    'recordFingerprintShare',
    'BINDER',
  ];
}

function extractInternalFunctions(src) {
  return [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\(/gm)]
    .map((m) => ({
      name: m[1],
      async: src.slice(m.index, m.index + 20).startsWith('async '),
      line: lineNumber(src, m.index),
    }))
    .sort((a, b) => a.line - b.line);
}

function checkCategory(name) {
  if (/Manifest|Content identifier|Artifact class|Runtime target|Audit chain|Receipt signature|Provenance sidecars|Provenance credential/.test(name)) {
    return 'artifact_integrity_and_signatures';
  }
  if (/K-score|Eval coverage|Seed gate|External|Tenant shadow|Corpus URL/.test(name)) {
    return 'eval_data_and_license_governance';
  }
  if (/Capability|Lineage|Workflow/.test(name)) return 'capability_lineage_workflow';
  if (/Attestation|Signature policy|Transparency policy|auditor|Supersession|Drift/.test(name)) {
    return 'attestation_transparency_and_drift';
  }
  if (/Native binary|binaries|Build reproducibility|Export targets/.test(name)) {
    return 'runtime_export_and_reproducibility';
  }
  if (/PHI|Cross-vendor|teacher-delta/.test(name)) return 'training_and_domain_provenance';
  return 'other';
}

function extractCheckFamilies(src) {
  const pushes = [];
  for (const m of src.matchAll(/checks\.push\(\{[\s\S]*?name:\s*(['"])(.*?)\1/g)) {
    pushes.push({
      name: m[2],
      line: lineNumber(src, m.index),
      category: checkCategory(m[2]),
    });
  }
  const byName = new Map();
  for (const row of pushes) {
    if (!byName.has(row.name)) {
      byName.set(row.name, {
        name: row.name,
        category: row.category,
        first_line: row.line,
        branch_count: 0,
      });
    }
    byName.get(row.name).branch_count += 1;
  }
  return {
    pushes,
    families: [...byName.values()].sort((a, b) => a.first_line - b.first_line),
  };
}

function extractStructuredCheckMap(src) {
  const block = src.match(/const STRUCTURED_CHECK_MAP = \[([\s\S]*?)\];/);
  if (!block) return [];
  const rows = [];
  for (const m of block[1].matchAll(/\[(\/\^[^,]+?\/[a-z]*),\s*'([^']+)',\s*'([^']+)'\]/g)) {
    rows.push({
      pattern: m[1],
      reason: m[2],
      failing_field: m[3],
    });
  }
  return rows;
}

function structuredReasons(src, mapRows) {
  const blockStart = src.indexOf('export async function verifyArtifactStructured');
  const blockEnd = src.indexOf('function recheckBundledFileHashes', blockStart);
  const block = blockStart >= 0 && blockEnd > blockStart ? src.slice(blockStart, blockEnd) : '';
  const found = new Set(mapRows.map((row) => row.reason));
  for (const m of block.matchAll(/reason:\s*'([a-z][a-z0-9_]+)'/g)) found.add(m[1]);
  return [...found].sort();
}

function extractRenderSections(src) {
  return [...src.matchAll(/^function (render[A-Za-z0-9_]+)\(/gm)]
    .map((m) => ({
      name: m[1],
      line: lineNumber(src, m.index),
      section: m[1].replace(/^render/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase().replace(/\s+/g, '_'),
    }))
    .sort((a, b) => a.line - b.line);
}

function extractHashSlots(src) {
  const block = src.match(/const slotMap = \{([\s\S]*?)\};/);
  if (!block) return [];
  const rows = [];
  for (const m of block[1].matchAll(/([A-Za-z0-9_]+):\s*'([^']+)'/g)) {
    rows.push({ manifest_hash_key: m[1], zip_entry: m[2] });
  }
  return rows.sort((a, b) => a.manifest_hash_key.localeCompare(b.manifest_hash_key));
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const directImport = body.includes('../src/binder.js') || body.includes('"../src/binder.js"');
    const sourceLock = body.includes('src/binder.js');
    const buildBinderRefs = (body.match(/\bbuildBinder\b/g) || []).length;
    const structuredRefs = (body.match(/\bverifyArtifactStructured\b/g) || []).length;
    const fingerprintShareRefs = (body.match(/\brecordFingerprintShare\b/g) || []).length;
    if (!directImport && !sourceLock && !buildBinderRefs && !structuredRefs && !fingerprintShareRefs) continue;
    rows.push({
      path: rel,
      direct_import: directImport,
      source_lock: sourceLock,
      build_binder_refs: buildBinderRefs,
      structured_verifier_refs: structuredRefs,
      fingerprint_share_refs: fingerprintShareRefs,
    });
  }
  return rows;
}

function requiredTestEvidence() {
  return [
    'tests/finalized-c7-artifact-provenance-repro.test.js',
    'tests/wave144-native-compile.test.js',
    'tests/wave144-seeds-gate.test.js',
    'tests/wave144-verifier-states.test.js',
    'tests/wave149-ed25519-default.test.js',
    'tests/wave150-sigstore.test.js',
    'tests/wave157-redactor-receipt.test.js',
    'tests/wave158-cross-vendor.test.js',
    'tests/wave160-teacher-delta.test.js',
    'tests/wave161-ed25519-policy.test.js',
    'tests/wave162-sigstore-rekor.test.js',
    'tests/wave163-export-binder.test.js',
    'tests/wave164-external-adversarial.test.js',
    'tests/wave165-tenant-shadow.test.js',
    'tests/wave166-auditor-attestation.test.js',
    'tests/wave167-drift-supersession.test.js',
    'tests/wave409aa-verify-hardening.test.js',
    'tests/wave409d-runtime-dispatch.test.js',
    'tests/wave409q-c-rust-wasm-verify.test.js',
    'tests/wave417-definition-of-done.test.js',
    'tests/wave445-verify-hardening.test.js',
    'tests/wave890-6-security.test.js',
  ];
}

function safetyGuards(src, exports, checkFamilies, structuredReasonList, hashSlots) {
  const requiredExportSet = new Set(requiredExports());
  const exportSet = new Set(exports.map((row) => row.name));
  const escIdx = src.indexOf('function esc');
  const escBlock = escIdx >= 0 ? src.slice(escIdx, src.indexOf('function fmtBytes', escIdx)) : '';
  const structuredIdx = src.indexOf('export async function verifyArtifactStructured');
  const structuredBlock = structuredIdx >= 0 ? src.slice(structuredIdx, src.indexOf('function recheckBundledFileHashes', structuredIdx)) : '';
  const shareIdx = src.indexOf('export function recordFingerprintShare');
  const shareBlock = shareIdx >= 0 ? src.slice(shareIdx) : '';
  const familyNames = new Set(checkFamilies.map((row) => row.name));
  const reasonSet = new Set(structuredReasonList);
  const requiredReasons = [
    'manifest_hash_mismatch',
    'native_binary_missing',
    'production_check_failed_on_install',
    'signature_invalid',
    'synthetic_only_in_production',
    'train_holdout_leakage',
  ];

  return {
    binder_spec_constant_exported: src.includes("const BINDER_SPEC = 'kolm-binder/0.1'") && src.includes('export const BINDER = { spec: BINDER_SPEC }'),
    required_public_exports_present: [...requiredExportSet].every((name) => exportSet.has(name)),
    canonical_loader_used_with_invalid_signature_reporting: src.includes('loadArtifact(artifactPath, { allowInvalidSignature: true })') && familyNames.has('Manifest signature (legacy HMAC)'),
    cloud_trusted_mode_structural_only: src.includes('isArtifactPathCloudTrusted') && src.includes('chainStructuralIntegrityOk') && src.includes('credentialStructuralIntegrityOk'),
    html_escape_covers_core_entities: ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'].every((token) => escBlock.includes(token)),
    renderer_has_no_script_tag: !/<script/i.test(src),
    deterministic_canonical_json_for_signatures: src.includes('function canonicalJson') && src.includes('Object.keys(v).sort()'),
    hmac_multi_secret_verification: src.includes('effectiveReceiptSecret({ includeLegacyArtifactSecret: true })') && src.includes('verificationSecrets({ includeLegacyArtifactSecret: true })') && src.includes('hmacHex(candidate, canonicalJson('),
    public_key_and_transparency_layers: src.includes('verifyEd25519Block') && src.includes('verifySigstoreBundle') && src.includes('verifyArtifactProvenanceSidecarsAsync'),
    runtime_target_consistency_gate: src.includes('SUPPORTED_RUNTIME_TARGETS') && ['js', 'wasm', 'native', 'gguf', 'onnx'].every((target) => src.includes(`declaredTarget === '${target}'`)),
    structured_reason_enum_closed: requiredReasons.every((reason) => reasonSet.has(reason)) && structuredReasonList.every((reason) => requiredReasons.includes(reason)),
    structured_failure_translation_present: structuredBlock.includes('translateCheck(failed)') && structuredBlock.includes('production_check_failed_on_install'),
    bundled_file_hash_recheck_present: structuredBlock.includes('recheckBundledFileHashes(bundle, manifest.hashes)') && hashSlots.length >= 8 && src.includes('extra_files'),
    production_ready_crosscheck_present: structuredBlock.includes("await import('./production-ready.js')") && structuredBlock.includes('productionReady() rejected'),
    eval_seed_and_holdout_gates_present: familyNames.has('Seed gate (train/holdout independence)') && familyNames.has('External / adversarial holdouts') && familyNames.has('Tenant shadow corpus'),
    attestation_honest_scope_present: src.includes('verifyAttestation(cc.kind, report)') && src.includes('shape-only (no cryptographic chain walked'),
    signature_policy_and_rekor_policy_present: familyNames.has('Signature policy (Ed25519)') && familyNames.has('Transparency policy (Rekor)'),
    auditor_drift_and_supersession_present: familyNames.has('Third-party auditor attestation') && familyNames.has('Supersession chain') && familyNames.has('Drift report'),
    corpus_license_gate_present: src.includes('checkCorpusLicensing') && familyNames.has('Corpus URL licensing gate'),
    fingerprint_share_audit_only_payload: shareBlock.includes('appendAudit({') && shareBlock.includes('AUDIT_OPS.FINGERPRINT_SHARE') && shareBlock.includes('recipient_count') && !/raw_bag\s*:|top_terms_hash_array\s*:/.test(shareBlock),
    no_subprocess_or_live_network_side_effects: !/\bchild_process\b|\bspawn(?:Sync)?\b|\bexecFile\b|\bexecSync\b|\bfetch\s*\(/.test(src),
  };
}

function buildMatrix() {
  const src = read('src/binder.js');
  const imports = extractImports(src);
  const exports = extractExports(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const internalFunctions = extractInternalFunctions(src);
  const checks = extractCheckFamilies(src);
  const structuredMap = extractStructuredCheckMap(src);
  const reasons = structuredReasons(src, structuredMap);
  const renderSections = extractRenderSections(src);
  const hashSlots = extractHashSlots(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel) && !fs.existsSync(path.join(ROOT, rel)));
  const guards = safetyGuards(src, exports, checks.families, reasons, hashSlots);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

  const requiredCheckFamilies = [
    'Manifest signature (legacy HMAC)',
    'Content identifier (CID) round-trip',
    'Artifact class consistency (honest taxonomy)',
    'Runtime target consistency',
    'Audit chain (HMAC receipt)',
    'Receipt signature (Ed25519, public-key)',
    'Receipt signature (Sigstore bundle)',
    'Provenance sidecars (SLSA/OMS, signer-derived)',
    'K-score gate',
    'Seed gate (train/holdout independence)',
    'Attestation state',
    'Native binary integrity',
    'Build reproducibility',
    'Export targets (model files)',
    'External / adversarial holdouts',
    'Tenant shadow corpus',
    'Third-party auditor attestation',
    'Supersession chain',
    'Drift report',
    'Corpus URL licensing gate',
  ];
  const familySet = new Set(checks.families.map((row) => row.name));
  const missingCheckFamilies = requiredCheckFamilies.filter((name) => !familySet.has(name));

  const summary = {
    binder_bytes: Buffer.byteLength(src),
    binder_lines: src.split(/\r?\n/).length,
    import_count: imports.length,
    export_count: exports.length,
    internal_function_count: internalFunctions.length,
    verification_check_push_count: checks.pushes.length,
    verification_check_family_count: checks.families.length,
    missing_required_check_families: missingCheckFamilies.length,
    structured_check_mapping_count: structuredMap.length,
    structured_reason_count: reasons.length,
    render_section_count: renderSections.length,
    bundled_hash_slot_count: hashSlots.length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.import_count < 20) failures.push({ gate: 'imports', count: summary.import_count });
  if (summary.internal_function_count < 20) failures.push({ gate: 'internal_functions', count: summary.internal_function_count });
  if (summary.verification_check_push_count < 100) failures.push({ gate: 'verification_check_pushes', count: summary.verification_check_push_count });
  if (summary.verification_check_family_count < 31) failures.push({ gate: 'verification_check_families', count: summary.verification_check_family_count });
  if (missingCheckFamilies.length) failures.push({ gate: 'required_check_families', missing: missingCheckFamilies });
  if (summary.structured_check_mapping_count < 12) failures.push({ gate: 'structured_check_map', count: summary.structured_check_mapping_count });
  if (summary.structured_reason_count !== 6) failures.push({ gate: 'structured_reason_enum', count: summary.structured_reason_count, reasons });
  if (summary.render_section_count < 10) failures.push({ gate: 'render_sections', count: summary.render_section_count });
  if (summary.bundled_hash_slot_count < 8) failures.push({ gate: 'bundled_hash_slots', count: summary.bundled_hash_slot_count });
  if (failedGuards.length) failures.push({ gate: 'binder_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for the binder verifier boundary: public exports, artifact verification check families, structured failure taxonomy, render sections, manifest hash slots, safety guards, and direct test evidence.',
    sources: [
      'src/binder.js',
      ...requiredTests,
    ],
    summary,
    imports,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    internal_functions: internalFunctions,
    verification_check_families: checks.families,
    verification_check_pushes: checks.pushes,
    required_check_families: requiredCheckFamilies,
    missing_required_check_families: missingCheckFamilies,
    structured_failure_taxonomy: {
      stable_reasons: reasons,
      mappings: structuredMap,
    },
    render_sections: renderSections,
    bundled_hash_slots: hashSlots,
    public_return_shapes: {
      buildBinder: ['html', 'checks', 'verdict', 'manifest', 'receipt', 'credential'],
      writeBinder: ['html', 'checks', 'verdict', 'manifest', 'receipt', 'credential', 'out_path', 'bytes'],
      verifyArtifactStructured_ok: ['ok', 'manifest', 'receipt', 'credential', 'checks'],
      verifyArtifactStructured_error: ['ok', 'reason', 'detail', 'failing_field'],
    },
    safety_guards: guards,
    failed_safety_guards: failedGuards,
    required_test_evidence: requiredTests,
    test_evidence: tests,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: [],
    },
  };
}

function main() {
  const matrix = buildMatrix();
  const body = stableStringify(matrix);

  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('binder-contract-matrix: docs/internal/binder-contract-matrix.json is out of date');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
  }

  if (SUMMARY) {
    console.log(JSON.stringify({
      ok: matrix.gates.ok,
      schema: matrix.schema,
      summary: matrix.summary,
      failures: matrix.gates.failures,
      warnings: matrix.gates.warnings,
    }, null, 2));
  } else {
    const action = CHECK ? 'ok' : 'wrote';
    console.log(`binder-contract-matrix: ${action} docs/internal/binder-contract-matrix.json checks=${matrix.summary.verification_check_family_count} reasons=${matrix.summary.structured_reason_count} failures=${matrix.gates.failures.length}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
