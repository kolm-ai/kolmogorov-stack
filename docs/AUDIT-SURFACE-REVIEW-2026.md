# Audit Surface Review 2026

Date: 2026-06-11
Status: decision document. No implementation. Read-only review of the audit
engine; every claim below is grounded in a file and line range.
Contact: dev@kolm.ai

Reviewed end to end: src/audit-orchestrator.js, src/audit-ingest.js,
src/audit-event.js, src/connectors/* (datadog, langfuse, langsmith,
openinference, otel, index), src/permission-analyzer.js,
src/audit-trail-analyzer.js, src/agent-identity-analyzer.js,
src/delegation-analyzer.js, src/model-provenance-analyzer.js,
src/rag-memory-analyzer.js, src/red-team.js, src/audit-routes.js,
src/attestation-report-builder.js, src/audit-delta.js, src/audit-export.js,
src/key-revocation.js, src/rfc3161-timestamp.js, src/asr-fulfillment.js,
src/wrapper-cli.js, scripts/kolm-audit-ci.mjs, src/temporal-analyzer.js.

---

## 1. What the engine actually is (measured, not asserted)

The deterministic spine is `runAudit` (src/audit-orchestrator.js:165-306):
ingest -> analyzers -> control mapping -> red-team battery -> readiness
rollup -> evidence tier. Strengths worth protecting:

- The non-inflation rule is real and consistent: untested supplemental
  controls are excluded from the readiness denominator, never scored clean
  (audit-orchestrator.js:39-49, 221-255). The red-team battery marks
  unexercised probes untested and scores null over zero exercised probes
  (red-team.js:20-27). This discipline is the product's core differentiator;
  every new module must inherit it.
- Evidence quality is graded inside the signed object (A gateway-capture /
  B hash-verified / C asserted; audit-orchestrator.js:98-142).
- Operational loop is more complete than the surface suggests: a CI gate
  with delta modes and PR comments exists (scripts/kolm-audit-ci.mjs:16-33),
  a signed report-to-report delta exists (src/audit-delta.js:123-166), a
  deploy hook exists (audit-routes.js:1356-1366), and re-attestation drift
  fires Slack / HTTP / email webhooks (asr-fulfillment.js:442-462,
  notifications.js:258-340). The marketing surface under-tells this.
- Issuer key lifecycle exists: revoke vs rotate semantics with a public
  status endpoint (key-revocation.js:1-58, audit-routes.js:1018-1095).
- RFC 3161 timestamping uses an external TSA with a clearly marked
  self-issued fallback (rfc3161-timestamp.js:41-46).

Ingest coverage today: provider-log shapes for LiteLLM / Helicone / Portkey /
OpenRouter plus OpenAI chat, Responses, Assistants, and Anthropic
content-block tool_use (audit-ingest.js:179-304, 456-488). Connectors:
datadog, langsmith, otel, openinference, langfuse with auto-detection
(connectors/index.js:22-28, 194-206). First-party gateway capture rows drive
evidence grade A (audit-ingest.js:654-778).

---

## 2. Mission-critical gap analysis

Format per gap: what is missing; why it is mission-critical (buyer seat =
enterprise security reviewer evaluating an AI vendor; vendor seat = the
startup being audited); evidence; smallest credible version to ship.

### GAP-1 (critical) ASR-3 data egress has no analyzer of its own and passes by default

Missing: ASR-3 is a CORE control in the readiness denominator
(audit-orchestrator.js:47) but no egress analyzer module exists. Control
status is computed from severity rollups, and `controlStatus` returns 'pass'
when no finding carries the data-egress pillar (audit-orchestrator.js:64-69).
The only finding that maps there is the permission analyzer's
sensitive-egress finding (permission-analyzer.js:239-249), which fires only
when the regex PII scanner hits. The red-team exfil probes
(exfil-to-untrusted-host, red-team.js:417-423, 604+) see destination trust
but are deliberately not folded into readiness.

Why mission-critical: a log export in which an agent reaches dozens of
unvetted external hosts, none carrying regex-detectable PII, scores
ASR-3 = pass at full weight in a signed paid report. Buyer seat: the egress
number is the first thing a security reviewer probes; a pass that means
"no PII regex hit" rather than "destinations were enumerated and vetted"
collapses trust in the whole readiness figure. Vendor seat: the vendor gets
no destination inventory to remediate against.

Smallest credible ship: a dedicated egress analyzer that (a) emits a
destination inventory (distinct hosts with call counts and sensitivity
flags; the data already exists in ingest stats, audit-ingest.js:865-897),
(b) evaluates an operator-supplied allowlist and flags unapproved
destinations (allowlist plumbing already exists twice:
red-team.js:131-140 normalizeAllowlist and rag-memory-analyzer.js:109-133
matchesAllow), and (c) reports untested-style status when no egress was
observed instead of a silent pass.

### GAP-2 (critical) Sensitive-data detection is a regex PII scanner; signed no-exfil statements rest on it

Missing: every has_sensitive bit in the event stream comes from
`scanPii` over exchange text and tool arguments
(audit-ingest.js:167-177, 586-603). No entropy / secret-shape scan at
ingest (red-team.js has SECRET_PATTERNS at lines 93-105 but applies them
only to machine-readable fields like endpoints and hosts, not to message or
argument bodies), no contextual detection of proprietary data, free-text
health information, or source code.

Why mission-critical: the red-team data-exfil probe reports "resisted" when
egress occurred but nothing matched the regex (red-team.js:488-493), and
the permission analyzer stays silent. A $750 signed report can carry a
clean exfil posture while a customer secret left in a tool-call body. One
public counterexample ends the product's credibility.

Smallest credible ship: (a) reuse SECRET_PATTERNS over message and argument
text at ingest (one function move), (b) add an explicit detector-coverage
caveat to the signed envelope naming the exact PII classes and secret
shapes scanned, so the claim is bounded to what the detector sees; the
caveats section already exists in the builder
(attestation-report-builder.js:21-25).

### GAP-3 (high) Log-window completeness is unverifiable; a curated export audits clean

Missing: for evidence tiers B and C the engine accepts whatever slice the
vendor supplies ("vendor-supplied logs accepted as provided",
audit-orchestrator.js:137-141). The only window check is span_days vs the
retention expectation, severity low (audit-trail-analyzer.js:265-274).
Nothing binds the export to the production system's actual volume, agent
population, or deploy history.

Why mission-critical: buyer seat: the report's input-evidence digest proves
which bytes were analyzed, not that those bytes are representative. A
vendor under deal pressure can export the quiet week. This is the single
easiest way to game the product, and a sophisticated reviewer will ask
about it in the first meeting.

Smallest credible ship: a vendor-signed coverage declaration (window,
systems included, approximate expected call volume) bound into the signed
envelope next to evidence_tier, plus a volume-sanity finding when observed
events/day is wildly inconsistent within the window. The envelope and
canonicalization machinery already exist
(attestation-report-builder.js:127-150).

### GAP-4 (high) Delegation analyzer cannot see the delegation pattern it recommends

Missing: implicit delegation detection requires two agent names under ONE
credential or namespace (delegation-analyzer.js:149-155: session key =
key_id else namespace); explicit detection requires a spawn-verb tool name
(SPAWN_RE, line 48). The remediation every finding recommends - issue each
sub-agent its own scoped key - makes the delegation invisible to the next
audit: parent and child now sit in different sessions and no edge is built.

Why mission-critical: ASR-8 is a named control of the product. Vendor seat:
a customer who follows kolm's own advice sees their delegation findings
vanish into 'untested' rather than 'attenuated', which reads as lost
coverage on the next signed delta (audit-delta.js:24 ranks untested worse
than pass). Buyer seat: real multi-agent fleets with per-agent keys are
reported as having no delegation at all.

Smallest credible ship: correlate parent-child across credentials via the
correlation handles ingest already carries - meta.thread_id,
meta.request_id, meta.assistant_id (audit-ingest.js:524-528) - and via
explicit spawn-call targets that name an agent observed under another key
(extractTarget already parses targets, delegation-analyzer.js:99-116).

### GAP-5 (high) Injection (ASR-4) evidence is observational only; the Deep Red-Team tier has no active code path

Missing: the battery never sends a probe; all fourteen probes score
observed behavior (red-team.js:9-13 states this plainly; probe ids at
red-team.js:456-631). The scope line covers this contractually, and the
untested discipline is correct. But the +$10,000 Deep Red-Team add-on has
no active harness anywhere in src/, and several probes (homoglyph
smuggling, red-team.js:496-507) can never reach 'resisted' from logs alone.

Why mission-critical: buyer seat: "red team" sets the expectation of
adversarial pressure. Passive-only evidence at the top price point is the
gap a competing assessor attacks first. Vendor seat: a vendor who wants to
PROVE resistance (not just absence of exposure) has no path to do so.

Smallest credible ship: a consented active battery against a vendor staging
endpoint, driven through the existing gateway transport
(wrapper-cli.js gateway call, lines 640-860; gateway capture rows already
grade evidence A), reusing the same probe ids and outcome vocabulary so
active results merge into the existing red_team block as a separate,
clearly labeled evidence source. Prompt corpus exists
(src/adversarial-prompts.js).

### GAP-6 (high) Connector blind spots: the stacks 2026 agents actually run on

Missing: no native connector for LangGraph exports, CrewAI, OpenAI Agents
SDK traces, AutoGen / Semantic Kernel, Vercel AI SDK, Bedrock Agents, or
MCP server logs (connectors/index.js:22-28 lists five: datadog, langsmith,
otel, openinference, langfuse). MCP is the sharpest miss: kolm ships its
own MCP gateway (src/mcp-gateway.js) and the red-team battery has an
mcp-discovery probe (red-team.js:549+), yet a customer running MCP servers
has no direct way to feed those server logs into the audit.

Why mission-critical: the free scan is the funnel; "drop your logs in" only
converts when the customer's shape is absorbed. The OTel and OpenInference
connectors cover instrumented LangGraph and CrewAI indirectly, but nothing
on the surface says so, and uninstrumented users bounce.

Smallest credible ship: (a) an MCP server log connector (JSON-RPC
request/response rows map cleanly onto tool_call events with
action.server set - the field already exists in the event schema), (b) an
OpenAI Agents SDK trace connector, (c) a documented "via OTel" recipe for
LangGraph / CrewAI / Vercel AI SDK in the connectors registry detection
docs rather than new code.

### GAP-7 (medium) Offline verification stops at the signature: inclusion proof and revocation need a live kolm

Missing: the signed envelope carries a transparency-log checkpoint (seq,
root_hash, leaf_hash) but not the Merkle inclusion path; the buyer must
call /v1/transparency-log/proof/:seq to verify inclusion
(attestation-report-builder.js:77-116). Key revocation status is likewise
served only by kolm's own endpoint (key-revocation.js:5-19,
audit-routes.js:1042-1095). If kolm is unreachable, retired, or adversarial
the buyer can verify untampered-ness but not inclusion or key validity.

Why mission-critical: the product's pitch is verification without trusting
kolm. The current design is verification without trusting kolm WHILE kolm
is alive and cooperative. Enterprise reviewers with vendor-failure
playbooks will notice.

Smallest credible ship: embed the inclusion path for the report's leaf at
signing time (the log API already computes proofs for the public routes;
the builder appends and gets seq back at line 100-110), and mirror signed
tree heads plus the issuer key directory to an external write-once location
on a cron (src/sigstore.js and src/pubkey-directory.js exist as starting
points).

### GAP-8 (medium) Claim discipline: the analyzer count includes a module the audit never runs

Missing alignment: the product surface counts 7 analyzers, but `runAudit`
wires six (permission, audit-trail, model-provenance, agent-identity,
rag-memory, delegation; audit-orchestrator.js:18-26, 183-188) plus the
red-team battery and the control mapper. src/temporal-analyzer.js is a
W918 distill-corpus coverage tool (its header: production capture
distribution vs a uniform baseline for training-data gaps,
temporal-analyzer.js:1-15) consumed by router.js and
autopilot-lifecycle.js, not by the audit pipeline.

Why mission-critical: the entire brand is "only claim what the code does."
An enterprise reviewer who diffs the marketing against the engine - which
is exactly the kind of buyer this product attracts - finds the count
inflated by an unrelated module.

Smallest credible ship: either say six analyzers plus the deterministic
red-team battery, or build a real audit-side temporal analyzer (off-hours
high-privilege actions, activity gaps inside the claimed window - which
would also strengthen GAP-3) and only then say seven.

### Additional gaps logged (below the top eight, still worth tracking)

- Permission grants are tool-name granularity only; no resource-level or
  argument-level scope reasoning (permission-analyzer.js:141-155). A
  database tool granted and used still says nothing about WHICH tables.
- rag-memory detection is regex-over-tool-name (RETRIEVAL_RE / MEMORY_RE,
  rag-memory-analyzer.js:33-34); direct vector-DB SDK calls that do not
  carry retrieval-shaped names are invisible, and memory writes get no
  content-hash integrity ledger to detect later tampering.
- Model provenance pins names, not bytes: no weights digest or signed
  model manifest cross-check for self-hosted models, despite
  src/model-weights-manifest.js existing on the distill side.
- GRC consumer formats: CSV / CEF / LEEF event exports exist
  (audit-export.js:52) and OneTrust / ServiceNow / OpenPages payload
  shapes exist for model cards (reg-grc-connectors.js:25-35), but the
  audit report itself has no OSCAL assessment-results rendering and no
  remediation-plan table (finding -> owner -> due date) a GRC team can
  import as a POA&M-style artifact.
- The questionnaire route (audit-routes.js:1561-1604) is a strong wedge;
  it is not yet fed by the standard questionnaire corpora buyers actually
  send (SIG Lite, CAIQ), only by kolm's own mapping.

---

## 3. What else kolm should offer

Ranked by buyer-pain x build-cost. Tier names reference the locked catalog;
nothing here alters pricing. Decision list only - no implementation.

1. MCP Server Audit
   Pitch: point kolm at your MCP server logs and get the same signed
   posture report for the tool surface itself - undeclared servers,
   discovery probes, unpinned versions.
   Tier: free scan funnel; findings land in the Signed Readiness Report
   ($750) like any other source.
   Exists today: action.server in the event schema, mcp-discovery and
   unpinned-mcp-server logic (red-team.js:549+,
   model-provenance-analyzer.js:20-23), kolm's own MCP gateway as a
   reference shape (src/mcp-gateway.js).

2. Egress Allowlist Attestation
   Pitch: declare your approved sub-processor destinations once; every
   re-attestation verifies all observed egress stayed inside the declared
   set and flags any new host the day it appears.
   Tier: Continuous ($299/$999 per month); the declaration itself ships in
   the $750 report.
   Exists today: host extraction at ingest (audit-ingest.js:386-390),
   allowlist matchers (red-team.js:131-140, rag-memory-analyzer.js:109-133),
   drift webhooks (asr-fulfillment.js:451-462). Directly closes GAP-1.

3. Active Injection Battery (consented)
   Pitch: the same fourteen probe ids, exercised for real against your
   staging agent through the kolm gateway, merged into the signed red_team
   block as grade-A evidence.
   Tier: this IS the Deep Red-Team (+$10,000) deliverable.
   Exists today: gateway call transport (wrapper-cli.js:640-860), probe
   vocabulary (red-team.js:454-631), prompt corpus
   (src/adversarial-prompts.js). Closes GAP-5.

4. Coverage Declaration (signed log-completeness statement)
   Pitch: the vendor signs what window and systems the export covers; the
   statement is bound into the envelope so a curated slice is a detectable
   misrepresentation, not a silent gap.
   Tier: included in Signed Readiness Report ($750) and above.
   Exists today: canonicalization + envelope machinery
   (attestation-report-builder.js:127-150), evidence_tier slot
   (audit-orchestrator.js:98-142). Closes GAP-3.

5. Evidence-Grade Logging Shim
   Pitch: a tiny logger for Node / Python agents that emits the canonical
   AuditEvent shape with per-agent keys, declared grants, and a hash chain,
   lifting any customer from evidence tier C to tier B in an afternoon.
   Tier: free (funnel); it manufactures better paid audits and feeds the
   identity / delegation analyzers the fields they starve for.
   Exists today: the exact target schema and constructor
   (src/audit-event.js normalizeEvent), chain-link conventions
   (audit-ingest.js:393-394), tier-B grading logic
   (audit-orchestrator.js:132-135).

6. GRC Evidence Pack
   Pitch: one export the buyer's GRC team can file without rework: OSCAL
   assessment results, control-by-control evidence index, and a
   remediation table with severities and re-test status.
   Tier: Full Readiness ($15,000) and Continuous-Plus ($3,500/mo).
   Exists today: framework crosswalk (src/control-mapper.js asrCrosswalk),
   CSV/CEF/LEEF exporters (audit-export.js), GRC payload shapes
   (reg-grc-connectors.js), questionnaire autofill
   (src/questionnaire-autofill.js).

7. Buyer Portfolio Dashboard
   Pitch: the other side of the trust link - a security team tracks every
   AI vendor's readiness, deltas, and attestation freshness in one pane,
   with alerts when a vendor regresses or lapses.
   Tier: new buyer-side seat under Continuous ($999/mo shape); zero new
   engine work, pure read surface.
   Exists today: trust-link resolution with lapsed/stale banners
   (audit-routes.js:1375-1445), report listing (audit-routes.js:1096),
   signed deltas (audit-delta.js), view logging (recordTrustView).

8. Sub-Processor Inventory Report
   Pitch: a signed enumeration of every model, provider, gateway, host,
   and MCP server your agents actually touched - the artifact vendor-risk
   teams currently rebuild by hand from questionnaires.
   Tier: included as a section of the Signed Readiness Report ($750);
   strong standalone sales page.
   Exists today: models / providers / mcp_servers arrays from the
   provenance analyzer, distinct_hosts from ingest stats
   (audit-ingest.js:884-896), routed_provider preservation
   (audit-ingest.js:386-390).

9. Fix Verification Re-Test
   Pitch: after a blocking finding, a focused re-run over a fresh window
   that signs the specific finding's resolution and links both report ids
   in one delta.
   Tier: fits Continuous ($299/$999 per month) as the on-demand tick; for
   one-time report buyers it is the natural follow-on purchase of a second
   $750 report with the delta included.
   Exists today: computeAuditDelta finding keys (audit-delta.js:59-85),
   deploy-hook force re-attest (audit-routes.js:1356-1366), delta endpoint
   (audit-routes.js:823).

10. Memory Integrity Ledger
    Pitch: hash-chain every memory write your agent makes and let the
    audit prove no stored memory was altered between writes - the
    poisoning evidence ASR-7 currently has to mark untested.
    Tier: Full Readiness ($15,000) add-on scope; Continuous keeps it fresh.
    Exists today: memory-op detection (rag-memory-analyzer.js:34-42),
    merkle tooling (src/merkle.js), capture store with receipts
    (src/capture-store.js, gateway receipt rows in
    audit-ingest.js:654-712).

---

## 4. Sequencing recommendation (one line each)

Close GAP-1 and GAP-2 before any new selling motion: they are the two ways
a signed report can be wrong rather than merely incomplete. GAP-8 is a
one-sentence copy fix and should ship immediately. Offers 2, 4, and 5 are
the highest leverage because each one upgrades the evidence the existing
paid tiers already sell; offer 3 finally gives the most expensive line item
a code path; offer 7 is the only one that opens a second revenue side
without touching the engine.
