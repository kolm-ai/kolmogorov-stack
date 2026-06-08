// Agent Security-Review - Wave-2 integration tests.
//
// Locks the wiring that joins the four Wave-2 analyzers into the deterministic
// spine and the signed deliverable:
//
//   * runAudit calls model-provenance (ASR-5), agent-identity (ASR-1),
//     rag-memory (ASR-7) and delegation (ASR-8) over the SAME events, merges
//     their findings BEFORE mapControls (so they are framework-mapped), and keeps
//     each analyzer's structured output on the result.
//   * the control mapper routes the new finding ids to ASR-5 / ASR-7 / ASR-8.
//   * the readiness rollup is NON-INFLATED: a supplemental control the logs never
//     exercised is marked 'untested' and excluded from the score, never scored as
//     a clean pass; a supplemental hard blocker folds in and pulls the headline
//     down.
//   * buildReportEnvelope embeds a signature-covered passport + input-evidence
//     digest; build+sign+verify passes on the Node AND browser verifier; mutating
//     the passport breaks the signature; the evidence digest re-derives from the
//     events; and the detached RFC 3161 timestamp + transparency-log checkpoint
//     are present and reference the signed digest.
//
// Pure, in-process, offline (the timestamp is self-issued so no network is hit).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAudit } from '../src/audit-orchestrator.js';
import {
  buildReportEnvelope,
  buildAndSignReportWithEvidence,
  verifyReport,
  computeEvidenceDigest,
  canonicalizeReport as nodeCanonicalizeReport,
} from '../src/attestation-report-builder.js';
import {
  verifyAuditReport,
  canonicalizeReport as browserCanonicalizeReport,
} from '../public/kolm-audit-verify.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import { buildAgentPassport } from '../src/passport-builder.js';

function signerFrom(kp) {
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, key_fingerprint: keyFingerprint(kp.publicKey) };
}

// A synthetic multi-agent export exercising every Wave-2 analyzer:
//   - a PINNED model (gpt-4o-2024-08-06) and a FLOATING model (gpt-4o)
//   - a low-privilege root agent (planner) delegating to a high-privilege
//     sub-agent (executor) under one shared credential -> privilege escalation
//   - an external (untrusted) retrieval source via vector_search
//   - an unattributed action (no credential, no agent name)
const MULTI_AGENT_LOG = [
  JSON.stringify({
    request_id: 'p1', timestamp: '2026-05-01T10:00:00Z', model: 'openai/gpt-4o-2024-08-06',
    api_base: 'https://api.openai.com/v1', user: 'planner', metadata: { key_alias: 'team-key' },
    tools: [{ type: 'function', function: { name: 'get_ticket' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'pc1', type: 'function', function: { name: 'get_ticket', arguments: '{"id":"7"}' } }] }],
  }),
  JSON.stringify({
    request_id: 'e1', timestamp: '2026-05-01T10:05:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'executor', metadata: { key_alias: 'team-key' },
    tools: [{ type: 'function', function: { name: 'delete_record' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'ec1', type: 'function', function: { name: 'delete_record', arguments: '{"id":"7"}' } }] }],
  }),
  JSON.stringify({
    request_id: 'p2', timestamp: '2026-05-01T10:10:00Z', model: 'openai/gpt-4o-2024-08-06',
    api_base: 'https://api.openai.com/v1', user: 'planner', metadata: { key_alias: 'team-key' },
    tools: [{ type: 'function', function: { name: 'vector_search' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'pc2', type: 'function', function: { name: 'vector_search', arguments: '{"url":"https://untrusted-corpus.example.com/q","query":"refunds"}' } }] }],
  }),
  JSON.stringify({
    request_id: 'u1', timestamp: '2026-05-01T10:15:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1',
    messages: [{ role: 'user', content: 'status?' }],
  }),
].join('\n');

