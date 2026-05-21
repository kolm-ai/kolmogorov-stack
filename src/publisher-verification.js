const CHECKS = Object.freeze([
  { id: 'identity-domain', label: 'Domain or organization identity is verified', required_for: ['verified', 'kolm_certified', 'enterprise_verified'] },
  { id: 'artifact-signature', label: 'Artifacts carry a valid signature/receipt', required_for: ['verified', 'kolm_certified', 'enterprise_verified'] },
  { id: 'production-ready', label: 'Artifacts pass production-ready gates', required_for: ['verified', 'kolm_certified', 'enterprise_verified'] },
  { id: 'k-score-floor', label: 'Published artifacts meet the configured K-score floor', required_for: ['kolm_certified', 'enterprise_verified'] },
  { id: 'security-review', label: 'Manual or partner security review is recorded', required_for: ['enterprise_verified'] },
  { id: 'support-contact', label: 'Publisher has a current security/support contact', required_for: ['kolm_certified', 'enterprise_verified'] },
]);

const BADGES = Object.freeze({
  unverified: { rank: 0, label: 'Unverified publisher' },
  verified: { rank: 10, label: 'Verified publisher' },
  kolm_certified: { rank: 20, label: 'Kolm certified publisher' },
  enterprise_verified: { rank: 30, label: 'Enterprise verified publisher' },
});

function bool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function artifactPasses(a, kScoreFloor) {
  const k = Number(a?.k_score ?? a?.kScore ?? a?.score ?? 0);
  return {
    signed: bool(a?.signature_valid) || bool(a?.signed) || !!a?.verified_receipt_hash,
    production_ready: bool(a?.production_ready) || bool(a?.verified) || a?.production_readiness_state === 'production_ready_verified',
    k_score_ok: k >= kScoreFloor,
    k_score: k || null,
  };
}

export function verifiedPublisherPolicy({ kScoreFloor = 0.85 } = {}) {
  return {
    ok: true,
    spec: 'kolm-publisher-verification/1',
    k_score_floor: kScoreFloor,
    badges: BADGES,
    checks: CHECKS,
    rules: {
      verified: ['identity-domain', 'artifact-signature', 'production-ready'],
      kolm_certified: ['identity-domain', 'artifact-signature', 'production-ready', 'k-score-floor', 'support-contact'],
      enterprise_verified: ['identity-domain', 'artifact-signature', 'production-ready', 'k-score-floor', 'support-contact', 'security-review'],
    },
    secret_values_included: false,
  };
}

export function evaluatePublisherVerification({
  publisher = {},
  artifacts = [],
  kScoreFloor = 0.85,
} = {}) {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  const artifactFacts = rows.map((a) => artifactPasses(a, kScoreFloor));
  const allSigned = artifactFacts.length > 0 && artifactFacts.every((a) => a.signed);
  const allProductionReady = artifactFacts.length > 0 && artifactFacts.every((a) => a.production_ready);
  const allKScoreOk = artifactFacts.length > 0 && artifactFacts.every((a) => a.k_score_ok);
  const checks = {
    'identity-domain': bool(publisher.domain_verified) || bool(publisher.oidc_verified) || bool(publisher.github_verified),
    'artifact-signature': allSigned,
    'production-ready': allProductionReady,
    'k-score-floor': allKScoreOk,
    'security-review': bool(publisher.security_reviewed) || bool(publisher.manual_reviewed),
    'support-contact': !!(publisher.security_contact || publisher.support_email || publisher.contact_email),
  };
  let badge = 'unverified';
  const policy = verifiedPublisherPolicy({ kScoreFloor });
  for (const candidate of ['enterprise_verified', 'kolm_certified', 'verified']) {
    const required = policy.rules[candidate];
    if (required.every((id) => checks[id])) {
      badge = candidate;
      break;
    }
  }
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([id]) => id);
  return {
    ok: badge !== 'unverified',
    spec: 'kolm-publisher-verification-result/1',
    publisher_id: publisher.id || publisher.slug || publisher.domain || null,
    badge,
    badge_label: BADGES[badge].label,
    checks,
    missing,
    artifact_count: artifactFacts.length,
    min_k_score: artifactFacts.length ? Math.min(...artifactFacts.map((a) => Number(a.k_score || 0))) : null,
    k_score_floor: kScoreFloor,
    secret_values_included: false,
  };
}

export function decorateVerifiedPublisher(artifact, publisherResult) {
  const result = publisherResult || { badge: 'unverified', ok: false };
  return {
    ...artifact,
    publisher_verification: {
      badge: result.badge,
      badge_label: BADGES[result.badge || 'unverified']?.label || BADGES.unverified.label,
      checks: result.checks || {},
      secret_values_included: false,
    },
    verified_publisher: result.ok === true,
  };
}

export default {
  verifiedPublisherPolicy,
  evaluatePublisherVerification,
  decorateVerifiedPublisher,
};
