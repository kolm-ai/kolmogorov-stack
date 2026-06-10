#!/usr/bin/env node
// X04 evidence generator - derives public/evidence/site-claims.json from
// ground-truth artifacts already on disk, so every countable fact rendered on
// kolm.ai traces to a measurement the buyer can inspect:
//
//   - controls count        <- public/sample-audit-report.json  asr_checklist[]
//   - frameworks count      <- public/sample-audit-report.json  frameworks[]
//   - verification tiers    <- public/verify-widget.js          distinct "tier N" markers
//   - issuer fingerprint    <- public/keys/kolm-issuers.json    kid=kolm-prod-2026
//   - sample finding phrase <- public/sample-audit-report.json  findings[id=over-permission].title
//
// The evidence file is consumed by scripts/x04-claim-verify.cjs via
// data/x04-claim-fixtures.json. If any source artifact changes (key rotation,
// a ninth control, a regenerated sample report), the regenerated evidence
// drifts from the rendered claim and the X04 gate blocks the release.
//
// Invocation:
//   node scripts/generate-claim-evidence.cjs           # write public/evidence/site-claims.json
//   node scripts/generate-claim-evidence.cjs --check   # exit 1 if the on-disk file is stale

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'public', 'evidence', 'site-claims.json');

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function word(n) {
  if (!Number.isInteger(n) || n < 0 || n >= WORDS.length) throw new Error('count out of word range: ' + n);
  return WORDS[n];
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function build() {
  const report = readJson('public/sample-audit-report.json');
  const keyring = readJson('public/keys/kolm-issuers.json');
  const widgetSrc = fs.readFileSync(path.join(REPO_ROOT, 'public', 'verify-widget.js'), 'utf8');

  // Controls: the signed sample report's ASR checklist is the engine's own
  // statement of what it assesses.
  const controls = report.asr_checklist;
  if (!Array.isArray(controls) || !controls.length) throw new Error('sample report missing asr_checklist');
  const controlsCount = controls.length;

  // Frameworks: the mapping targets carried on the signed sample report.
  const frameworks = report.frameworks;
  if (!Array.isArray(frameworks) || !frameworks.length) throw new Error('sample report missing frameworks');
  const frameworksCount = frameworks.length;

  // Verification tiers: distinct "tier N" markers in the public verifier the
  // buyer actually runs. A third tier in the widget drifts this to 3.
  const tierMarkers = new Set();
  for (const m of widgetSrc.matchAll(/tier[ _]?([0-9])/gi)) tierMarkers.add(m[1]);
  const tiersCount = tierMarkers.size;

  // Production issuer fingerprint from the published keyring.
  const prod = (keyring.issuers || []).find((i) => i.kid === 'kolm-prod-2026');
  if (!prod || typeof prod.fingerprint !== 'string') throw new Error('keyring missing kolm-prod-2026 fingerprint');
  if (prod.revoked) throw new Error('kolm-prod-2026 is revoked; rendered fingerprint must change');

  // Sample finding phrase: extracted from the over-permission finding title on
  // the signed sample report, so the homepage register quotes the artifact.
  const finding = (report.findings || []).find((f) => f.id === 'over-permission');
  if (!finding) throw new Error('sample report missing over-permission finding');
  const phraseMatch = String(finding.title).match(/grants \d+ tools, uses \d+/);
  if (!phraseMatch) throw new Error('over-permission title no longer carries the grants/uses phrase');

  // Summary register: the findings line rendered verbatim in the five sample
  // registers (index, report, enterprise, research, ai-vendors). Severity
  // buckets with a zero count are omitted, matching the rendered line.
  const summary = report.summary;
  if (!summary || !Number.isInteger(summary.total_findings)) throw new Error('sample report missing summary.total_findings');
  const sev = summary.by_severity || {};
  const parts = [String(summary.total_findings)];
  if (sev.critical) parts.push(`<b>${sev.critical} critical</b>`);
  if (sev.high) parts.push(`<b>${sev.high} high</b>`);
  if (sev.medium) parts.push(`${sev.medium} medium`);
  if (sev.low) parts.push(`${sev.low} low`);
  if (sev.info) parts.push(`${sev.info} info`);
  const findingsRegister = parts.join(' · ');

  // Signature excerpt: head/tail of the actual Ed25519 signature on the sample
  // report, as quoted in the same registers. A re-signed sample drifts these.
  const sig = report.signature_ed25519;
  if (!sig || typeof sig.signature !== 'string') throw new Error('sample report missing signature_ed25519.signature');
  if (typeof sig.key_fingerprint !== 'string') throw new Error('sample report missing signature_ed25519.key_fingerprint');

  return {
    schema: 'kolm-site-claims-evidence-1',
    generated_at: new Date().toISOString(),
    generator: 'scripts/generate-claim-evidence.cjs',
    note: 'Derived from checked-in ground-truth artifacts. Regenerate with the generator; do not hand-edit. Consumed by scripts/x04-claim-verify.cjs via data/x04-claim-fixtures.json.',
    rows: [
      {
        id: 'asr-controls',
        source: 'public/sample-audit-report.json#asr_checklist',
        controls_count: controlsCount,
        controls_word: word(controlsCount),
        controls_word_cap: capitalize(word(controlsCount)),
        control_ids: controls.map((c) => c.id),
      },
      {
        id: 'report-frameworks',
        source: 'public/sample-audit-report.json#frameworks',
        frameworks_count: frameworksCount,
        frameworks_word: word(frameworksCount),
        frameworks_word_cap: capitalize(word(frameworksCount)),
        framework_names: frameworks.map((f) => f.framework || f.name),
      },
      {
        id: 'verification-tiers',
        source: 'public/verify-widget.js (distinct "tier N" markers)',
        tiers_count: tiersCount,
        tiers_word: word(tiersCount),
        tiers_word_cap: capitalize(word(tiersCount)),
      },
      {
        id: 'issuer-prod-key',
        source: 'public/keys/kolm-issuers.json kid=kolm-prod-2026',
        kid: prod.kid,
        fingerprint: prod.fingerprint,
        fingerprint_prefix16: prod.fingerprint.slice(0, 16),
      },
      {
        id: 'sample-over-permission',
        source: 'public/sample-audit-report.json findings[id=over-permission].title',
        grant_use_phrase: phraseMatch[0],
        severity: finding.severity,
        asr_control: finding.asr && finding.asr.id,
      },
      {
        id: 'sample-report-summary',
        source: 'public/sample-audit-report.json#summary',
        total_findings: summary.total_findings,
        by_severity: sev,
        blocking_count: summary.blocking_count,
        findings_register: findingsRegister,
      },
      {
        id: 'sample-signature',
        source: 'public/sample-audit-report.json#signature_ed25519',
        sig_head10: sig.signature.slice(0, 10),
        sig_tail6: sig.signature.slice(-6),
        key_fingerprint: sig.key_fingerprint,
        key_fingerprint_prefix16: sig.key_fingerprint.slice(0, 16),
      },
    ],
  };
}

function stripVolatile(doc) {
  const clone = JSON.parse(JSON.stringify(doc));
  delete clone.generated_at;
  return JSON.stringify(clone);
}

function main() {
  const check = process.argv.includes('--check');
  let doc;
  try { doc = build(); } catch (e) {
    process.stderr.write('[generate-claim-evidence] FAIL - ' + (e.message || e) + '\n');
    process.exit(2);
  }

  if (check) {
    let onDisk;
    try { onDisk = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (e) {
      process.stderr.write('[generate-claim-evidence] STALE - evidence file missing or unreadable: ' + OUT_PATH + '\n');
      process.exit(1);
    }
    if (stripVolatile(onDisk) !== stripVolatile(doc)) {
      process.stderr.write('[generate-claim-evidence] STALE - ground truth changed; rerun: node scripts/generate-claim-evidence.cjs\n');
      process.exit(1);
    }
    process.stdout.write('[generate-claim-evidence] OK - evidence matches ground truth (' + doc.rows.length + ' rows)\n');
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2) + '\n');
  process.stdout.write('[generate-claim-evidence] wrote ' + path.relative(REPO_ROOT, OUT_PATH).replace(/\\/g, '/') + ' (' + doc.rows.length + ' rows)\n');
}

main();