// A clean single agent: read-only, hash-chained, pinned model, NO retrieval /
// memory / delegation -> ASR-7 + ASR-8 must report UNTESTED, never a clean pass.
const CLEAN_LOG = [
  JSON.stringify({
    request_id: 'c1', timestamp: '2026-01-01T00:00:00Z', model: 'openai/gpt-4o-2024-08-06',
    api_base: 'https://api.openai.com/v1', user: 'reader', metadata: { key_alias: 'k-clean' }, hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'rc1', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
  JSON.stringify({
    request_id: 'c2', timestamp: '2026-09-01T00:00:00Z', model: 'openai/gpt-4o-2024-08-06',
    api_base: 'https://api.openai.com/v1', user: 'reader', metadata: { key_alias: 'k-clean' }, hash: 'h2', prev_hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'rc2', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
].join('\n');

const has = (findings, id) => findings.some((f) => f && f.id === id);
const rowsById = (audit) => Object.fromEntries(audit.summary.controls.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
// 1) Every Wave-2 analyzer runs over the same events and surfaces its finding.
// ---------------------------------------------------------------------------
test('runAudit wires all four Wave-2 analyzers and merges their findings', () => {
  const audit = runAudit(MULTI_AGENT_LOG, { source: 'litellm' });

  // Structured outputs are kept on the result.
  assert.ok(audit.model_provenance && Array.isArray(audit.model_provenance.findings), 'model_provenance attached');
  assert.ok(audit.agent_identity && Array.isArray(audit.agent_identity.findings), 'agent_identity attached');
  assert.ok(audit.rag_memory && Array.isArray(audit.rag_memory.findings), 'rag_memory attached');
  assert.ok(audit.delegation && Array.isArray(audit.delegation.findings), 'delegation attached');

  // Each analyzer surfaced its signature finding.
  assert.ok(has(audit.model_provenance.findings, 'unpinned-model-version'), 'floating model flagged (ASR-5)');
  assert.ok(has(audit.agent_identity.findings, 'unattributed-agent-action'), 'unattributed action flagged (ASR-1)');
  assert.ok(has(audit.rag_memory.findings, 'untrusted-retrieval-source'), 'external retrieval flagged (ASR-7)');
  assert.ok(has(audit.delegation.findings, 'delegation-privilege-escalation'), 'privilege escalation flagged (ASR-8)');

  // They were merged into the single findings list BEFORE control mapping.
  for (const id of ['unpinned-model-version', 'unattributed-agent-action', 'untrusted-retrieval-source', 'delegation-privilege-escalation']) {
    assert.ok(has(audit.findings, id), `${id} merged into allFindings`);
  }

  // The pinned model produced no unpinned finding (the pinned/floating split is real).
  const slugs = audit.model_provenance.models.map((m) => m.slug);
  assert.ok(slugs.includes('openai/gpt-4o-2024-08-06') && slugs.includes('openai/gpt-4o'), 'both models enumerated');
  const pinned = audit.model_provenance.models.find((m) => m.slug === 'openai/gpt-4o-2024-08-06');
  assert.equal(pinned.pinned, true, 'dated snapshot is pinned');
});

// ---------------------------------------------------------------------------
// 2) The new ASR controls are mapped and surfaced in the rollup.
// ---------------------------------------------------------------------------
test('ASR-5 / ASR-7 / ASR-8 are framework-mapped and appear in the controls rollup', () => {
  const audit = runAudit(MULTI_AGENT_LOG, { source: 'litellm' });

  const asrIds = audit.controls.asr.map((a) => a.id);
  for (const id of ['ASR-1', 'ASR-2', 'ASR-3', 'ASR-5', 'ASR-7', 'ASR-8']) {
    assert.ok(asrIds.includes(id), `${id} present in ASR rollup`);
  }
  // The new analyzers' findings carry framework references after mapping.
  const escalation = audit.controls.findings.find((f) => f.id === 'delegation-privilege-escalation');
  assert.ok(escalation && escalation.asr && escalation.asr.id === 'ASR-8', 'escalation routed to ASR-8');
  assert.ok(escalation.controls.some((c) => /OWASP/.test(c.framework)) && escalation.controls.some((c) => /NIST/.test(c.framework)), 'escalation carries buyer frameworks');

  const retrieval = audit.controls.findings.find((f) => f.id === 'untrusted-retrieval-source');
  assert.equal(retrieval.asr.id, 'ASR-7', 'untrusted retrieval routed to ASR-7');

  const unpinned = audit.controls.findings.find((f) => f.id === 'unpinned-model-version');
  assert.equal(unpinned.asr.id, 'ASR-5', 'unpinned model routed to ASR-5');

  // assessed_controls now covers the six; not_assessed keeps ASR-4 + ASR-6 only.
  assert.deepEqual(audit.summary.assessed_controls, ['ASR-1', 'ASR-2', 'ASR-3', 'ASR-5', 'ASR-7', 'ASR-8']);
  assert.deepEqual(audit.summary.not_assessed.map((n) => n.id), ['ASR-4', 'ASR-6']);
});

// ---------------------------------------------------------------------------
// 3) The readiness rollup is NON-INFLATED.
// ---------------------------------------------------------------------------
test('supplemental hard blockers fold into readiness; untested supplementals are excluded', () => {
  const dirty = runAudit(MULTI_AGENT_LOG, { source: 'litellm' });
  const d = rowsById(dirty);
  // The escalation + untrusted retrieval are hard blockers, so ASR-7/ASR-8 block.
  assert.equal(d['ASR-8'].status, 'blocking', 'delegation escalation makes ASR-8 blocking');
  assert.equal(d['ASR-7'].status, 'blocking', 'untrusted retrieval makes ASR-7 blocking');
  // The floating-model finding is a hygiene medium -> attention (reported, not a blocker).
  assert.equal(d['ASR-5'].status, 'attention', 'unpinned model is attention');
  assert.ok(Number.isInteger(dirty.summary.readiness_pct) && dirty.summary.readiness_pct >= 0 && dirty.summary.readiness_pct < 100, 'readiness is a real graduated number, pulled below 100 by the blockers');

  const clean = runAudit(CLEAN_LOG, { source: 'litellm' });
  const c = rowsById(clean);
  // No retrieval/memory and no delegation -> the supplementals are UNTESTED, not pass.
  assert.equal(c['ASR-7'].status, 'untested', 'no retrieval/memory -> ASR-7 untested (not a clean pass)');
  assert.equal(c['ASR-8'].status, 'untested', 'no delegation -> ASR-8 untested (not a clean pass)');
  // A clean, exercised supply-chain dimension is a pass but does not inflate the score.
  assert.equal(c['ASR-5'].status, 'pass', 'pinned model -> ASR-5 clean pass');
  // The headline is the core posture rollup; untested supplementals are excluded,
  // so a genuinely clean agent reads 100 without being inflated by absent signals.
  assert.equal(clean.summary.readiness_pct, 100, 'clean agent is 100 (untested supplementals excluded, not scored)');
});

// ---------------------------------------------------------------------------
// 4) Signed deliverable: passport + evidence digest under signature; timestamp +
//    transparency-log checkpoint detached; verify on both verifiers.
// ---------------------------------------------------------------------------
test('the signed report carries a passport + evidence digest, verifies, and binds detached evidence', async () => {
  const audit = runAudit(MULTI_AGENT_LOG, { source: 'litellm' });
  const kp = generateKeyPair();
  const built = await buildAndSignReportWithEvidence(audit, {
    subject: 'Multi-agent fleet',
    report_seed: 'wave2',
    generated_at: '2026-06-09T00:00:00.000Z',
    signer: signerFrom(kp),
    selfIssueTimestamp: true, // real RFC 3161 token, fully offline (no network)
  });
  const env = built.envelope;

  // Passport + evidence digest are present and under the signature.
  assert.ok(env.passport && env.passport.spec_version === 'asr-passport/0.1', 'passport present');
  assert.ok(env.evidence_digest && env.evidence_digest.alg === 'sha256' && /^[0-9a-f]{64}$/.test(env.evidence_digest.value), 'evidence_digest present + well-formed');

  // Passport content reflects the analyzers.
  const agentNames = env.passport.agents.map((a) => a.agent);
  assert.ok(agentNames.includes('planner') && agentNames.includes('executor'), 'passport enumerates the agents');
  assert.ok(env.passport.models.some((m) => m.pinned) && env.passport.models.some((m) => !m.pinned), 'passport records pinned + floating models');
  assert.ok(env.passport.delegation_graph.edges.length >= 1, 'passport carries the delegation graph');
  assert.ok(env.passport.retrieval_sources.some((s) => /untrusted-corpus/.test(s.source)), 'passport records the retrieval source');

  // Node + browser verification both pass, with byte-identical canonicalization.
  assert.equal(verifyReport(env).ok, true, 'Node verifyReport passes');
  assert.equal((await verifyAuditReport(env)).ok, true, 'browser verifyAuditReport passes');
  assert.equal(nodeCanonicalizeReport(env), browserCanonicalizeReport(env), 'Node + browser canonicalization agree');

  // The evidence digest re-derives from the exact events the audit analyzed.
  assert.equal(computeEvidenceDigest(audit).value, env.evidence_digest.value, 'evidence_digest re-derives from the events');
  assert.equal(env.evidence_digest.event_count, audit.events.length, 'event_count matches the analyzed events');
  assert.equal(verifyReport(env, { events: audit.events }).ok, true, 'evidence_digest verifies against the supplied events');

  // The passport is signature-covered: mutating it breaks the signature.
  const tampered = JSON.parse(JSON.stringify(env));
  tampered.passport.identity_status = 'attested-but-forged';
  const vt = verifyReport(tampered);
  assert.equal(vt.ok, false, 'mutating the passport breaks verification');
  assert.match(vt.reason, /does not verify/i);

  // Detached evidence: an RFC 3161 timestamp + a transparency-log checkpoint, both
  // referencing the SIGNED report digest, present and well-formed.
  assert.ok(env.timestamp_evidence && env.timestamp_evidence.status === 'timestamped', 'trusted timestamp attached');
  assert.ok(/^[0-9a-f]{64}$/.test(env.timestamp_evidence.message_imprint), 'timestamp binds a sha256 report digest');
  assert.ok(env.log_checkpoint && /^[0-9a-f]{64}$/.test(env.log_checkpoint.root_hash) && Number.isFinite(Number(env.log_checkpoint.tree_size)), 'transparency-log checkpoint attached');
  assert.equal(env.log_checkpoint.report_digest, env.timestamp_evidence.message_imprint, 'timestamp + log bind the SAME signed digest');

  // Detached evidence is NOT signature-covered: editing it does not break verify
  // (it references the signed digest, it is not part of the signed payload).
  const td = JSON.parse(JSON.stringify(env));
  td.timestamp_evidence.timestamp = '2099-01-01T00:00:00Z';
  assert.equal(verifyReport(td).ok, true, 'detached timestamp is excluded from the signed payload');
});

// ---------------------------------------------------------------------------
// 5) buildAgentPassport is a pure, never-throwing projection.
// ---------------------------------------------------------------------------
test('buildAgentPassport never throws and degrades to a valid empty passport', () => {
  for (const bad of [undefined, null, 42, 'x', {}, { agent_identity: null }]) {
    let pp;
    assert.doesNotThrow(() => { pp = buildAgentPassport(bad); });
    assert.equal(pp.spec_version, 'asr-passport/0.1');
    assert.ok(Array.isArray(pp.agents) && Array.isArray(pp.models) && Array.isArray(pp.mcp_surface));
    assert.ok(pp.delegation_graph && Array.isArray(pp.delegation_graph.nodes) && Array.isArray(pp.delegation_graph.edges));
    assert.ok(Array.isArray(pp.standards) && pp.standards.length >= 5, 'descriptive standards mapping present');
  }
});

// ---------------------------------------------------------------------------
// 6) The envelope-level shape: evidence_digest + passport are signature-covered
//    even on the sync (no-detached-evidence) build path.
// ---------------------------------------------------------------------------
test('buildReportEnvelope embeds passport + evidence_digest before signing', () => {
  const audit = runAudit(MULTI_AGENT_LOG, { source: 'litellm' });
  const env = buildReportEnvelope(audit, { subject: 'x', report_seed: 'pp', generated_at: '2026-06-09T00:00:00.000Z' });
  assert.ok('passport' in env && 'evidence_digest' in env, 'both fields embedded pre-signature');
  // They are part of the canonical (signed) bytes.
  const canon = nodeCanonicalizeReport(env);
  assert.ok(canon.includes('"passport"') && canon.includes('"evidence_digest"'), 'both are in the signed payload');
  // Detached evidence is NOT added by the sync path.
  assert.ok(!('timestamp_evidence' in env) && !('log_checkpoint' in env), 'sync path leaves detached evidence to the async wrapper');
});
