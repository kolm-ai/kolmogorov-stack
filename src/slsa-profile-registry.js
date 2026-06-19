// src/slsa-profile-registry.js
//
// W1023 - one registry for every SLSA/in-toto profile Kolm emits.
//
// There are intentionally two provenance products:
//   - model_artifact: .kolm / compiler / model-signing sidecars.
//   - asr_report: Agent Security Review signed reports.
//
// The registry is the canonical ownership map. It prevents a future maintainer
// from guessing which implementation is authoritative for the model platform
// just because both products speak SLSA Provenance v1 in DSSE.

export const SLSA_PROFILE_REGISTRY_VERSION = 'w1023-slsa-profile-registry-v1';

export const SLSA_PROFILE_IDS = Object.freeze({
  MODEL_ARTIFACT: 'model_artifact',
  ASR_REPORT: 'asr_report',
});

const COMMON = Object.freeze({
  statement_type: 'https://in-toto.io/Statement/v1',
  predicate_type: 'https://slsa.dev/provenance/v1',
  payload_type: 'application/vnd.in-toto+json',
  conformance: 'SLSA Provenance v1 (Build L2 shape)',
  conformance_scope: 'signed_provenance_shape_with_ed25519_key_custody',
  slsa_build_l3_claim_allowed: false,
  requires_hardened_builder_for_l3: true,
});

const PROFILES = Object.freeze({
  [SLSA_PROFILE_IDS.MODEL_ARTIFACT]: Object.freeze({
    id: SLSA_PROFILE_IDS.MODEL_ARTIFACT,
    product_surface: 'kolm_model_platform',
    owner_module: 'src/intoto-slsa.js',
    adapter_modules: Object.freeze(['src/govern-provenance.js', 'src/artifact.js']),
    canonical_for: Object.freeze([
      '.kolm artifact provenance',
      'model-signing-standards',
      'compile artifact sidecars',
      'govern build provenance routes',
    ]),
    build_type: 'https://kolm.ai/compile/v1',
    builder_id_prefix: 'https://kolm.ai/cli/',
    sidecar_members: Object.freeze(['provenance.intoto.dsse.json', 'model.sig.bundle']),
    subject_scope: 'actual bundled artifact member bytes',
    key_identity_mode: 'ed25519_key_custody',
    optional_identity_modes: Object.freeze(['ed25519_key_custody', 'sigstore_keyless_fulcio_oidc_policy']),
    keyless_oidc_option_supported: true,
    keyless_oidc_identity_bound: false,
    keyless_policy_module: 'src/sigstore-keyless.js',
    ...COMMON,
  }),
  [SLSA_PROFILE_IDS.ASR_REPORT]: Object.freeze({
    id: SLSA_PROFILE_IDS.ASR_REPORT,
    product_surface: 'kolm_agent_security_review',
    owner_module: 'src/slsa-provenance.js',
    adapter_modules: Object.freeze(['src/attestation-report-builder.js']),
    canonical_for: Object.freeze([
      'agent security report provenance',
      'audit report supply-chain export',
    ]),
    build_type: 'https://kolm.ai/asr-audit/v1',
    builder_id: 'https://kolm.ai',
    sidecar_members: Object.freeze([]),
    subject_scope: 'canonical signed ASR report bytes',
    key_identity_mode: 'ed25519_key_custody',
    optional_identity_modes: Object.freeze(['ed25519_key_custody']),
    keyless_oidc_option_supported: false,
    keyless_oidc_identity_bound: false,
    ...COMMON,
  }),
});

export const SLSA_PROFILES = PROFILES;

export function listSlsaProfiles() {
  return Object.values(PROFILES).map((profile) => ({ ...profile }));
}

export function getSlsaProfile(id) {
  const key = String(id || '');
  const profile = PROFILES[key];
  if (!profile) throw new Error(`unknown SLSA profile: ${key || '(empty)'}`);
  return profile;
}

export function resolveSlsaProfileForSurface(surface) {
  const s = String(surface || '').toLowerCase();
  if (
    s.includes('.kolm')
    || s.includes('model')
    || s.includes('compile')
    || s.includes('artifact')
    || s.includes('govern')
  ) {
    return PROFILES[SLSA_PROFILE_IDS.MODEL_ARTIFACT];
  }
  if (
    s.includes('asr')
    || s.includes('audit')
    || s.includes('agent security')
    || s.includes('report')
  ) {
    return PROFILES[SLSA_PROFILE_IDS.ASR_REPORT];
  }
  return null;
}

export function validateSlsaProfileRegistry() {
  const failures = [];
  const profiles = listSlsaProfiles();
  const ids = new Set();
  const buildTypes = new Set();

  for (const profile of profiles) {
    if (!profile.id) failures.push('profile_id_missing');
    if (ids.has(profile.id)) failures.push(`duplicate_profile_id:${profile.id}`);
    ids.add(profile.id);

    if (!profile.owner_module) failures.push(`${profile.id}:owner_module_missing`);
    if (!profile.product_surface) failures.push(`${profile.id}:product_surface_missing`);
    if (!Array.isArray(profile.canonical_for) || profile.canonical_for.length === 0) {
      failures.push(`${profile.id}:canonical_for_missing`);
    }
    for (const field of ['statement_type', 'predicate_type', 'payload_type', 'build_type', 'conformance']) {
      if (typeof profile[field] !== 'string' || profile[field].length === 0) {
        failures.push(`${profile.id}:${field}_missing`);
      }
    }
    if (buildTypes.has(profile.build_type)) failures.push(`duplicate_build_type:${profile.build_type}`);
    buildTypes.add(profile.build_type);
    if (profile.slsa_build_l3_claim_allowed && !profile.keyless_oidc_identity_bound) {
      failures.push(`${profile.id}:l3_claim_without_keyless_identity`);
    }
    if (profile.keyless_oidc_option_supported && profile.keyless_oidc_identity_bound) {
      failures.push(`${profile.id}:keyless_option_misreported_as_default_identity`);
    }
    if (profile.keyless_oidc_option_supported && profile.keyless_policy_module !== 'src/sigstore-keyless.js') {
      failures.push(`${profile.id}:keyless_policy_module_missing`);
    }
  }

  const model = PROFILES[SLSA_PROFILE_IDS.MODEL_ARTIFACT];
  if (!model.canonical_for.some((row) => /model-signing/i.test(row))) {
    failures.push('model_artifact_not_canonical_for_model_signing');
  }
  const asr = PROFILES[SLSA_PROFILE_IDS.ASR_REPORT];
  if (!asr.canonical_for.some((row) => /audit report|agent security/i.test(row))) {
    failures.push('asr_report_not_canonical_for_audit_reports');
  }

  return {
    ok: failures.length === 0,
    version: SLSA_PROFILE_REGISTRY_VERSION,
    profile_count: profiles.length,
    failures,
  };
}

export default {
  SLSA_PROFILE_IDS,
  SLSA_PROFILE_REGISTRY_VERSION,
  SLSA_PROFILES,
  getSlsaProfile,
  listSlsaProfiles,
  resolveSlsaProfileForSurface,
  validateSlsaProfileRegistry,
};
