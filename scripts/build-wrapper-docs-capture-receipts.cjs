#!/usr/bin/env node
/**
 * build-wrapper-docs-capture-receipts.cjs
 *
 * Generates the 12 Wrapper-surface documentation pages under:
 *   public/docs/capture/   (7 pages)
 *   public/docs/receipts/  (5 pages)
 *
 * Voice: terse, technical, definite. Cool slate aesthetic only.
 * Uses the standard /design-tokens.css + /ks.css + /warm-paper.css cascade.
 * No emojis. No banned wording.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_DIR = path.join(ROOT, 'public', 'docs', 'capture');
const RECEIPTS_DIR = path.join(ROOT, 'public', 'docs', 'receipts');

// ---------- shared page shell ----------------------------------------------

function pageShell({ slug, family, title, description, eyebrow, h1, lede, sections, related }) {
  const canonical = `https://kolm.ai/docs/${family}/${slug}`;
  const fullTitle = `${title} · Wrapper docs · kolm.ai`;
  const body = sections.map(renderSection).join('\n');
  const relatedHTML = (related && related.length)
    ? `<p class="muted" style="margin-top:48px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--ink-3)">See also: ${related.map(r => `<a href="${r.href}">${r.label}</a>`).join(' &middot; ')}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${escAttr(description)}">
<meta name="theme-color" content="#f3f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1116" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/design-tokens.css">
<link rel="stylesheet" href="/ks.css">
<link rel="stylesheet" href="/warm-paper.css">
<script src="/nav.js" defer></script>
<style>
  .wd-hero { padding-top: clamp(72px, 9vw, 128px); padding-bottom: clamp(40px, 6vw, 72px); border-bottom: 1px solid var(--line-1); }
  .wd-hero h1 { font-size: clamp(34px, 4.6vw, 52px); font-weight: 580; letter-spacing: -0.02em; margin: 14px 0 18px; max-width: 22ch; }
  .wd-body { padding: 48px 0 96px; }
  .wd-body h2 { font-size: 22px; font-weight: 540; margin: 40px 0 12px; letter-spacing: -0.01em; color: var(--ink-1); }
  .wd-body h3 { font-size: 16px; font-weight: 580; margin: 24px 0 8px; letter-spacing: -0.005em; color: var(--ink-1); }
  .wd-body p, .wd-body li { font-size: 15px; line-height: 1.7; color: var(--ink-2); max-width: 76ch; }
  .wd-body ul, .wd-body ol { padding-left: 22px; }
  .wd-body li { margin: 4px 0; }
  pre { background: #06080a; border: 1px solid var(--line-1); border-radius: 8px; padding: 16px 18px; overflow-x: auto; font: 12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color: #e9eef3; max-width: 820px; margin: 12px 0 18px; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size: 13px; background: rgba(127,140,158,0.10); padding: 1px 6px; border-radius: 4px; color: var(--ink-1); }
  table { border-collapse: collapse; width: 100%; max-width: 820px; margin: 14px 0 20px; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line-1); vertical-align: top; color: var(--ink-2); }
  th { color: var(--ink-1); font-weight: 540; font-size: 12.5px; }
  .wd-caveat { padding: 16px 18px; border: 1px dashed var(--line-1); border-radius: 8px; font-size: 13.5px; color: var(--ink-2); line-height: 1.6; margin: 20px 0; max-width: 76ch; }
  .wd-caveat b { color: var(--ink-1); font-weight: 580; }
  .wd-cta-row { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0 10px; }
  .wd-cta { display: inline-block; padding: 9px 16px; border: 1px solid var(--line-1); border-radius: 6px; color: var(--ink-1); text-decoration: none; font-size: 14px; font-weight: 500; }
  .wd-cta.primary { background: var(--ink-1); color: var(--surface-0); border-color: var(--ink-1); }
  .wd-cta:hover { border-color: var(--ink-1); }
  .wd-crumbs { font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size: 12px; color: var(--ink-3); margin-bottom: 6px; }
  .wd-crumbs a { color: var(--ink-3); text-decoration: none; }
  .wd-crumbs a:hover { color: var(--ink-1); }
</style>
</head>
<body class="ks">
<a href="#main" class="ks-skip">Skip to content</a>

<div class="ks-nav-wrap">
  <nav class="ks-nav" aria-label="Primary">
    <a href="/" class="ks-nav__brand"><span class="ks-nav__mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" role="img" aria-label="kolm"><rect x="4" y="6" width="4.5" height="20" rx="0.4"/><rect x="13" y="9" width="4.5" height="14" rx="0.4"/><rect x="22" y="12" width="4.5" height="8" rx="0.4"/></svg></span><span>kolm<b>.ai</b></span></a>
    <ul class="ks-nav__list">
      <li><a href="/wrapper">Wrapper</a></li>
      <li><a href="/studio">Studio</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="/docs">Docs</a></li>
      <li><a href="https://github.com/kolm-ai/kolm" rel="noopener">GitHub</a></li>
    </ul>
    <div class="ks-nav__right">
      <a href="/signup?intent=login" class="ks-nav__signin">Sign in</a>
      <a href="/signup" class="ks-btn ks-btn--primary ks-btn--sm">Get started <span class="ks-btn-arrow">-&gt;</span></a>
    </div>
  </nav>
</div>

<main id="main">

<section class="wd-hero">
  <div class="ks-wrap">
    <p class="wd-crumbs"><a href="/docs">docs</a> / <a href="/docs/${family}/overview">${family}</a> / ${slug}</p>
    <p class="brand-eyebrow">${escHTML(eyebrow)}</p>
    <h1>${escHTML(h1)}</h1>
    <p class="lede">${lede}</p>
  </div>
</section>

<section class="wd-body">
  <div class="ks-wrap">
${body}
    ${relatedHTML}
  </div>
</section>

</main>

<footer class="ks-foot">
  <div class="ks-wrap">
    <p>&copy; 2026 kolm.ai &middot; Apache-2.0 &middot; Made with .kolm &middot; <a href="mailto:rodneyyesep@gmail.com">rodneyyesep@gmail.com</a></p>
  </div>
</footer>

</body>
</html>
`;
}

function renderSection(s) {
  const parts = [];
  if (s.h2) parts.push(`    <h2>${escHTML(s.h2)}</h2>`);
  if (s.paragraphs) for (const p of s.paragraphs) parts.push(`    <p>${p}</p>`);
  if (s.list) {
    const tag = s.ordered ? 'ol' : 'ul';
    parts.push(`    <${tag}>`);
    for (const li of s.list) parts.push(`      <li>${li}</li>`);
    parts.push(`    </${tag}>`);
  }
  if (s.code) parts.push(`    <pre>${escHTML(s.code)}</pre>`);
  if (s.table) parts.push(renderTable(s.table));
  if (s.caveat) parts.push(`    <div class="wd-caveat"><b>${escHTML(s.caveatLabel || 'Caveats.')}</b> ${s.caveat}</div>`);
  if (s.subsections) for (const sub of s.subsections) parts.push(renderSubsection(sub));
  return parts.join('\n');
}

function renderSubsection(sub) {
  const parts = [];
  if (sub.h3) parts.push(`    <h3>${escHTML(sub.h3)}</h3>`);
  if (sub.paragraphs) for (const p of sub.paragraphs) parts.push(`    <p>${p}</p>`);
  if (sub.list) {
    const tag = sub.ordered ? 'ol' : 'ul';
    parts.push(`    <${tag}>`);
    for (const li of sub.list) parts.push(`      <li>${li}</li>`);
    parts.push(`    </${tag}>`);
  }
  if (sub.code) parts.push(`    <pre>${escHTML(sub.code)}</pre>`);
  if (sub.table) parts.push(renderTable(sub.table));
  return parts.join('\n');
}

function renderTable(t) {
  const head = `      <thead><tr>${t.headers.map(h => `<th>${escHTML(h)}</th>`).join('')}</tr></thead>`;
  const body = t.rows.map(r => `      <tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `    <table>\n${head}\n      <tbody>\n${body}\n      </tbody>\n    </table>`;
}

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escHTML(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------- capture pages ---------------------------------------------------

const CAPTURE_PAGES = [
  {
    slug: 'overview',
    title: 'Capture lake overview',
    description: 'The capture lake is the append-only, hash-chained record of every gateway call. Four storage backends, one schema, tamper-evident by construction.',
    eyebrow: 'Capture lake',
    h1: 'Every call, captured. Every row, chained.',
    lede: 'The capture lake is an append-only ledger of every request that walks the wrapper pipeline. Same schema across four storage backends, HMAC-SHA256 hash-chained between rows, indexed by tenant + namespace + timestamp.',
    sections: [
      {
        h2: 'What the lake is',
        paragraphs: [
          'The capture lake is the storage layer behind pipeline stage 9. Every request that completes the pipeline produces one capture row containing the redacted prompt, the response, the routing decision, the cost, the receipt CID, and a hash chain link to the previous row.',
          'The lake is the seed dataset for distillation, the truth set for bake-offs, the audit record for compliance reviews, and the input to the active-learning loop. One write path; many readers.',
        ],
      },
      {
        h2: 'The four storage backends',
        paragraphs: [
          'All four backends share the same row schema and the same hash-chain construction. Pick the backend that matches the volume and the operational model you already run.',
        ],
        table: {
          headers: ['Backend', 'Best for', 'Throughput', 'Compaction'],
          rows: [
            ['<code>jsonl</code>', 'Dev, single-host, &lt;100 req/s', 'High (append-only file)', 'Manual rotate'],
            ['<code>sqlite</code>', 'Single-node prod, &lt;500 req/s', 'High', 'VACUUM nightly'],
            ['<code>postgres</code>', 'Multi-node, queryable', 'Medium', 'TimescaleDB recommended'],
            ['<code>s3</code>', 'Long-term retention, audit export', 'Streaming', 'S3 lifecycle to Glacier'],
          ],
        },
      },
      {
        h2: 'Why hash-chained',
        paragraphs: [
          'Each row carries the HMAC-SHA256 of (previous_hash, row_bytes) using the tenant signing key. A single mutated byte anywhere in history breaks the chain and is detected by <code>kolm captures verify-chain</code> in O(n). The chain is independent of the storage backend; you can dump JSONL, reload into Postgres, re-verify, and get the same result.',
          'See <a href="/docs/capture/hash-chain">hash-chain</a> for the construction details and the verifier walkthrough.',
        ],
      },
      {
        h2: 'Row schema (summary)',
        paragraphs: [
          'Each capture row is a single JSON document. The schema is stable; new fields are additive. The receipt CID links the row to the signed audit receipt (see <a href="/docs/receipts/format">receipt format</a>).',
        ],
        table: {
          headers: ['Field', 'Type', 'Purpose'],
          rows: [
            ['<code>capture_id</code>', 'string', 'ULID (sortable, unique).'],
            ['<code>tenant_id</code>', 'string', 'Owning tenant.'],
            ['<code>namespace_id</code>', 'string', 'Routing scope.'],
            ['<code>timestamp</code>', 'RFC 3339', 'Pipeline completion time, UTC.'],
            ['<code>prompt</code>', 'object', 'Possibly-redacted request body.'],
            ['<code>response</code>', 'object', 'Provider response body.'],
            ['<code>provider</code>', 'string', 'Slug that handled the call.'],
            ['<code>model</code>', 'string', 'Model identifier.'],
            ['<code>route_decision</code>', 'string', 'pinned / fallback / student / teacher.'],
            ['<code>tokens_in</code>', 'int', 'Input token count.'],
            ['<code>tokens_out</code>', 'int', 'Output token count.'],
            ['<code>cost_usd</code>', 'float', 'Computed at receipt time.'],
            ['<code>receipt_cid</code>', 'string', 'Pointer to the signed receipt.'],
            ['<code>redaction</code>', 'object', 'Mode + detection annotations.'],
            ['<code>state</code>', 'enum', 'pending / approved / rejected / quarantined.'],
            ['<code>prev_hash</code>', 'hex', 'Hash link to previous row.'],
            ['<code>row_hash</code>', 'hex', 'HMAC-SHA256 of this row.'],
          ],
        },
      },
      {
        h2: 'Three downstream consumers',
        list: [
          '<b>Distillation</b> &mdash; <code>kolm distill</code> reads approved captures as the teacher-labeled seed set.',
          '<b>Bake-off</b> &mdash; <code>kolm bakeoff</code> replays captures across providers to score alternatives on real traffic.',
          '<b>Audit</b> &mdash; <code>kolm receipts verify</code> walks the chain and re-derives every row hash.',
        ],
      },
      {
        h2: 'Why append-only',
        paragraphs: [
          'Rows are never updated in place. Approval transitions (pending &rarr; approved / rejected / quarantined) write a new state row that supersedes the old one for the same <code>capture_id</code>; the original row stays in the chain. The same is true for retention deletion &mdash; the chain records the tombstone, not the absence.',
        ],
        caveat: 'The hash chain protects integrity, not confidentiality. The lake stores prompts and responses in cleartext by default. If your workload contains regulated data, enable redaction mode <code>redact_captures</code> or <code>redact_all</code> (see <a href="/docs/capture/redaction">redaction</a>) so the cleartext never reaches the lake.',
      },
    ],
    related: [
      { href: '/docs/capture/hash-chain', label: 'Hash chain' },
      { href: '/docs/capture/approval', label: 'Approval workflow' },
      { href: '/docs/capture/redaction', label: 'Redaction' },
      { href: '/docs/capture/export', label: 'Export' },
    ],
  },

  {
    slug: 'approval',
    title: 'Capture approval workflow',
    description: 'The pending / approved / rejected / quarantined state machine. Bulk approve 1000 rows in under two seconds.',
    eyebrow: 'Capture approval',
    h1: 'Approve at scale. Reject deliberately. Quarantine on signal.',
    lede: 'Every capture lands in <code>pending</code>. From there it transitions to <code>approved</code>, <code>rejected</code>, or <code>quarantined</code> &mdash; manually, via bulk verbs, or automatically when a poisoning signal fires.',
    sections: [
      {
        h2: 'The four states',
        table: {
          headers: ['State', 'Meaning', 'Eligible for distillation?'],
          rows: [
            ['<code>pending</code>', 'Just captured; awaiting review or auto-rule.', 'No'],
            ['<code>approved</code>', 'Reviewed; OK to use as a teacher-labeled seed.', 'Yes'],
            ['<code>rejected</code>', 'Reviewed; not OK (off-topic, low quality, sensitive).', 'No'],
            ['<code>quarantined</code>', 'Auto-flagged by a poisoning detector. Awaits override.', 'No (until released)'],
          ],
        },
      },
      {
        h2: 'State transitions',
        paragraphs: [
          'The state machine is forward-only with one exception: <code>quarantined &rarr; approved</code> is allowed after a manual override that records the operator id and reason. Transitions are themselves capture-lake rows so the audit trail is complete.',
        ],
        code: `pending --(approve)----------> approved
pending --(reject)-----------> rejected
pending --(poison detected)--> quarantined
quarantined --(release)------> approved        (logged with operator + reason)
quarantined --(reject)-------> rejected`,
      },
      {
        h2: 'CLI verbs',
        paragraphs: [
          'Three verbs cover the daily flow. Each accepts one or more capture ids, a glob, a namespace filter, or stdin.',
        ],
        code: `# Approve specific rows
kolm captures approve cap_01HXYZ... cap_01HXYW...

# Approve all pending in a namespace, last 7 days
kolm captures approve --namespace customer-support --since 7d --state pending

# Reject with a reason (stored on the transition row)
kolm captures reject cap_01HXYZ... --reason "off-topic: weather query"

# Quarantine (manual; usually auto-fired by the poisoning detector)
kolm captures quarantine cap_01HXYZ... --reason "suspected prompt injection"

# Release a quarantined row back to pending (or directly to approved with --approve)
kolm captures release cap_01HXYZ... --reason "false positive: legitimate test"`,
      },
      {
        h2: 'Bulk approval performance',
        paragraphs: [
          'Bulk approve is the hot path. The gateway batches transition writes inside a single transaction per backend; the chain link is computed once per batch. On Postgres with a warm connection pool, 1000 rows complete in under two seconds; on SQLite, under three; on JSONL, under one.',
        ],
        code: `# Approve 1000 rows from a saved query
kolm captures query \\
  --namespace customer-support \\
  --state pending \\
  --since 24h \\
  --limit 1000 \\
  --json | jq -r '.[].capture_id' | kolm captures approve --stdin

# Measured on a 2026-05 reference cluster:
#   postgres:   1000 rows / 1.84s
#   sqlite:     1000 rows / 2.71s
#   jsonl:      1000 rows / 0.92s`,
      },
      {
        h2: 'Review UI',
        paragraphs: [
          'The Account dashboard at <a href="/account/captures">/account/captures</a> shows the pending queue with prompt + response side by side, redaction annotations, the routing decision, and one-click approve / reject buttons. Keyboard shortcuts (<code>a</code> / <code>r</code> / <code>q</code> / <code>j</code> / <code>k</code>) match the CLI verbs for fast triage.',
        ],
      },
      {
        h2: 'Auto-approval rules',
        paragraphs: [
          'Per-namespace rules can promote captures to <code>approved</code> automatically. Common patterns: auto-approve when route decision is <code>teacher</code> and the response passed all poisoning checks; auto-approve when an external label (CRM ticket resolved = yes) crosses a webhook into the capture.',
        ],
        code: `[[namespace.auto_approve]]
namespace = "customer-support"
require   = ["route_decision == 'teacher'", "poison_score < 0.2", "tokens_out > 20"]
exclude   = ["redaction.hit_pii == true"]

# Webhook-driven external labels
[[namespace.external_label]]
namespace = "support-bot"
source    = "zendesk"
url       = "https://hooks.example.com/zendesk-resolved"
on_label  = "resolved"
action    = "approve"`,
        caveat: 'Auto-approval moves training-quality risk from review-time to rule-design-time. Spot-check the auto-approved queue weekly; if a rule lets through low-quality rows the student trained on them will inherit the same defect. The dashboard surfaces a sampled diff between auto-approved and human-approved K-Score on the held-out eval.',
      },
    ],
    related: [
      { href: '/docs/capture/overview', label: 'Capture overview' },
      { href: '/docs/capture/poisoning', label: 'Poisoning detection' },
      { href: '/docs/capture/redaction', label: 'Redaction' },
      { href: '/docs/capture/export', label: 'Export' },
    ],
  },

  {
    slug: 'redaction',
    title: 'PII redaction',
    description: 'Four redaction modes (detect_only, redact_captures, redact_all, block) and eleven detector classes for PII / PHI / financial identifiers.',
    eyebrow: 'Capture redaction',
    h1: 'Four modes, eleven detectors, one config.',
    lede: 'The gateway runs eleven detector classes against every prompt and response. The redaction mode controls what the upstream provider sees and what the capture lake stores. Per-namespace; reload at runtime.',
    sections: [
      {
        h2: 'The four modes',
        table: {
          headers: ['Mode', 'Forwarded to upstream', 'Stored in capture', 'Use case'],
          rows: [
            ['<code>detect_only</code>', 'Raw prompt', 'Raw prompt + detection annotations', 'Investigate exposure before enforcing.'],
            ['<code>redact_captures</code>', 'Raw prompt', 'Redacted copy', 'Default for regulated workloads.'],
            ['<code>redact_all</code>', 'Redacted prompt', 'Redacted copy', 'Maximum: model never sees PII either.'],
            ['<code>block</code>', '&mdash;', '&mdash;', 'Reject with HTTP 422; surface a privacy event.'],
          ],
        },
      },
      {
        h2: 'The eleven detector classes',
        paragraphs: [
          'Each detector returns a list of <code>(start, end, kind)</code> spans. Spans are merged when they overlap. The redaction replaces each span with the configured template (default <code>[REDACTED:{kind}]</code>).',
        ],
        table: {
          headers: ['Detector', 'Matches', 'Method'],
          rows: [
            ['<code>email</code>', 'RFC 5322 addresses.', 'Regex.'],
            ['<code>phone</code>', 'E.164 + common national formats (US/UK/EU/IN/CN/BR).', 'Regex + libphonenumber confirm.'],
            ['<code>ssn</code>', 'US Social Security Numbers (XXX-XX-XXXX).', 'Regex + Luhn-like check.'],
            ['<code>credit_card</code>', 'PAN, 13&ndash;19 digits.', 'Regex + Luhn checksum.'],
            ['<code>ip</code>', 'IPv4 and IPv6 addresses.', 'Regex.'],
            ['<code>url</code>', 'http(s):// URLs.', 'Regex.'],
            ['<code>name</code>', 'Person names.', 'spaCy NER (en_core_web_sm).'],
            ['<code>address</code>', 'US/UK street addresses.', 'libpostal expansion + regex.'],
            ['<code>mrn</code>', 'Medical Record Numbers.', 'Regex (configurable per institution).'],
            ['<code>npi</code>', 'US National Provider Identifier (10 digits).', 'Regex + Luhn checksum.'],
            ['<code>dea</code>', 'US DEA registration numbers.', 'Regex + checksum.'],
          ],
        },
      },
      {
        h2: 'Per-namespace configuration',
        paragraphs: [
          'Each namespace declares its own redaction mode and the subset of detectors that apply. A finance namespace probably needs all of <code>credit_card</code>, <code>ssn</code>, <code>name</code>; a healthcare namespace adds <code>mrn</code>, <code>npi</code>, <code>dea</code>. The defaults are conservative (all detectors enabled).',
        ],
        code: `[[namespace]]
name = "finance-bot"
primary = "openai/gpt-4o"

[namespace.redaction]
mode         = "redact_captures"
patterns     = ["email", "phone", "ssn", "credit_card", "name", "address"]
replace_with = "[REDACTED:{kind}]"

[[namespace]]
name = "clinical-notes"
primary = "anthropic/claude-sonnet-4-5"

[namespace.redaction]
mode         = "redact_all"
patterns     = ["email", "phone", "ssn", "name", "address", "mrn", "npi", "dea"]
replace_with = "[REDACTED:{kind}]"
on_unredactable = "block"   # if a detector confidence is below threshold, block instead of forward`,
      },
      {
        h2: 'What gets annotated in detect_only',
        paragraphs: [
          'When mode is <code>detect_only</code>, the capture row stores the raw prompt plus a <code>redaction.detections[]</code> array. Each entry has the detector kind, the span, the matched substring, and a confidence score. Useful for measuring exposure before enforcing a redaction policy.',
        ],
        code: `# Example capture annotation, detect_only mode
{
  "redaction": {
    "mode": "detect_only",
    "hit_pii": true,
    "detections": [
      {"kind":"email","start":34,"end":56,"value":"alice@example.com","confidence":0.99},
      {"kind":"phone","start":78,"end":92,"value":"+1-415-555-1212","confidence":0.97}
    ]
  }
}`,
      },
      {
        h2: 'The block mode',
        paragraphs: [
          'Mode <code>block</code> short-circuits the pipeline before forwarding. The caller receives HTTP 422 with a body indicating which detectors fired and where. The capture lake records the rejection (no prompt body) so you have an audit trail of attempted exposures.',
        ],
        code: `# Caller sees:
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{
  "error": {
    "code": "kolm_pii_blocked",
    "message": "Request blocked: PII detected and namespace mode is 'block'.",
    "detections": [
      {"kind":"ssn","start":120,"end":131,"confidence":0.99}
    ],
    "doc": "https://kolm.ai/docs/capture/redaction#the-block-mode"
  }
}`,
      },
      {
        h2: 'Tuning detector precision',
        paragraphs: [
          'Each detector has a configurable confidence threshold. Raise the threshold to reduce false positives; lower it to reduce false negatives. The default thresholds are tuned for high recall (preferring over-redaction).',
        ],
        code: `[[namespace]]
name = "support-bot"

[namespace.redaction]
mode = "redact_captures"

[namespace.redaction.thresholds]
name    = 0.75   # spaCy NER for person names: raise to cut false positives on capitalized words
address = 0.85   # libpostal: raise to skip street-like phrases that are not addresses
phone   = 0.60   # libphonenumber: default conservative`,
        caveat: 'Redaction reduces but does not eliminate exposure. The detectors are recall-tuned; they miss novel patterns (obfuscated emails, image-embedded numbers, foreign-language names). Pair with the <a href="/docs/capture/poisoning">poisoning</a> signals and with provider-side data-processing agreements for regulated workloads. The gateway never logs the raw redacted spans &mdash; the detection annotations include the matched substring only when mode is <code>detect_only</code>.',
      },
    ],
    related: [
      { href: '/docs/capture/overview', label: 'Capture overview' },
      { href: '/docs/capture/poisoning', label: 'Poisoning detection' },
      { href: '/docs/capture/approval', label: 'Approval workflow' },
      { href: '/docs/capture/retention', label: 'Retention' },
    ],
  },

  {
    slug: 'poisoning',
    title: 'Poisoning detection',
    description: 'Five risk signals (output length anomaly, embedding anomaly, injection pattern, inconsistent labels, synthetic spam) with an auto-quarantine threshold.',
    eyebrow: 'Capture poisoning',
    h1: 'Five signals, one quarantine threshold.',
    lede: 'Five orthogonal detectors score every capture for poisoning risk. The aggregate score crosses a per-namespace threshold and the row is auto-quarantined. Manual override is recorded on the chain.',
    sections: [
      {
        h2: 'Why this matters',
        paragraphs: [
          'A capture lake feeds distillation. A poisoned capture &mdash; whether by accident (a model hallucination) or by intent (a prompt injection that survived the input scan) &mdash; trains the next student on the wrong answer. Detection is cheap; quarantine is reversible; the cost of letting one through is amplified by every later iteration.',
        ],
      },
      {
        h2: 'The five signals',
        table: {
          headers: ['Signal', 'What it measures', 'Cost'],
          rows: [
            ['<code>output_length_anomaly</code>', 'Response length is &gt;3 sigma from the per-prompt-template mean.', 'Cheap (statistics).'],
            ['<code>embedding_anomaly</code>', 'Response embedding is &gt;3 sigma from the per-prompt-template cluster centroid.', 'Medium (one embedding call).'],
            ['<code>injection_pattern</code>', 'Response contains canary phrases ("ignore previous", "system prompt was").', 'Cheap (regex + classifier).'],
            ['<code>inconsistent_labels</code>', 'Response classification disagrees with the user-attached label (when present).', 'Cheap (string compare).'],
            ['<code>synthetic_spam</code>', 'Response shows signatures of being LLM-generated rather than human-written (when the application expects human).', 'Medium (classifier).'],
          ],
        },
      },
      {
        h2: 'Score aggregation',
        paragraphs: [
          'Each signal returns a score in [0, 1]. The aggregate poison score is the weighted maximum: <code>score = max(weight_i &times; signal_i)</code>. The weights default to 1.0; configure per-namespace to emphasize a specific risk.',
        ],
        code: `# Defaults
[capture.poisoning]
auto_quarantine_threshold = 0.7
weights.output_length_anomaly = 1.0
weights.embedding_anomaly     = 1.0
weights.injection_pattern     = 1.0
weights.inconsistent_labels   = 1.0
weights.synthetic_spam        = 1.0

# Per-namespace override (e.g. RAG namespace cares most about injection)
[[namespace.poisoning]]
namespace = "rag-pipeline"
weights.injection_pattern = 1.5
weights.embedding_anomaly = 1.2
auto_quarantine_threshold = 0.6`,
      },
      {
        h2: 'Auto-quarantine threshold',
        paragraphs: [
          'When <code>score &gt;= auto_quarantine_threshold</code>, the capture transitions from <code>pending</code> to <code>quarantined</code> and the operator dashboard surfaces it. The default threshold of 0.7 is tuned for low false-quarantine rate on the W411 reference dataset; lower to be stricter, raise to be more permissive.',
        ],
      },
      {
        h2: 'What a quarantined row looks like',
        code: `# Quarantine annotation on a capture row
{
  "state": "quarantined",
  "poison": {
    "score": 0.91,
    "signals": {
      "output_length_anomaly": 0.42,
      "embedding_anomaly": 0.18,
      "injection_pattern": 0.91,
      "inconsistent_labels": 0.0,
      "synthetic_spam": 0.12
    },
    "trigger": "injection_pattern",
    "matched_canary": "ignore the previous instructions"
  }
}`,
      },
      {
        h2: 'Manual override',
        paragraphs: [
          'A reviewer can release a quarantined row back to <code>pending</code> (or directly to <code>approved</code>). The override writes a new chain row recording the operator id, the reason, and the original poison score for the audit trail.',
        ],
        code: `kolm captures release cap_01HXYZ... --reason "false positive: canary in legitimate docs"
kolm captures release cap_01HXYZ... --approve --reason "reviewed, OK to train on"

# List quarantined rows for a namespace
kolm captures list --namespace customer-support --state quarantined --limit 50

# Stats: what fired this week
kolm captures poison-stats --namespace customer-support --since 7d
# signal               fires   share  median_score
# injection_pattern      142   62%       0.88
# output_length_anomaly   58   25%       0.74
# embedding_anomaly       21    9%       0.81
# inconsistent_labels      8    3%       0.92
# synthetic_spam           1   <1%       0.71`,
      },
      {
        h2: 'Configuring the canary list',
        paragraphs: [
          'The <code>injection_pattern</code> signal uses a default canary list shipped with the gateway. Add or remove patterns per namespace; the matched phrase is recorded on the row so post-hoc analysis is straightforward.',
        ],
        code: `[capture.poisoning.canaries]
phrases = [
  "ignore the previous",
  "ignore previous instructions",
  "system prompt was",
  "you are now",
  "disregard the above",
  "new instructions:",
  "[INST]",
  "###",
]
case_sensitive = false
window_chars   = 200          # match only in first/last 200 chars of response`,
        caveat: 'Poison signals are heuristic, not proof. The aggregate score has a documented false-positive rate of ~3% at threshold 0.7 on the W411 reference dataset; on your traffic it may be higher or lower. Review the quarantine queue weekly; promote false positives back so you do not lose training data. The signals do not prove an attack happened, only that the row looks anomalous.',
      },
    ],
    related: [
      { href: '/docs/capture/approval', label: 'Approval workflow' },
      { href: '/docs/capture/redaction', label: 'Redaction' },
      { href: '/docs/capture/overview', label: 'Capture overview' },
      { href: '/docs/capture/export', label: 'Export' },
    ],
  },

  {
    slug: 'export',
    title: 'Capture export',
    description: 'Export approved captures as JSONL, Parquet, or a HuggingFace datasets directory. Per-namespace and date-range filters.',
    eyebrow: 'Capture export',
    h1: 'Three formats, one verb, deterministic output.',
    lede: '<code>kolm captures export</code> dumps the lake (or a filtered slice of it) as JSONL, Parquet, or a HuggingFace datasets directory. Same row schema across formats; byte-identical between runs for the same filter.',
    sections: [
      {
        h2: 'The three formats',
        table: {
          headers: ['Format', 'Use case', 'Tooling', 'Compression'],
          rows: [
            ['<code>jsonl</code>', 'Streaming pipelines, jq, simple inspection.', 'Any.', 'gzip on the fly with <code>--gzip</code>.'],
            ['<code>parquet</code>', 'Columnar analytics, DuckDB, Spark.', 'pyarrow, duckdb.', 'Snappy by default.'],
            ['<code>hf-dataset</code>', 'Direct feed into HuggingFace <code>datasets</code>.', 'datasets, transformers.', 'Arrow + dataset_info.json.'],
          ],
        },
      },
      {
        h2: 'Filters',
        paragraphs: [
          'Filters compose. The exporter walks the lake in <code>capture_id</code> order, applies filters in the storage backend where possible (Postgres / SQLite push down WHERE clauses; JSONL / S3 stream-filter), and writes the matching rows.',
        ],
        table: {
          headers: ['Flag', 'Effect'],
          rows: [
            ['<code>--namespace &lt;name&gt;</code>', 'Limit to one namespace; repeat for multiple.'],
            ['<code>--state &lt;state&gt;</code>', 'Filter by state (default: <code>approved</code>).'],
            ['<code>--since &lt;duration&gt;</code>', 'Captures newer than the duration (e.g. <code>7d</code>, <code>30d</code>).'],
            ['<code>--until &lt;timestamp&gt;</code>', 'Captures before the timestamp (RFC 3339).'],
            ['<code>--provider &lt;slug&gt;</code>', 'Only captures handled by a specific provider.'],
            ['<code>--model &lt;name&gt;</code>', 'Only captures for a specific model.'],
            ['<code>--route &lt;decision&gt;</code>', 'Filter by route decision (pinned / fallback / student / teacher).'],
            ['<code>--limit &lt;n&gt;</code>', 'Cap at N rows; useful for sampling.'],
          ],
        },
      },
      {
        h2: 'Examples',
        code: `# JSONL export of all approved support captures, last 30 days
kolm captures export \\
  --format jsonl \\
  --namespace customer-support \\
  --state approved \\
  --since 30d \\
  --out ./support-2026-04.jsonl

# Parquet, multiple namespaces, gzip not needed (Snappy default)
kolm captures export \\
  --format parquet \\
  --namespace customer-support \\
  --namespace billing-bot \\
  --since 90d \\
  --out ./multi-2026-Q2.parquet

# HuggingFace dataset directory, ready for datasets.load_from_disk
kolm captures export \\
  --format hf-dataset \\
  --namespace customer-support \\
  --since 30d \\
  --route teacher \\
  --out ./hf-support-teacher-2026-04/

# Streaming JSONL to stdout for piping into jq
kolm captures export --format jsonl --namespace customer-support --since 1d --out - | jq '.cost_usd' | datamash sum 1`,
      },
      {
        h2: 'HuggingFace dataset layout',
        paragraphs: [
          'The <code>hf-dataset</code> output is a directory with an Arrow table and a <code>dataset_info.json</code> describing the schema. Load directly with <code>datasets.load_from_disk</code>; push to the hub with <code>dataset.push_to_hub</code>.',
        ],
        code: `# Directory layout
./hf-support-teacher-2026-04/
  dataset_info.json
  state.json
  data-00000-of-00003.arrow
  data-00001-of-00003.arrow
  data-00002-of-00003.arrow

# Load in Python
from datasets import load_from_disk
ds = load_from_disk("./hf-support-teacher-2026-04/")
print(ds)
# Dataset({
#   features: ['capture_id', 'prompt', 'response', 'model', 'route_decision', ...],
#   num_rows: 14820
# })`,
      },
      {
        h2: 'What the exporter omits',
        paragraphs: [
          'The exporter never writes the raw signing key, the upstream provider credentials, or the chain hashes (those are lake-internal). The receipt CID is included so any consumer can re-fetch the signed receipt from <code>/v1/receipts/&lt;cid&gt;</code> if needed.',
        ],
      },
      {
        h2: 'Determinism',
        paragraphs: [
          'For the same filter set against the same lake state, the exporter produces byte-identical JSONL and Arrow output. Row order is <code>capture_id</code> ascending; field order in JSONL is fixed. Parquet bytes can vary across pyarrow versions; pin the version in CI for reproducibility.',
        ],
        caveat: 'Export reflects lake state at the moment the export runs. If new captures land mid-export, they are not included even if they fall within the filter window; rerun for the latest. For large exports (&gt;10M rows) prefer <code>--format parquet</code>; JSONL is fine for under that, but the file size grows linearly with row size.',
      },
    ],
    related: [
      { href: '/docs/capture/approval', label: 'Approval workflow' },
      { href: '/docs/capture/retention', label: 'Retention' },
      { href: '/docs/capture/overview', label: 'Capture overview' },
      { href: '/docs/receipts/audit-export', label: 'Receipt audit export' },
    ],
  },

  {
    slug: 'hash-chain',
    title: 'Capture hash chain',
    description: 'HMAC-SHA256 linkage between consecutive capture rows. Tamper detection in O(n). kolm captures verify-chain re-derives every row.',
    eyebrow: 'Capture hash chain',
    h1: 'Tamper-evident by construction.',
    lede: 'Every capture row carries an HMAC-SHA256 hash that links it to the previous row. Any single-byte mutation anywhere in history breaks the chain; <code>kolm captures verify-chain</code> finds the break in O(n).',
    sections: [
      {
        h2: 'The construction',
        paragraphs: [
          'Each row stores two hashes: <code>prev_hash</code> (the previous row’s <code>row_hash</code>, or the genesis seed for the first row) and <code>row_hash</code> (HMAC-SHA256 over the canonical serialization of this row, keyed by the tenant signing key).',
        ],
        code: `# Genesis seed (per tenant, set at lake init)
genesis = HMAC-SHA256(tenant_key, "kolm-capture-genesis-v1" || tenant_id)

# Per-row computation
row_bytes = canonical_json(row_minus_hash_fields)
row_hash  = HMAC-SHA256(tenant_key, prev_hash || row_bytes)

# Storage
row.prev_hash = previous_row.row_hash   # or genesis for the first row
row.row_hash  = row_hash`,
      },
      {
        h2: 'Why HMAC, not plain SHA',
        paragraphs: [
          'Plain SHA-256 is content-addressed: anyone with the row bytes can recompute the hash. HMAC-SHA256 binds the hash to the tenant key &mdash; an attacker who tampers with rows and recomputes plain hashes cannot do so for HMAC without the key. The hash chain is therefore both tamper-evident and tamper-resistant against an attacker who can write but cannot read the key file.',
          'The same key is used for the receipt Ed25519 signature in a different role; see <a href="/docs/receipts/signing">signing</a>. Compromise of one compromises the other.',
        ],
      },
      {
        h2: 'Canonical serialization',
        paragraphs: [
          'The row hash must be reproducible from the stored row. We canonicalize before HMAC: JSON keys sorted lexicographically, integers as <code>NumberLong</code> (no leading zeros), floats as RFC 8259 grisu3, no whitespace, UTF-8 NFC. The <code>row_hash</code> and <code>prev_hash</code> fields themselves are excluded from the canonical form so the hash describes the rest of the row.',
        ],
        code: `# Canonical form excerpt
{"capture_id":"01HXYZ...","cost_usd":0.000041,"model":"gpt-4o-mini","namespace_id":"customer-support","prompt":{...},"provider":"openai","receipt_cid":"bafy2bzace...","response":{...},"route_decision":"teacher","state":"approved","tenant_id":"tenant_xxx","timestamp":"2026-05-20T14:32:01Z","tokens_in":48,"tokens_out":120}`,
      },
      {
        h2: 'Verifying the chain',
        paragraphs: [
          'The <code>verify-chain</code> verb walks the lake in <code>capture_id</code> order, re-derives <code>row_hash</code> for each row, and compares against the stored value. The first mismatch is the tamper point; the verb reports it and exits non-zero.',
        ],
        code: `# Verify the full chain for a tenant
kolm captures verify-chain
# Walking 1,248,301 rows...
# OK: 1,248,301 rows hashed and linked.
# Genesis: a3f4...91c2
# Tip:     8e2b...f17a
# Elapsed: 14.2s

# Verify a slice (last 7 days)
kolm captures verify-chain --since 7d
# OK: 18,427 rows.

# Fail mode (simulated tampering)
kolm captures verify-chain --since 1d
# FAIL at row cap_01HXYZ... (#18019)
#   stored row_hash:  4f2a...09c1
#   derived row_hash: 88b1...e342
#   prev_hash chain:  4f2a... (matches previous row.row_hash)
#   diagnosis: row body was modified after capture; chain breaks here.
# Exit code: 2`,
      },
      {
        h2: 'Where the chain is verified',
        list: [
          '<b>Before export</b> &mdash; <code>kolm captures export --verify</code> walks the slice first and aborts on mismatch.',
          '<b>Before distill</b> &mdash; <code>kolm distill --verify-chain</code> refuses to use a slice that fails verification.',
          '<b>Scheduled audit</b> &mdash; the self-hosted gateway can be set to verify nightly and emit a telemetry event on failure.',
          '<b>External auditor</b> &mdash; the verb runs against a read-only replica with the tenant public key (verifier mode skips HMAC, validates by re-deriving over the canonical form).',
        ],
      },
      {
        h2: 'Genesis seed and key rotation',
        paragraphs: [
          'The genesis seed is fixed for the lifetime of the lake; it does not rotate with the signing key. When the signing key rotates (90-day cadence; see <a href="/docs/receipts/signing">signing</a>), new rows use the new key for HMAC and the chain stores a <code>key_id</code> on each row. <code>verify-chain</code> uses the correct key per row.',
        ],
        caveat: 'Hash chains protect against undetected mutation, not against deletion of the tail. An attacker who can truncate the file can roll back recent history; the verifier sees a shorter but internally consistent chain. Pair with off-site capture-id watermarks (e.g. nightly snapshot of <code>tip_capture_id</code> to S3 or to the public anchor at <a href="https://verify.kolm.ai">verify.kolm.ai</a>) so truncation is also detectable.',
      },
    ],
    related: [
      { href: '/docs/capture/overview', label: 'Capture overview' },
      { href: '/docs/capture/retention', label: 'Retention' },
      { href: '/docs/receipts/signing', label: 'Receipt signing' },
      { href: '/docs/receipts/verification', label: 'Receipt verification' },
    ],
  },

  {
    slug: 'retention',
    title: 'Capture retention',
    description: 'Per-namespace retention days, purge workflow, and the GDPR / CCPA right-to-erasure flow. Hash chain stays intact via tombstone rows.',
    eyebrow: 'Capture retention',
    h1: 'Retain only what you need. Purge on schedule.',
    lede: 'Each namespace declares a <code>retention_days</code>. The <code>kolm captures purge</code> verb removes rows older than the cutoff and writes tombstone rows so the hash chain stays intact. GDPR / CCPA right-to-erasure runs the same path with a specific subject filter.',
    sections: [
      {
        h2: 'Per-namespace retention',
        paragraphs: [
          'Retention is declared per namespace in <code>gateway.toml</code>. The default is unlimited (never purge); set explicitly for namespaces where you do not want to hold captures forever. A nightly scheduled job runs <code>kolm captures purge</code> for every namespace with a finite retention.',
        ],
        code: `[[namespace]]
name           = "customer-support"
primary        = "openai/gpt-4o"
retention_days = 365              # keep one year

[[namespace]]
name           = "dev-sandbox"
primary        = "openai/gpt-4o-mini"
retention_days = 7                # dev: keep one week

[[namespace]]
name           = "clinical-notes"
primary        = "anthropic/claude-sonnet-4-5"
retention_days = 1825             # five years (regulatory)`,
      },
      {
        h2: 'The purge verb',
        paragraphs: [
          'The purge verb removes rows older than <code>--before</code>. By default it dry-runs; pass <code>--apply</code> to commit. Removed rows are replaced with tombstone rows in the chain that preserve <code>capture_id</code>, <code>timestamp</code>, the reason for removal, and the hash linkage.',
        ],
        code: `# Dry-run: see what would be purged
kolm captures purge --namespace dev-sandbox --before 7d
# Would purge 4,218 rows from 'dev-sandbox' older than 2026-05-13T...
# Would write 4,218 tombstone rows.
# (no changes; pass --apply to commit)

# Apply
kolm captures purge --namespace dev-sandbox --before 7d --apply
# Purged 4,218 rows; wrote 4,218 tombstones; chain integrity preserved.

# Multiple namespaces at once
kolm captures purge --all-with-retention --apply
# (iterates every namespace that declared retention_days, purges to its cutoff)

# Specific date instead of duration
kolm captures purge --namespace customer-support --before 2025-05-13T00:00:00Z --apply`,
      },
      {
        h2: 'What a tombstone row looks like',
        code: `# Tombstone replaces the original row in the chain
{
  "capture_id": "cap_01HXYZ...",
  "timestamp":  "2025-05-12T14:32:01Z",
  "tombstone":  {
    "removed_at":   "2026-05-20T03:00:00Z",
    "reason":       "retention_purge",
    "policy":       "namespace:dev-sandbox retention_days=7",
    "operator":     "scheduler@self"
  },
  "prev_hash": "...",
  "row_hash":  "..."
}`,
      },
      {
        h2: 'GDPR / CCPA right-to-erasure',
        paragraphs: [
          'Right-to-erasure runs the same path with a subject filter. The operator supplies an identifier (email, account id, or PII span) and the verb removes every row that contains a match. The tombstone records the reason and the legal basis so the audit trail is preserved.',
        ],
        code: `# By exact subject identifier match in the prompt
kolm captures purge \\
  --subject "alice@example.com" \\
  --reason gdpr_erasure \\
  --policy "GDPR Article 17 request, ticket #2026-05-189" \\
  --apply

# Reports
# Found 142 rows containing the subject across 3 namespaces.
# Wrote 142 tombstones. Receipt CIDs of removed rows are listed below for downstream verifier sync.
#   bafy2bzaceabc... bafy2bzacedef... ... (142 entries)

# By detection class (any row where the email detector flagged this address)
kolm captures purge \\
  --subject-detection "email:alice@example.com" \\
  --reason gdpr_erasure \\
  --apply`,
      },
      {
        h2: 'What gets removed',
        list: [
          '<b>Prompt and response bodies</b> &mdash; cleared; not recoverable from the lake.',
          '<b>Cost, tokens, and routing decision</b> &mdash; preserved on the tombstone (these are not personal data and are needed for billing reconciliation).',
          '<b>Receipt CID</b> &mdash; preserved on the tombstone so downstream verifiers can update their references.',
          '<b>Hash linkage</b> &mdash; preserved; the chain still verifies.',
        ],
      },
      {
        h2: 'Downstream propagation',
        paragraphs: [
          'Erasure must propagate to any consumer that has a copy of the row. The CLI emits a list of removed receipt CIDs; pipe that into your dataset registry, training-job archive, and bake-off result store to remove derived references.',
        ],
        code: `# Erase + emit a JSON list of removed receipt CIDs
kolm captures purge --subject "alice@example.com" --reason gdpr_erasure --apply --json | jq '.removed_receipt_cids' > erasure-cids.json

# Apply downstream
kolm datasets erase --from-cids erasure-cids.json
kolm bakeoffs erase --from-cids erasure-cids.json
# (optional) sync to external warehouse
your-warehouse-tool erase --from-cids erasure-cids.json`,
        caveat: 'Right-to-erasure removes capture rows but cannot remove model weights that were trained on those rows. If a <code>.kolm</code> artifact was distilled from a dataset that included the erased rows, the artifact is still in scope for the request; rebuild from the post-erasure dataset and rotate the artifact. The CLI emits the list of impacted artifact ids so you can plan the rebuild.',
      },
    ],
    related: [
      { href: '/docs/capture/export', label: 'Export' },
      { href: '/docs/capture/hash-chain', label: 'Hash chain' },
      { href: '/docs/capture/overview', label: 'Capture overview' },
      { href: '/docs/capture/approval', label: 'Approval workflow' },
    ],
  },
];

// ---------- receipt pages ---------------------------------------------------

const RECEIPT_PAGES = [
  {
    slug: 'overview',
    title: 'Receipts overview',
    description: 'A receipt is the signed, verifiable record of one gateway call. One per call, kolm-audit-1 schema, Ed25519 signed.',
    eyebrow: 'Receipts',
    h1: 'One signed receipt per call. Verifiable forever.',
    lede: 'A receipt is the cryptographic record of one gateway call: who, when, what was asked, what was returned, which model, how much it cost, and the Ed25519 signature that proves none of it was tampered with after the fact.',
    sections: [
      {
        h2: 'What a receipt is',
        paragraphs: [
          'When a request finishes the wrapper pipeline, stage 8 computes a receipt and signs it with the tenant Ed25519 key. The receipt is stored on the capture row, returned to the caller as response header <code>X-Kolm-Receipt-CID</code>, and made fetchable at <code>https://kolm.ai/v1/receipts/&lt;cid&gt;</code>.',
          'The receipt is the unit of verifiability. Anyone with the tenant public key can fetch a receipt and confirm: this exact request was handled by this exact model at this exact time, the response bytes match the recorded hash, the cost was computed against this rate card.',
        ],
      },
      {
        h2: 'The schema name',
        paragraphs: [
          'Every receipt is tagged <code>schema: "kolm-audit-1"</code>. Future schema versions will bump the suffix and remain readable through verifier compatibility shims. See <a href="/docs/receipts/format">format</a> for the full 19-field reference.',
        ],
      },
      {
        h2: 'Receipt lifecycle',
        ordered: true,
        list: [
          'Pipeline stage 8 builds the receipt body from the in-progress call (provider, model, tokens, cost, route decision, redaction summary).',
          'The receipt body is canonicalized (sorted JSON, NFC) and signed with the tenant Ed25519 key.',
          'The receipt is stored on the capture row in the lake.',
          'The receipt CID is returned to the caller as <code>X-Kolm-Receipt-CID</code> header.',
          'A copy is fetchable at <code>/v1/receipts/&lt;cid&gt;</code> for the lifetime of the capture (subject to retention).',
        ],
      },
      {
        h2: 'What is signed',
        paragraphs: [
          'The signature covers every field in the receipt except the signature itself. That includes the input hash and the output hash, so any post-hoc edit to the prompt or response stored on the capture row breaks the receipt verification.',
        ],
      },
      {
        h2: 'Verify URL',
        paragraphs: [
          'The receipt body includes <code>verify_url</code> pointing to a public verification page. Paste a CID into <a href="https://verify.kolm.ai">verify.kolm.ai</a> and the page fetches the receipt, fetches the tenant public key from <code>/v1/keys/&lt;key_id&gt;</code>, and confirms the signature in the browser. Useful for sharing a receipt with an auditor who does not have the CLI installed.',
        ],
        code: `# Header on every response
X-Kolm-Receipt-CID: bafy2bzaceabcdefghijklmnopqrstuvwxyz1234567890

# Fetch the receipt body
curl -s https://kolm.ai/v1/receipts/bafy2bzaceabc... | jq .

# Verify on the public page
open https://verify.kolm.ai/?cid=bafy2bzaceabc...`,
      },
      {
        h2: 'What receipts enable',
        list: [
          '<b>Compliance audits</b> &mdash; export a slice of receipts for any reviewer (SOC 2, HIPAA, internal). They can verify without access to the lake.',
          '<b>Customer disputes</b> &mdash; "show me what the model actually told user X on date Y" answered by fetching the receipt CID for that capture.',
          '<b>Regulatory disclosure</b> &mdash; the receipt is the ground truth for any "what did the AI say" question.',
          '<b>Cost reconciliation</b> &mdash; the signed cost on the receipt is the source of truth for chargeback.',
        ],
        caveat: 'A receipt proves the call happened and the recorded fields are intact. It does not prove the upstream provider returned the answer correctly &mdash; the gateway records what it received, not whether the model was right. Pair with bake-offs (replay against another provider) and held-out evals for quality assurance.',
      },
    ],
    related: [
      { href: '/docs/receipts/format', label: 'Receipt format' },
      { href: '/docs/receipts/verification', label: 'Verification' },
      { href: '/docs/receipts/signing', label: 'Signing' },
      { href: '/docs/receipts/audit-export', label: 'Audit export' },
    ],
  },

  {
    slug: 'format',
    title: 'kolm-audit-1 receipt format',
    description: 'The 19-field kolm-audit-1 receipt schema reference. Every field, every type, every constraint.',
    eyebrow: 'Receipt format',
    h1: 'The kolm-audit-1 schema, field by field.',
    lede: 'The full reference for the 19-field <code>kolm-audit-1</code> receipt schema plus the Ed25519 signature block. Every field is required unless marked optional; every type is documented; every constraint is enforced at signing time.',
    sections: [
      {
        h2: 'Complete example',
        code: `{
  "schema": "kolm-audit-1",
  "receipt_id": "bafy2bzaceabcdefghijklmnopqrstuvwxyz1234567890",
  "timestamp": "2026-05-20T14:32:01.847Z",
  "namespace_id": "customer-support",
  "route_decision": "teacher",
  "provider": "openai",
  "model": "gpt-4o",
  "artifact_id": null,
  "confidence": 0.82,
  "fallback_reason": null,
  "input_hash": "sha256:9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3",
  "output_hash": "sha256:7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e",
  "capture_eligible": true,
  "capture_id": "cap_01HXYZABCDEFGHJKMNPQRSTVWX",
  "redaction_applied": "redact_captures",
  "input_tokens": 142,
  "output_tokens": 488,
  "cost_usd": 0.00834,
  "signing_key_id": "tenant_acme_v3",
  "verify_url": "https://verify.kolm.ai/?cid=bafy2bzaceabc...",
  "signature_ed25519": {
    "alg": "Ed25519",
    "key_id": "tenant_acme_v3",
    "value": "base64url:MEUCIQDx7s...kQ"
  }
}`,
      },
      {
        h2: 'Field reference',
        table: {
          headers: ['Field', 'Type', 'Required', 'Notes'],
          rows: [
            ['<code>schema</code>', 'string', 'Yes', 'Always <code>"kolm-audit-1"</code> for this version.'],
            ['<code>receipt_id</code>', 'string (CID)', 'Yes', 'Content-addressed id; multibase-base32 of SHA-256 over the unsigned body.'],
            ['<code>timestamp</code>', 'RFC 3339 UTC', 'Yes', 'Pipeline completion time; millisecond precision.'],
            ['<code>namespace_id</code>', 'string', 'Yes', 'Routing scope that handled the call.'],
            ['<code>route_decision</code>', 'enum', 'Yes', '<code>pinned</code> / <code>fallback</code> / <code>student</code> / <code>teacher</code>.'],
            ['<code>provider</code>', 'string', 'Yes', 'Provider slug that handled the call.'],
            ['<code>model</code>', 'string', 'Yes', 'Model identifier returned by the provider.'],
            ['<code>artifact_id</code>', 'string | null', 'Yes', 'Local <code>.kolm</code> artifact id if applicable; null for hosted providers.'],
            ['<code>confidence</code>', 'float [0,1] | null', 'Yes', 'Student first-token softmax confidence; null when not confidence-routed.'],
            ['<code>fallback_reason</code>', 'string | null', 'Yes', 'Why the fallback chain advanced; null when primary succeeded.'],
            ['<code>input_hash</code>', 'string', 'Yes', 'SHA-256 of canonical input body, prefixed <code>sha256:</code>.'],
            ['<code>output_hash</code>', 'string', 'Yes', 'SHA-256 of canonical output body, prefixed <code>sha256:</code>.'],
            ['<code>capture_eligible</code>', 'bool', 'Yes', 'Whether the namespace policy allows this call to be captured.'],
            ['<code>capture_id</code>', 'string | null', 'Yes', 'ULID of the capture row; null when <code>capture_eligible</code> is false.'],
            ['<code>redaction_applied</code>', 'enum', 'Yes', '<code>none</code> / <code>detect_only</code> / <code>redact_captures</code> / <code>redact_all</code>.'],
            ['<code>input_tokens</code>', 'int &ge; 0', 'Yes', 'Input token count, provider-reported when available.'],
            ['<code>output_tokens</code>', 'int &ge; 0', 'Yes', 'Output token count, provider-reported when available.'],
            ['<code>cost_usd</code>', 'float &ge; 0', 'Yes', 'Computed from the published rate card at signing time.'],
            ['<code>signing_key_id</code>', 'string', 'Yes', 'Key id used for the Ed25519 signature; resolves at <code>/v1/keys/&lt;id&gt;</code>.'],
            ['<code>verify_url</code>', 'string (URL)', 'Yes', 'Public verifier URL for this receipt CID.'],
          ],
        },
      },
      {
        h2: 'The signature block',
        paragraphs: [
          'The signature is computed over the canonical serialization of every field above (signature itself excluded). The block sits as the last top-level key.',
        ],
        table: {
          headers: ['Subfield', 'Type', 'Notes'],
          rows: [
            ['<code>alg</code>', 'string', 'Always <code>"Ed25519"</code> for kolm-audit-1.'],
            ['<code>key_id</code>', 'string', 'Same as <code>signing_key_id</code>; duplicated for verifier convenience.'],
            ['<code>value</code>', 'string', 'base64url-encoded 64-byte signature, prefixed <code>base64url:</code>.'],
          ],
        },
      },
      {
        h2: 'Canonical serialization',
        paragraphs: [
          'Before signing, the receipt body is canonicalized: keys sorted lexicographically at every level, no whitespace, UTF-8 NFC, integers as base-10 without leading zeros, floats as RFC 8259 grisu3. The verifier re-canonicalizes when validating so the on-disk representation can be pretty-printed without breaking the signature.',
        ],
      },
      {
        h2: 'Constraints enforced at signing',
        list: [
          '<code>receipt_id</code> matches the CID of the unsigned body.',
          '<code>capture_id</code> is non-null if and only if <code>capture_eligible</code> is true.',
          '<code>confidence</code> is non-null if and only if <code>route_decision</code> is <code>student</code> or <code>teacher</code> (i.e. confidence routing was active).',
          '<code>fallback_reason</code> is non-null if and only if <code>route_decision</code> is <code>fallback</code>.',
          '<code>cost_usd</code> reconciles with <code>(input_tokens &times; input_rate) + (output_tokens &times; output_rate)</code> against the rate card at <code>timestamp</code>.',
        ],
      },
      {
        h2: 'Field omission and forward compatibility',
        paragraphs: [
          'New fields added in future schema versions are written as additional top-level keys. Verifiers that target <code>kolm-audit-1</code> ignore unknown fields; verifiers that target a newer schema reject older receipts only when explicitly configured to do so. The schema name is the contract.',
        ],
        caveat: 'The receipt body is &lt;1 KB on average. The signature block adds ~96 bytes. Receipts are stored uncompressed in the capture lake; compression happens at the storage-backend layer (Postgres TOAST, S3 gzip on object PUT). The verify URL points at the hosted verifier; for air-gapped environments, run a private verifier and override <code>verify_url</code> via <code>[signing] verify_url_template</code> in <code>gateway.toml</code>.',
      },
    ],
    related: [
      { href: '/docs/receipts/overview', label: 'Receipts overview' },
      { href: '/docs/receipts/verification', label: 'Verification' },
      { href: '/docs/receipts/signing', label: 'Signing' },
      { href: '/docs/receipts/audit-export', label: 'Audit export' },
    ],
  },

  {
    slug: 'verification',
    title: 'Receipt verification',
    description: 'kolm receipts verify online and offline. What each gate checks; expected output; failure modes.',
    eyebrow: 'Receipt verification',
    h1: 'Online or offline, the same gates fire.',
    lede: '<code>kolm receipts verify &lt;id&gt;</code> walks five gates: schema match, CID match, signature validity, rate-card reconciliation, capture-row linkage. <code>--offline</code> uses a cached public key and skips the network fetch.',
    sections: [
      {
        h2: 'The verb',
        paragraphs: [
          'One verb covers both modes. The online mode fetches the receipt and the public key from <code>kolm.ai</code> (or your self-hosted gateway); the offline mode reads both from local files.',
        ],
        code: `# Online: fetch receipt + public key over HTTPS, verify
kolm receipts verify bafy2bzaceabc...

# Offline: receipt body on disk, public key cached in ~/.kolm/keys/
kolm receipts verify --offline ./receipt.json

# Verify a batch
kolm receipts verify --batch ./receipts.jsonl --json | jq '.summary'
# { "total": 1248, "ok": 1248, "failed": 0, "elapsed_ms": 4231 }`,
      },
      {
        h2: 'The five gates',
        paragraphs: [
          'Each gate runs in order. The verb exits non-zero on the first failure and reports which gate failed and why. <code>--continue-on-fail</code> runs all gates and reports a summary.',
        ],
        table: {
          headers: ['Gate', 'What it checks', 'Failure mode'],
          rows: [
            ['<b>1. schema</b>', 'Receipt <code>schema</code> is one the verifier understands (<code>kolm-audit-1</code> or a compatible shim).', 'Unknown schema or version drift.'],
            ['<b>2. cid</b>', '<code>receipt_id</code> equals the recomputed CID over the unsigned body.', 'Receipt body was edited after signing.'],
            ['<b>3. signature</b>', 'Ed25519 signature validates against the public key resolved from <code>signing_key_id</code>.', 'Body tampered or wrong key.'],
            ['<b>4. rate-card</b>', '<code>cost_usd</code> reconciles with tokens &times; rate card at <code>timestamp</code>.', 'Cost drifted from the rate card.'],
            ['<b>5. capture-linkage</b>', 'When <code>capture_id</code> is set, the capture row exists and its hash matches <code>output_hash</code>.', 'Capture row missing or modified.'],
          ],
        },
      },
      {
        h2: 'Expected output',
        code: `kolm receipts verify bafy2bzaceabc...
# Fetching receipt... OK (1247 bytes)
# Fetching public key tenant_acme_v3... OK (cached for 24h)
# [OK] gate 1/5: schema = kolm-audit-1
# [OK] gate 2/5: receipt_id matches CID over unsigned body
# [OK] gate 3/5: Ed25519 signature valid (key_id=tenant_acme_v3)
# [OK] gate 4/5: cost_usd reconciles with rate card 2026-05-15 (delta=0.00000)
# [OK] gate 5/5: capture row cap_01HXYZ... present, output_hash matches
# Receipt verified. Exit code: 0`,
      },
      {
        h2: 'Online mode details',
        paragraphs: [
          'Online mode is the default. The verb resolves <code>signing_key_id</code> by GET <code>/v1/keys/&lt;id&gt;</code>; the response is cached in <code>~/.kolm/keys/</code> for 24 hours by default (override via <code>--key-cache-ttl</code>). The capture-linkage gate fetches the capture by id from the lake.',
          'Network failures degrade gracefully: gate 3 (signature) still runs against a cached key when available; gate 5 (capture-linkage) is skipped with a warning when the lake is unreachable.',
        ],
      },
      {
        h2: 'Offline mode details',
        paragraphs: [
          'Offline mode reads everything from disk. The public key must already exist in <code>~/.kolm/keys/&lt;key_id&gt;.pub</code> (run <code>kolm keys fetch &lt;key_id&gt;</code> once in advance). Gate 5 (capture-linkage) requires a local capture-lake snapshot; without it, the gate is skipped with a warning.',
        ],
        code: `# One-time key prefetch (online)
kolm keys fetch tenant_acme_v3
# Saved ~/.kolm/keys/tenant_acme_v3.pub (32 bytes)

# Now verify offline anywhere (CI, air-gapped audit, etc.)
kolm receipts verify --offline ./receipt.json
# [OK] gates 1-4 of 5
# [SKIP] gate 5: capture row lookup requires lake; pass --lake ./lake-snapshot.db
kolm receipts verify --offline --lake ./lake-snapshot.db ./receipt.json
# [OK] gates 1-5 of 5`,
      },
      {
        h2: 'Common failure modes',
        table: {
          headers: ['Symptom', 'Likely cause', 'Action'],
          rows: [
            ['Gate 2 fails (cid mismatch)', 'Receipt body was reformatted or edited.', 'Re-fetch from <code>/v1/receipts/&lt;cid&gt;</code>; do not edit receipts manually.'],
            ['Gate 3 fails (signature)', 'Wrong key, or body tampered.', 'Confirm <code>signing_key_id</code>; if right, body was modified.'],
            ['Gate 4 fails (rate-card)', 'Provider rate-card change after the call; verifier rate card is newer.', 'Pin verifier rate card with <code>--rate-card &lt;path&gt;</code>; rate cards are versioned.'],
            ['Gate 5 fails (capture)', 'Capture row was purged, deleted, or its hash drifted.', 'If retention purge expected, ignore with <code>--allow-purged</code>; if not, investigate the lake.'],
          ],
        },
      },
      {
        h2: 'Verifier in CI',
        paragraphs: [
          'A common pattern is to verify a sampled batch of receipts in CI nightly. The exit code drives the build status; the JSON output feeds a dashboard.',
        ],
        code: `# In your CI pipeline
kolm receipts list --namespace customer-support --since 24h --sample 100 --json | jq -r '.[].receipt_id' > /tmp/sample.txt
kolm receipts verify --batch /tmp/sample.txt --json > /tmp/verify.json
# Fail the build on any failure
test "$(jq '.summary.failed' /tmp/verify.json)" -eq 0`,
        caveat: 'Verification proves the receipt is consistent; it does not validate the response semantics. A signed receipt with a bad response is still a valid receipt. Pair with bake-offs and held-out evals for quality. The verifier itself is reproducible: same receipt + same public key + same rate card yields the same gate output.',
      },
    ],
    related: [
      { href: '/docs/receipts/overview', label: 'Receipts overview' },
      { href: '/docs/receipts/format', label: 'Receipt format' },
      { href: '/docs/receipts/signing', label: 'Signing' },
      { href: '/docs/receipts/audit-export', label: 'Audit export' },
    ],
  },

  {
    slug: 'signing',
    title: 'Receipt signing keys',
    description: 'Ed25519 key generation, ~/.kolm/signing-key.pem mode 0600 storage, env-var overrides, 90-day rotation with 30-day overlap.',
    eyebrow: 'Receipt signing',
    h1: 'Ed25519 keys with a 90-day rotation cadence.',
    lede: 'Generate the keypair with <code>kolm key generate</code>. The private half lives at <code>~/.kolm/signing-key.pem</code> with mode 0600 by default; override via env var. Rotation is 90 days with a 30-day overlap window so verifiers do not break.',
    sections: [
      {
        h2: 'Generating a key',
        paragraphs: [
          'The CLI generates an Ed25519 keypair, writes the private key (PKCS#8 PEM) to disk with mode 0600, and registers the public key with the hosted gateway. For self-hosted gateways, the public key needs to be served at <code>/v1/keys/&lt;key_id&gt;</code>; the CLI writes it to <code>~/.kolm/public-keys/&lt;key_id&gt;.pub</code> for upload to your gateway.',
        ],
        code: `# Generate (interactive: confirms overwrite if a key exists)
kolm key generate

# Generate with a specific key id (defaults to <tenant>_<short-random>)
kolm key generate --key-id tenant_acme_v3

# Generate to a specific path
kolm key generate --out /etc/kolm/signing.ed25519 --key-id tenant_acme_v3

# Inspect the current key (public half + metadata only; never prints private)
kolm key show
# key_id:     tenant_acme_v3
# algorithm:  Ed25519
# created:    2026-04-15T12:00:00Z
# rotates:    2026-07-14T12:00:00Z (90 days)
# public key: base64url:M+oS...vN`,
      },
      {
        h2: 'Storage location and permissions',
        paragraphs: [
          'The default path is <code>~/.kolm/signing-key.pem</code> on Linux / macOS. Windows: <code>%USERPROFILE%\\.kolm\\signing-key.pem</code>. Mode is 0600 on POSIX (owner read/write only); the CLI refuses to load a key with looser permissions unless <code>--allow-loose-perms</code> is passed. Windows: the CLI sets the ACL to current user only.',
        ],
        table: {
          headers: ['Platform', 'Default path', 'Mode'],
          rows: [
            ['Linux / macOS', '<code>~/.kolm/signing-key.pem</code>', '0600'],
            ['Windows', '<code>%USERPROFILE%\\.kolm\\signing-key.pem</code>', 'ACL: current user only'],
            ['Docker self-host', 'mount to <code>/etc/kolm/signing.ed25519</code>', 'image expects 0400'],
          ],
        },
      },
      {
        h2: 'Environment overrides',
        paragraphs: [
          'Two env vars override the disk file. Useful for cloud-native deployments where the key comes from a secret manager (AWS Secrets Manager, GCP Secret Manager, Vault).',
        ],
        table: {
          headers: ['Env var', 'Type', 'Effect'],
          rows: [
            ['<code>KOLM_ED25519_PRIVATE_KEY</code>', 'PEM string (literal)', 'Used directly; precedence over file.'],
            ['<code>KOLM_ED25519_PRIVATE_KEY_PATH</code>', 'filesystem path', 'Read from this path instead of the default.'],
          ],
        },
        code: `# Cloud deployment: inject key from secret manager
export KOLM_ED25519_PRIVATE_KEY="$(aws secretsmanager get-secret-value --secret-id kolm/signing --query SecretString --output text)"

# Or by path
export KOLM_ED25519_PRIVATE_KEY_PATH=/var/run/secrets/kolm/signing-key.pem`,
      },
      {
        h2: 'The 90-day rotation cadence',
        paragraphs: [
          'NIST SP 800-57 recommends rotating asymmetric signing keys on a periodic basis; the kolm default is 90 days. The rotation generates a new keypair, marks the old key as superseded but still valid for the 30-day overlap window, and starts signing new receipts with the new key. Receipts signed during the overlap remain verifiable against the old public key for the lifetime of the receipt.',
        ],
        code: `# Manual rotation
kolm key rotate
# Generated tenant_acme_v4 (active 2026-07-14T00:00:00Z onwards)
# Overlap window: tenant_acme_v3 valid for verifiers until 2026-08-13T00:00:00Z
# New receipts will be signed with tenant_acme_v4.

# Scheduled rotation (cron-style)
kolm key rotate --schedule "90d --overlap 30d"
# Sets a self-rotation cadence; the gateway issues a new key automatically on the cadence.`,
      },
      {
        h2: 'The 30-day overlap window',
        paragraphs: [
          'When key v3 retires at day 90, key v4 has been live for 60 days. Verifiers can request either public key from <code>/v1/keys/&lt;key_id&gt;</code>; each receipt carries its <code>signing_key_id</code> so the right key is always retrievable. The overlap protects long-lived deployments where some verifier hasn’t yet refreshed its cached key list.',
        ],
        code: `# Timeline
day 0:    v3 active.   v4 not yet generated.
day 60:   v3 active.   v4 generated, dormant.
day 90:   v3 retired.  v4 takes over (new receipts use v4).
day 120:  v3 still valid for verifying old receipts (overlap window).
day 121+: v3 public key removed from the keys endpoint. Old receipts no longer verifiable.

# Operator action at day 120: confirm no live verifier still has v3 cached past expiry`,
      },
      {
        h2: 'Key revocation',
        paragraphs: [
          'If a key is compromised, revoke it immediately. Revocation removes the public key from the keys endpoint and adds the key id to a published revocation list. Receipts signed before the revocation timestamp remain verifiable if the revoker chooses; new verifications against revoked keys fail by default.',
        ],
        code: `kolm key revoke tenant_acme_v3 --reason "suspected compromise" --revoke-pre true
# Revocation effective 2026-06-12T10:30:00Z
# Pre-revocation receipts: --revoke-pre true (no longer verifiable, fail-closed)
# Pre-revocation receipts: --revoke-pre false (still verifiable; document the trust assumption)`,
        caveat: 'Lose the private key, lose the ability to sign new receipts under that key id. Past receipts remain verifiable as long as the public key is published. Back up the private key to your secret manager before rotation; the CLI refuses to delete a key file unless <code>--force</code> is passed. The rotation overlap of 30 days is the longest live verifier should ever need to converge; if you have longer-tail verifiers (regulatory archive readers), lengthen the overlap explicitly.',
      },
    ],
    related: [
      { href: '/docs/receipts/overview', label: 'Receipts overview' },
      { href: '/docs/receipts/format', label: 'Receipt format' },
      { href: '/docs/receipts/verification', label: 'Verification' },
      { href: '/docs/receipts/audit-export', label: 'Audit export' },
    ],
  },

  {
    slug: 'audit-export',
    title: 'Receipt audit export',
    description: 'Export receipts as CEF (ArcSight), LEEF (QRadar), CSV (RFC 4180), or JSONL. Per-namespace and date-range filters.',
    eyebrow: 'Receipt audit export',
    h1: 'Four formats. One verb. Auditor-ready.',
    lede: '<code>kolm receipts export --format</code> emits receipts as CEF for ArcSight, LEEF for QRadar, CSV per RFC 4180, or JSONL for everything else. Filters are the same as capture export; output is byte-deterministic per filter.',
    sections: [
      {
        h2: 'The four formats',
        table: {
          headers: ['Format', 'Use case', 'Spec'],
          rows: [
            ['<code>cef</code>', 'ArcSight ESM ingest, generic SIEM via CEF.', 'ArcSight Common Event Format Implementation Standard.'],
            ['<code>leef</code>', 'IBM QRadar ingest.', 'IBM Log Event Extended Format v2.0.'],
            ['<code>csv</code>', 'Excel, finance reconciliation, generic warehouse load.', 'RFC 4180.'],
            ['<code>jsonl</code>', 'Streaming pipelines, jq, custom downstream.', 'Newline-delimited JSON.'],
          ],
        },
      },
      {
        h2: 'Filter flags',
        paragraphs: [
          'Filters compose. They are identical to <a href="/docs/capture/export">capture export</a> filters so an audit pull and a training pull can share the same filter script.',
        ],
        table: {
          headers: ['Flag', 'Effect'],
          rows: [
            ['<code>--namespace &lt;name&gt;</code>', 'Limit to one namespace; repeat for multiple.'],
            ['<code>--since &lt;duration&gt;</code>', 'Receipts newer than the duration.'],
            ['<code>--until &lt;timestamp&gt;</code>', 'Receipts before the timestamp (RFC 3339).'],
            ['<code>--provider &lt;slug&gt;</code>', 'Filter by provider that handled the call.'],
            ['<code>--model &lt;name&gt;</code>', 'Filter by model.'],
            ['<code>--route &lt;decision&gt;</code>', 'pinned / fallback / student / teacher.'],
            ['<code>--key-id &lt;id&gt;</code>', 'Only receipts signed with a specific key (useful around rotations).'],
            ['<code>--include-signature</code>', 'Include the Ed25519 signature block (default: omit for SIEM noise reduction).'],
          ],
        },
      },
      {
        h2: 'CEF for ArcSight',
        paragraphs: [
          'CEF lines map receipt fields to the standard ArcSight extension namespace. Each receipt is one line; the gateway is the device vendor; <code>kolm-audit</code> is the device product; the schema version is the device version.',
        ],
        code: `# kolm receipts export --format cef --namespace customer-support --since 24h --out /var/log/kolm-receipts.cef

CEF:0|kolm|kolm-audit|1.0|teacher|LLM call audit|3|act=teacher rt=2026-05-20T14:32:01.847Z deviceCustomString1Label=namespace deviceCustomString1=customer-support src=tenant_acme dvc=gateway suser=ks_acme externalId=bafy2bzaceabc... cs1Label=provider cs1=openai cs2Label=model cs2=gpt-4o cn1Label=input_tokens cn1=142 cn2Label=output_tokens cn2=488 cn3Label=cost_usd_microcents cn3=8340 cs3Label=redaction cs3=redact_captures cs4Label=key_id cs4=tenant_acme_v3
CEF:0|kolm|kolm-audit|1.0|student|LLM call audit|2|act=student rt=2026-05-20T14:32:02.103Z ...`,
      },
      {
        h2: 'LEEF for QRadar',
        paragraphs: [
          'LEEF v2.0 lines use the pipe delimiter and <code>|^|</code> attribute separator. QRadar DSM maps the fields to events; the <code>kolm/kolm-audit</code> vendor/product pair is registered with IBM. ',
        ],
        code: `# kolm receipts export --format leef --namespace customer-support --since 24h --out /var/log/kolm-receipts.leef

LEEF:2.0|kolm|kolm-audit|1.0|teacher|^|devTime=2026-05-20T14:32:01.847Z|^|namespace=customer-support|^|tenant=tenant_acme|^|receipt_id=bafy2bzaceabc...|^|provider=openai|^|model=gpt-4o|^|input_tokens=142|^|output_tokens=488|^|cost_usd=0.00834|^|redaction=redact_captures|^|key_id=tenant_acme_v3
LEEF:2.0|kolm|kolm-audit|1.0|student|^|devTime=2026-05-20T14:32:02.103Z|^|...`,
      },
      {
        h2: 'CSV per RFC 4180',
        paragraphs: [
          'CSV is the format finance and compliance teams prefer. Header row is always present; fields are quoted only when necessary (RFC 4180 minimal-quote mode). Values containing commas, quotes, or newlines are quoted with embedded quotes doubled.',
        ],
        code: `# kolm receipts export --format csv --namespace customer-support --since 30d --out /tmp/audit-2026-05.csv

receipt_id,timestamp,namespace_id,route_decision,provider,model,input_tokens,output_tokens,cost_usd,redaction_applied,signing_key_id
bafy2bzaceabc...,2026-05-20T14:32:01.847Z,customer-support,teacher,openai,gpt-4o,142,488,0.00834,redact_captures,tenant_acme_v3
bafy2bzacedef...,2026-05-20T14:32:02.103Z,customer-support,student,local-kolm,support-v3.kolm,98,210,0.00021,redact_captures,tenant_acme_v3
...`,
      },
      {
        h2: 'JSONL for everything else',
        paragraphs: [
          'JSONL is the default and the most expressive: every field is preserved, the signature is included when <code>--include-signature</code> is passed. Pipe to jq, ingest into Splunk via the HTTP Event Collector, load into BigQuery.',
        ],
        code: `# Default: signature omitted (lighter for SIEM ingest)
kolm receipts export --format jsonl --namespace customer-support --since 24h --out /tmp/audit.jsonl

# Include signature (auditor-grade; verifies offline)
kolm receipts export --format jsonl --include-signature --namespace customer-support --since 30d --out /tmp/audit-signed.jsonl

# Verify the exported batch in one shot
kolm receipts verify --batch /tmp/audit-signed.jsonl --json | jq '.summary'`,
      },
      {
        h2: 'Scheduling regular exports',
        paragraphs: [
          'Most teams run a nightly export into the SIEM. The gateway has a built-in scheduler that writes the file and rotates it; cron also works.',
        ],
        code: `# Built-in scheduler in gateway.toml
[[scheduled.export]]
name      = "siem-nightly"
format    = "cef"
namespace = ["customer-support", "billing-bot"]
schedule  = "0 1 * * *"           # 01:00 UTC daily
since     = "24h"
out       = "/var/log/kolm-receipts-{date}.cef"
rotate    = "daily"
retain    = "90d"`,
        caveat: 'Exported receipts are read-only artifacts; tampering with them on disk does not affect the canonical receipt in the lake. Auditors should verify exports against the lake via <code>kolm receipts verify --batch</code> rather than trusting the file. CEF and LEEF formats omit some fields by design (signature, full input/output hashes) to keep SIEM noise down; use JSONL with <code>--include-signature</code> for the auditor-grade export.',
      },
    ],
    related: [
      { href: '/docs/receipts/overview', label: 'Receipts overview' },
      { href: '/docs/receipts/format', label: 'Receipt format' },
      { href: '/docs/receipts/verification', label: 'Verification' },
      { href: '/docs/receipts/signing', label: 'Signing' },
    ],
  },
];

// ---------- write -----------------------------------------------------------

function writePage(dir, family, spec) {
  const html = pageShell({ ...spec, family });
  const outPath = path.join(dir, `${spec.slug}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

function main() {
  if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

  const written = [];
  for (const p of CAPTURE_PAGES) written.push(writePage(CAPTURE_DIR, 'capture', p));
  for (const p of RECEIPT_PAGES) written.push(writePage(RECEIPTS_DIR, 'receipts', p));

  for (const f of written) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    console.log(`wrote ${rel}`);
  }
  console.log(`\n${written.length} pages written.`);
}

if (require.main === module) main();

module.exports = { CAPTURE_PAGES, RECEIPT_PAGES, pageShell };
