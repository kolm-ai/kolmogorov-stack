#!/usr/bin/env node
/**
 * build-wrapper-docs-gateway-routing.cjs
 *
 * Generates the 13 Wrapper-surface documentation pages under:
 *   public/docs/gateway/  (8 pages)
 *   public/docs/routing/  (5 pages)
 *
 * Voice: terse, technical, definite. Cool slate aesthetic only.
 * Uses the standard /design-tokens.css + /ks.css + /warm-paper.css cascade.
 * No emojis. No "honest"/"honesty" wording.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY_DIR = path.join(ROOT, 'public', 'docs', 'gateway');
const ROUTING_DIR = path.join(ROOT, 'public', 'docs', 'routing');

// ---------- shared page shell ----------------------------------------------

function pageShell({ slug, family, title, description, eyebrow, h1, lede, sections, related }) {
  const canonical = `https://kolm.ai/docs/${family}/${slug}`;
  const fullTitle = `${title} · Gateway docs · kolm.ai`;
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
      <li><a href="/product">Product</a></li>
      <li><a href="/solutions/teams">For teams</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="/docs">Docs</a></li>
      <li><a href="/enterprise">Enterprise</a></li>
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
    <p>&copy; 2026 kolm.ai &middot; Apache-2.0 &middot; Made with .kolm &middot; <a href="mailto:dev@kolm.ai">dev@kolm.ai</a></p>
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

// ---------- gateway pages ---------------------------------------------------

const GATEWAY_PAGES = [
  {
    slug: 'overview',
    title: 'Gateway overview',
    description: 'The kolm gateway is a signing, redacting, capturing reverse-proxy that sits in front of any LLM API. Eleven providers, one auditable receipt per call.',
    eyebrow: 'Gateway',
    h1: 'A signing gateway in front of every LLM call.',
    lede: 'The gateway is a thin reverse-proxy that turns every chat-completion request into a signed, captured, metered event. Eleven providers behind one OpenAI-compatible interface. No vendor lock, no SDK rewrite.',
    sections: [
      {
        h2: 'What it does',
        paragraphs: [
          'Drop the gateway between your application and any LLM provider. Point your existing OpenAI / Anthropic SDK at <code>https://kolm.ai/v1/wrap/&lt;provider&gt;</code> (or a self-hosted endpoint) and every call becomes a row in your capture lake with an Ed25519-signed receipt.',
          'Captures feed three downstream loops: distillation (turn high-volume prompts into a local <code>.kolm</code> specialist), routing (send the easy 80% to the cheap path), and audit (prove what the model saw and emitted, for any compliance regime).',
        ],
      },
      {
        h2: 'The 11-stage pipeline',
        paragraphs: [
          'Every request walks the same deterministic pipeline. Each stage is a separate function with a documented contract; you can disable any stage that does not apply (telemetry, capture, redaction modes) but the order is fixed.',
        ],
        table: {
          headers: ['#', 'Stage', 'Purpose'],
          rows: [
            ['1', 'auth', 'Validate the inbound API key or signed JWT, attach tenant identity.'],
            ['2', 'namespace', 'Resolve the namespace (header, path, or default) for routing and quota.'],
            ['3', 'input-PII-scan', 'Detect emails, phone numbers, SSNs, API tokens, credit cards in the prompt.'],
            ['4', 'route', 'Pick provider + model based on namespace rules, confidence threshold, or pin.'],
            ['5', 'forward', 'Translate request to provider native shape, attach upstream credentials.'],
            ['6', 'receive', 'Buffer or stream the response, normalize chunk shape if SSE.'],
            ['7', 'output-PII-scan', 'Detect leaked secrets or contaminated text on the response side.'],
            ['8', 'sign', 'Compute <code>kolm-audit-1</code> receipt, sign with Ed25519 tenant key.'],
            ['9', 'capture', 'Append to the capture lake (JSONL / SQLite / Postgres / S3).'],
            ['10', 'meter', 'Record tokens + USD against the tenant + namespace bucket.'],
            ['11', 'telemetry', 'Emit OpenTelemetry spans with the receipt id as trace attribute.'],
          ],
        },
      },
      {
        h2: 'Who it is for',
        list: [
          '<b>Teams already paying $5k+/mo to a single LLM vendor</b> who want to see, attribute, and route that spend.',
          '<b>Regulated workloads</b> (health, finance, legal) that need a tamper-evident audit trail for every model output.',
          '<b>Distillation candidates</b> &mdash; if you have one workflow that fires the same prompt shape 50,000 times a month, the captures are the seed dataset for a local specialist.',
          '<b>Multi-provider shops</b> who want one billing dashboard and one failover policy across OpenAI, Anthropic, Google, and self-hosted vLLM.',
        ],
      },
      {
        h2: 'What it is not',
        paragraphs: [
          'The gateway is not a model. It does not host inference unless you point a route at <code>local-vLLM</code>, <code>local-Ollama</code>, or a <code>.kolm</code> artifact. It is not a prompt cache; it forwards every request to the routed provider. It does not modify prompts beyond optional PII redaction in the captured copy.',
        ],
      },
      {
        h2: 'Performance overhead',
        paragraphs: [
          'Target p50 latency overhead is under 5 ms when running co-located with your application (same VPC, same region as the upstream provider). Signing is a single Ed25519 operation (~50 us). Capture writes are append-only and buffered; the response is released to the caller before the capture is durable.',
        ],
        caveat: 'The 5 ms target assumes co-location. If you route through the hosted <code>kolm.ai</code> endpoint from a different region, add the round-trip. Self-host (Docker Compose or Kubernetes) for production workloads where overhead matters.',
      },
    ],
    related: [
      { href: '/docs/gateway/quickstart', label: 'Quickstart' },
      { href: '/docs/gateway/configuration', label: 'Configuration' },
      { href: '/docs/gateway/providers', label: 'Providers' },
      { href: '/docs/routing/overview', label: 'Routing' },
    ],
  },

  {
    slug: 'quickstart',
    title: 'Gateway quickstart',
    description: 'Install the kolm CLI, point your OpenAI SDK at the wrap endpoint, and capture your first signed call in 60 seconds.',
    eyebrow: 'Gateway quickstart',
    h1: 'From zero to a signed capture in 60 seconds.',
    lede: 'Install the CLI, set one environment variable, fire a normal OpenAI call. The response is identical; a signed receipt lands in your capture lake.',
    sections: [
      {
        h2: '1. Install',
        paragraphs: [
          'The CLI ships as a Python package and a Node package. Either is fine; both speak the same config file.',
        ],
        code: `# Python\npip install kolm\n\n# Node\nnpm install -g @kolm/cli\n\n# Verify\nkolm --version\nkolm whoami   # prints "logged_in: false" until you sign up`,
      },
      {
        h2: '2. Sign up for a free API key',
        paragraphs: [
          'The free tier includes 50,000 captures per month, all 11 providers, signed receipts, and one namespace. No card required.',
        ],
        code: `kolm signup --email you@example.com\n# or visit https://kolm.ai/signup\n\n# Save the returned key\nexport KOLM_API_KEY=ks_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      },
      {
        h2: '3. Point your SDK at the wrap endpoint',
        paragraphs: [
          'The wrap endpoint is a drop-in replacement for the provider native URL. The path after <code>/v1/wrap/&lt;provider&gt;</code> is forwarded unchanged. Your <code>OPENAI_API_KEY</code> stays untouched &mdash; it travels through to OpenAI in the <code>Authorization</code> header. The <code>KOLM_API_KEY</code> authenticates you to the gateway via the <code>X-Kolm-Key</code> header.',
        ],
        code: `# OpenAI\nexport OPENAI_BASE_URL=https://kolm.ai/v1/wrap/openai\nexport OPENAI_API_KEY=sk-...           # your existing OpenAI key\n\n# Anthropic\nexport ANTHROPIC_BASE_URL=https://kolm.ai/v1/wrap/anthropic\nexport ANTHROPIC_API_KEY=sk-ant-...\n\n# Header for kolm itself\nexport KOLM_API_KEY=ks_...`,
      },
      {
        h2: '4. Fire a request',
        paragraphs: [
          'Use whatever SDK you already have. The wrap endpoint accepts the provider native request shape and returns the provider native response shape. The signed receipt is attached as response header <code>X-Kolm-Receipt-CID</code> and stored in your capture lake.',
        ],
        code: `curl -s https://kolm.ai/v1/wrap/openai/chat/completions \\\n  -H "Authorization: Bearer $OPENAI_API_KEY" \\\n  -H "X-Kolm-Key: $KOLM_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "gpt-4o-mini",\n    "messages": [{"role":"user","content":"Say hi."}]\n  }' | jq .\n\n# In the response headers you will see:\n#   X-Kolm-Receipt-CID: bafy2bzace...\n#   X-Kolm-Route-Decision: pinned\n#   X-Kolm-Cost-USD: 0.000041`,
      },
      {
        h2: '5. Verify the capture',
        paragraphs: [
          'List recent captures, fetch the receipt, replay the signature.',
        ],
        code: `kolm captures list --limit 5\nkolm captures get <receipt_cid>\nkolm verify <receipt_cid>   # recomputes Ed25519 signature, prints OK / FAIL`,
      },
      {
        h2: 'What you have now',
        list: [
          'Every OpenAI / Anthropic / Gemini / DeepSeek call is captured with a signed <code>kolm-audit-1</code> receipt.',
          'You can attribute cost per namespace, per model, per route decision.',
          'You can replay any capture into a different provider for A/B testing (<code>kolm bakeoff</code>).',
          'You can compile a local <code>.kolm</code> specialist from those captures once you have a few hundred (<code>kolm distill</code>).',
        ],
      },
      {
        caveat: 'Free-tier captures are stored on kolm.ai infrastructure. If your captures contain regulated data, switch to PII redaction mode <code>redact_captures</code> (see <a href="/docs/gateway/configuration">configuration</a>) or self-host the gateway. Keys ship in plaintext to upstream providers exactly as they do in your current setup &mdash; the gateway never logs them.',
      },
    ],
    related: [
      { href: '/docs/gateway/overview', label: 'Overview' },
      { href: '/docs/gateway/configuration', label: 'Configuration' },
      { href: '/docs/gateway/providers', label: 'Providers' },
      { href: '/docs/gateway/troubleshooting', label: 'Troubleshooting' },
    ],
  },

  {
    slug: 'configuration',
    title: 'gateway.toml reference',
    description: 'Full reference for the gateway.toml configuration file: server, signing, redaction, capture, telemetry, provider, and namespace sections.',
    eyebrow: 'Gateway configuration',
    h1: 'gateway.toml &mdash; the single source of truth.',
    lede: 'One file declares the gateway’s bind address, signing key path, PII mode, capture backend, telemetry exporter, every upstream provider, and per-namespace routing rules. Loaded once at boot; SIGHUP reloads it without dropping connections.',
    sections: [
      {
        h2: 'File location',
        paragraphs: [
          'The CLI looks for <code>gateway.toml</code> in three places, first match wins: <code>$KOLM_GATEWAY_CONFIG</code>, <code>./gateway.toml</code> in the working directory, then <code>~/.kolm/gateway.toml</code>. The hosted <code>kolm.ai</code> endpoint ships with a managed default; this file matters when you self-host.',
        ],
      },
      {
        h2: 'Complete example',
        paragraphs: [
          'Every section is documented below. Required sections: <code>[server]</code>, <code>[signing]</code>, at least one <code>[[provider]]</code>, and at least one <code>[[namespace]]</code>.',
        ],
        code: `# gateway.toml — production self-host example\n\n[server]\nbind             = "0.0.0.0:8080"\npublic_url       = "https://gateway.internal.example.com"\nrequest_timeout  = "30s"\nshutdown_grace   = "15s"\nmax_body_bytes   = 4194304        # 4 MiB\n\n[signing]\nkey_path         = "/etc/kolm/signing.ed25519"\nkey_id           = "tenant_acme_v3"\nalgorithm        = "Ed25519"\nreceipt_schema   = "kolm-audit-1"\nkey_rotation_overlap_days = 30    # NIST SP 800-57 aligned\n\n[redaction]\nmode             = "redact_captures"   # detect_only | redact_captures | redact_all | block\npatterns         = ["email", "phone", "ssn", "credit_card", "api_token"]\nreplace_with     = "[REDACTED:{kind}]"\n\n[capture]\nbackend          = "postgres"          # jsonl | sqlite | postgres | s3\nconnection_url   = "postgres://kolm:secret@db.internal:5432/kolm"\nhash_chain       = "hmac_sha256"\nbatch_size       = 64\nflush_interval   = "500ms"\nasync            = true                # release response before durable\n\n[telemetry]\nexporter         = "otlp"\nendpoint         = "http://otel-collector:4317"\nservice_name     = "kolm-gateway"\nsample_rate      = 1.0\n\n# --- providers ---------------------------------------------------------\n\n[[provider]]\nname             = "openai"\nbase_url         = "https://api.openai.com/v1"\nauth_scheme      = "bearer_passthrough"\ntimeout          = "60s"\nretry_count      = 1\n\n[[provider]]\nname             = "anthropic"\nbase_url         = "https://api.anthropic.com"\nauth_scheme      = "x_api_key_passthrough"\ntimeout          = "60s"\n\n[[provider]]\nname             = "local-vllm"\nbase_url         = "http://vllm-cluster:8000/v1"\nauth_scheme      = "none"\ntimeout          = "120s"\n\n# --- namespaces --------------------------------------------------------\n\n[[namespace]]\nname             = "default"\nprimary          = "openai/gpt-4o-mini"\nfallback         = ["anthropic/claude-haiku-4-5", "local-vllm/qwen-3.6-7b"]\nconfidence_route = false\n\n[[namespace]]\nname             = "support-bot"\nprimary          = "local-vllm/kolm-support-v3.kolm"\nfallback         = ["openai/gpt-4o-mini"]\nconfidence_route = true\nconfidence_profile = "balanced"          # aggressive | balanced | conservative\nquota_captures_per_day = 50000\n`,
      },
      {
        h2: '[server]',
        table: {
          headers: ['Key', 'Type', 'Default', 'Notes'],
          rows: [
            ['<code>bind</code>', 'string', '<code>"127.0.0.1:8080"</code>', 'host:port or unix:/path/to.sock'],
            ['<code>public_url</code>', 'string', '&mdash;', 'Used in receipt <code>iss</code> claim and CORS allowlist.'],
            ['<code>request_timeout</code>', 'duration', '<code>"30s"</code>', 'Wall-clock cap for the entire pipeline.'],
            ['<code>shutdown_grace</code>', 'duration', '<code>"15s"</code>', 'How long SIGTERM waits for in-flight requests.'],
            ['<code>max_body_bytes</code>', 'int', '<code>4194304</code>', '413 on overflow before forwarding.'],
          ],
        },
      },
      {
        h2: '[signing]',
        paragraphs: [
          'Ed25519 keypair, stored on disk as a 32-byte seed. Use <code>kolm key generate</code> to create one. The <code>key_id</code> travels in the receipt header so verifiers can fetch the matching public key from <code>/v1/keys/&lt;key_id&gt;</code>. Rotation overlap defaults to 30 days &mdash; both old and new public keys remain valid during the overlap.',
        ],
      },
      {
        h2: '[redaction] &mdash; four PII modes',
        table: {
          headers: ['Mode', 'Forwarded to upstream', 'Stored in capture', 'Use case'],
          rows: [
            ['<code>detect_only</code>', 'Raw prompt', 'Raw prompt + detection annotations', 'Investigate exposure before enforcing.'],
            ['<code>redact_captures</code>', 'Raw prompt', 'Redacted copy', 'Default for regulated workloads.'],
            ['<code>redact_all</code>', 'Redacted prompt', 'Redacted copy', 'Maximum: model never sees PII either.'],
            ['<code>block</code>', '&mdash;', '&mdash;', 'Reject the request with HTTP 422; surface a privacy event.'],
          ],
        },
      },
      {
        h2: '[capture] &mdash; four storage backends',
        paragraphs: [
          'All four backends share the same hash-chained append-only schema. The <code>hash_chain</code> field is HMAC-SHA256 over (previous_hash, receipt_bytes). Choose the backend that matches the volume.',
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
        h2: '[telemetry]',
        paragraphs: [
          'Emits OpenTelemetry spans for every pipeline stage. The receipt CID is attached as a span attribute so you can correlate a capture row with the trace. Sample rate of 1.0 captures all; drop to 0.05 for high-volume production with sampling done at the collector.',
        ],
      },
      {
        h2: '[[provider]] &mdash; one block per upstream',
        paragraphs: [
          'See the <a href="/docs/gateway/providers">providers</a> page for the full table of base URLs and auth schemes. The <code>name</code> is the slug used in <code>/v1/wrap/&lt;provider&gt;</code> and in namespace <code>primary</code> / <code>fallback</code> entries.',
        ],
      },
      {
        h2: '[[namespace]] &mdash; routing + quota',
        paragraphs: [
          'A namespace is a routing scope. Requests pick a namespace via the <code>X-Kolm-Namespace</code> header, a <code>?ns=</code> query parameter, or the default. Each namespace declares its primary model, a fallback chain, whether confidence routing is on, and an optional daily quota.',
        ],
      },
      {
        h2: 'Reload without dropping connections',
        paragraphs: [
          'Send <code>SIGHUP</code> to the gateway process. The config is reparsed; in-flight requests finish with the old config, new requests use the new one. <code>kolm gateway reload</code> wraps the signal.',
        ],
        caveat: 'Changing <code>[server] bind</code> or <code>[signing] key_path</code> requires a full restart, not a reload. The signing key swap walks the 30-day overlap window; do not delete the old key file until the overlap expires.',
      },
    ],
    related: [
      { href: '/docs/gateway/quickstart', label: 'Quickstart' },
      { href: '/docs/gateway/providers', label: 'Providers' },
      { href: '/docs/gateway/self-host', label: 'Self-host' },
      { href: '/docs/gateway/routing-rules', label: 'Routing rules' },
    ],
  },

  {
    slug: 'providers',
    title: 'Supported providers',
    description: 'Eleven providers behind one wrap endpoint: OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Together, Fireworks, OpenRouter, local-vLLM, local-Ollama, local-.kolm.',
    eyebrow: 'Gateway providers',
    h1: 'Eleven providers, one wrap endpoint.',
    lede: 'Every provider accepts its native request shape on the wrap URL. The gateway translates only what the provider requires; nothing else is rewritten. Your existing SDK keeps working.',
    sections: [
      {
        h2: 'Full provider table',
        paragraphs: [
          'The wrap path is <code>https://kolm.ai/v1/wrap/&lt;provider&gt;/&lt;native_path&gt;</code>. The upstream credential is passed through in the header the provider expects. The <code>X-Kolm-Key</code> header authenticates to kolm itself.',
        ],
        table: {
          headers: ['Provider slug', 'Native base URL', 'Auth header (passthrough)', 'Example path'],
          rows: [
            ['<code>openai</code>', '<code>api.openai.com/v1</code>', '<code>Authorization: Bearer sk-...</code>', '<code>/chat/completions</code>'],
            ['<code>anthropic</code>', '<code>api.anthropic.com</code>', '<code>x-api-key: sk-ant-...</code>', '<code>/v1/messages</code>'],
            ['<code>google</code>', '<code>generativelanguage.googleapis.com/v1beta</code>', '<code>x-goog-api-key: AI...</code>', '<code>/models/gemini-2.0-flash:generateContent</code>'],
            ['<code>deepseek</code>', '<code>api.deepseek.com/v1</code>', '<code>Authorization: Bearer sk-...</code>', '<code>/chat/completions</code>'],
            ['<code>groq</code>', '<code>api.groq.com/openai/v1</code>', '<code>Authorization: Bearer gsk_...</code>', '<code>/chat/completions</code>'],
            ['<code>together</code>', '<code>api.together.xyz/v1</code>', '<code>Authorization: Bearer ...</code>', '<code>/chat/completions</code>'],
            ['<code>fireworks</code>', '<code>api.fireworks.ai/inference/v1</code>', '<code>Authorization: Bearer fw_...</code>', '<code>/chat/completions</code>'],
            ['<code>openrouter</code>', '<code>openrouter.ai/api/v1</code>', '<code>Authorization: Bearer sk-or-...</code>', '<code>/chat/completions</code>'],
            ['<code>local-vllm</code>', '<i>configured per deployment</i>', '<code>none</code> or bearer', '<code>/v1/chat/completions</code>'],
            ['<code>local-ollama</code>', '<code>localhost:11434</code>', '<code>none</code>', '<code>/api/chat</code>'],
            ['<code>local-kolm</code>', '<i>artifact path</i>', '<code>none</code>', '<code>/v1/chat/completions</code>'],
          ],
        },
      },
      {
        h2: 'Hosted vs local distinction',
        paragraphs: [
          'The first eight (<code>openai</code> through <code>openrouter</code>) are hosted SaaS providers; the gateway forwards your credentials and bills against your account at each provider. The three <code>local-*</code> slugs forward to inference you control: a vLLM cluster, an Ollama daemon, or a <code>.kolm</code> artifact mounted into the gateway container. Local providers cost zero per-call USD (the meter records GPU-seconds instead).',
        ],
      },
      {
        h2: 'Request shape compatibility',
        paragraphs: [
          'The gateway does not normalize request shapes across providers. An OpenAI <code>chat/completions</code> body sent to <code>/v1/wrap/anthropic</code> will be rejected by Anthropic with a 400. If you want one request shape that fans out, use the <code>/v1/route/chat/completions</code> endpoint instead &mdash; that one accepts the OpenAI shape and translates to whichever provider the route picks.',
        ],
      },
      {
        h2: 'local-kolm: serving compiled artifacts',
        paragraphs: [
          'Point the gateway at a <code>.kolm</code> artifact path and it serves the artifact via the bundled llama.cpp / vLLM backend depending on the artifact format. The slug appears in receipts as <code>local-kolm/&lt;artifact_id&gt;</code> so routing decisions and cost attribution work uniformly.',
        ],
        code: `# Provider block for a compiled artifact\n[[provider]]\nname        = "local-kolm-support"\nbase_url    = "file:///var/kolm/artifacts/support-v3.kolm"\nauth_scheme = "none"\nbackend     = "llama-cpp"           # or "vllm"\ngpu_layers  = 35                    # llama.cpp offload count`,
      },
      {
        h2: 'Adding a custom provider',
        paragraphs: [
          'Any OpenAI-compatible HTTP endpoint works as a custom provider. Declare a <code>[[provider]]</code> block with the base URL and pick the closest <code>auth_scheme</code> (<code>bearer_passthrough</code>, <code>x_api_key_passthrough</code>, or <code>none</code>). The slug you choose becomes the wrap path.',
        ],
        caveat: 'The wrap path is verbatim forwarded after the provider segment. Per-provider request limits (token caps, image size, tool count) still apply &mdash; the gateway does not inflate them. If a 400 surprises you, replay the request directly against the provider native URL and compare; the gateway does not modify request bodies.',
      },
    ],
    related: [
      { href: '/docs/gateway/configuration', label: 'Configuration' },
      { href: '/docs/gateway/routing-rules', label: 'Routing rules' },
      { href: '/docs/gateway/streaming', label: 'Streaming' },
      { href: '/docs/routing/provider-failover', label: 'Provider failover' },
    ],
  },

  {
    slug: 'routing-rules',
    title: 'Per-namespace routing rules',
    description: 'Declare primary model, fallback chain, and confidence threshold per namespace. Same config covers cost-aware and latency-aware routing.',
    eyebrow: 'Gateway routing rules',
    h1: 'Per-namespace routing in one TOML block.',
    lede: 'A namespace declares a primary model and an ordered fallback chain. Optionally enable confidence routing so cheap local handles the easy queries and the expensive teacher only gets the hard ones.',
    sections: [
      {
        h2: 'The minimum routable namespace',
        paragraphs: [
          'A namespace needs a name and a primary. Fallback is optional but recommended.',
        ],
        code: `[[namespace]]\nname    = "default"\nprimary = "openai/gpt-4o-mini"`,
      },
      {
        h2: 'Primary + fallback chain',
        paragraphs: [
          'The fallback chain is tried in order on retryable failures (429, 502, 503, 504, network timeouts). Each entry is a <code>&lt;provider&gt;/&lt;model&gt;</code> pair. A retry budget caps the total attempts across the chain.',
        ],
        code: `[[namespace]]\nname           = "rag-pipeline"\nprimary        = "openai/gpt-4o"\nfallback       = [\n  "anthropic/claude-sonnet-4-5",\n  "deepseek/deepseek-v3.1",\n  "local-vllm/qwen-3.6-27b"\n]\nretry_budget   = 4              # total attempts across chain\nretry_backoff  = "exponential"  # exponential | linear | none`,
      },
      {
        h2: 'Confidence routing (optional)',
        paragraphs: [
          'Set <code>confidence_route = true</code> to enable W807 entropy-based routing. The gateway first probes the local student model for the next-token distribution. If the Shannon entropy of the first token is below the threshold, the student handles the call. If above, the request escalates to the primary teacher.',
        ],
        code: `[[namespace]]\nname               = "customer-support"\nprimary            = "openai/gpt-4o"          # teacher (escalation)\nfallback           = ["anthropic/claude-sonnet-4-5"]\nconfidence_route   = true\nconfidence_student = "local-kolm/support-v3.kolm"\nconfidence_profile = "balanced"               # threshold = 0.7 nats\n# or set raw threshold:\n# confidence_threshold = 0.65`,
        table: {
          headers: ['Profile', 'Threshold (nats)', 'Student share (typical)', 'Behavior'],
          rows: [
            ['<code>aggressive</code>', '0.85', '90&ndash;95%', 'Send almost everything local; escalate only on high uncertainty.'],
            ['<code>balanced</code>', '0.70', '70&ndash;80%', 'Default. Even cost vs. quality split.'],
            ['<code>conservative</code>', '0.55', '40&ndash;55%', 'Send only the easy half local; escalate on any wobble.'],
          ],
        },
      },
      {
        h2: 'Pinning a request',
        paragraphs: [
          'A caller can override routing for one request via headers. Useful when the application already knows the right tier.',
        ],
        table: {
          headers: ['Header', 'Effect'],
          rows: [
            ['<code>X-Kolm-Pin-Provider</code>', 'Force a specific provider slug; bypass route decision.'],
            ['<code>X-Kolm-Pin-Model</code>', 'Force a specific model; primary if pinned alone.'],
            ['<code>X-Kolm-No-Fallback</code>', 'Disable fallback; fail fast if primary is down.'],
            ['<code>X-Kolm-Namespace</code>', 'Pick a namespace other than default.'],
          ],
        },
      },
      {
        h2: 'Per-namespace quota',
        paragraphs: [
          'Cap the daily captures per namespace. When the cap is reached, requests get HTTP 429 with <code>Retry-After</code> set to seconds until midnight UTC. Useful for keeping a dev namespace from burning the team budget.',
        ],
        code: `[[namespace]]\nname                   = "dev-sandbox"\nprimary                = "openai/gpt-4o-mini"\nquota_captures_per_day = 500\nquota_action           = "throttle"   # throttle | log | block`,
      },
      {
        h2: 'Inspecting decisions',
        paragraphs: [
          'Every response includes the route headers <code>X-Kolm-Route-Decision</code>, <code>X-Kolm-Confidence-Nats</code>, and <code>X-Kolm-Fallback-Reason</code>. The same fields are stored on the receipt for offline analysis.',
        ],
        code: `kolm routes list --namespace customer-support --limit 50\nkolm routes stats --namespace customer-support --since 7d\n# returns: student_share, escalation_share, mean_entropy_nats, USD saved`,
        caveat: 'Confidence routing requires the student model to be loaded and responsive. If the student is cold or fails its probe, the gateway logs <code>fallback_reason = "student_probe_failed"</code> and routes to the teacher. Warm the student at boot via <code>preload = true</code> on the local-kolm provider.',
      },
    ],
    related: [
      { href: '/docs/routing/confidence-routing', label: 'Confidence routing' },
      { href: '/docs/routing/provider-failover', label: 'Provider failover' },
      { href: '/docs/gateway/configuration', label: 'Configuration' },
      { href: '/docs/gateway/providers', label: 'Providers' },
    ],
  },

  {
    slug: 'streaming',
    title: 'SSE streaming',
    description: 'Server-Sent Events streaming end-to-end through the gateway. Chunk shape normalized across all 11 providers.',
    eyebrow: 'Gateway streaming',
    h1: 'SSE streaming, normalized across providers.',
    lede: 'Set <code>stream: true</code> in the request body and the gateway forwards chunks as they arrive. Receipt and capture are written when the final chunk lands; latency to first token is identical to direct upstream.',
    sections: [
      {
        h2: 'How chunks flow',
        paragraphs: [
          'The gateway reads the upstream SSE stream and re-emits each <code>data:</code> line to the caller. No buffering &mdash; chunks reach the caller as soon as TCP delivers them. The pipeline stages 7 (output PII scan), 8 (sign), 9 (capture), and 10 (meter) run after the final chunk; they do not delay the stream.',
        ],
        code: `request → [auth, namespace, input-PII, route, forward]\n          ↓\n     upstream SSE stream\n          ↓\n   chunks forwarded verbatim → caller\n          ↓ (final chunk)\n     [output-PII, sign, capture, meter, telemetry]`,
      },
      {
        h2: 'Provider chunk shape normalization',
        paragraphs: [
          'Different providers emit different chunk shapes. The wrap endpoint passes through each provider’s native chunks unchanged. Use the route endpoint (<code>/v1/route/chat/completions</code>) if you want a single normalized shape across all providers.',
        ],
        table: {
          headers: ['Provider', 'Native chunk shape', 'Wrap endpoint emits', 'Route endpoint emits'],
          rows: [
            ['<code>openai</code>', 'OpenAI chunk', 'OpenAI chunk', 'OpenAI chunk (canonical)'],
            ['<code>anthropic</code>', 'Anthropic event types', 'Anthropic events', 'Translated to OpenAI chunk'],
            ['<code>google</code>', 'JSON object per chunk', 'JSON objects', 'Translated to OpenAI chunk'],
            ['<code>deepseek</code>', 'OpenAI chunk', 'OpenAI chunk', 'OpenAI chunk'],
            ['<code>local-vllm</code>', 'OpenAI chunk', 'OpenAI chunk', 'OpenAI chunk'],
            ['<code>local-ollama</code>', 'JSON object per chunk', 'JSON objects', 'Translated to OpenAI chunk'],
            ['<code>local-kolm</code>', 'OpenAI chunk', 'OpenAI chunk', 'OpenAI chunk'],
          ],
        },
      },
      {
        h2: 'Streaming a request',
        code: `curl -N -s https://kolm.ai/v1/wrap/openai/chat/completions \\\n  -H "Authorization: Bearer $OPENAI_API_KEY" \\\n  -H "X-Kolm-Key: $KOLM_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "gpt-4o-mini",\n    "stream": true,\n    "messages": [{"role":"user","content":"Count to five."}]\n  }'\n\n# data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"One"}}]}\n# data: {"id":"chatcmpl-...","choices":[{"delta":{"content":", two"}}]}\n# ...\n# data: [DONE]\n#\n# After [DONE], inspect response headers:\n#   X-Kolm-Receipt-CID: bafy2bzace...\n#   X-Kolm-Tokens-Out: 23`,
      },
      {
        h2: 'Receipt timing',
        paragraphs: [
          'The receipt is signed and the capture is written <strong>after</strong> the final chunk. The <code>X-Kolm-Receipt-CID</code> header arrives at the start of the response (trailer-style is not used; the CID is reserved at request time and the receipt body is filled in on completion). Polling <code>GET /v1/captures/&lt;cid&gt;</code> returns 425 (<code>Too Early</code>) until the capture flushes; then 200.',
        ],
      },
      {
        h2: 'Failure during stream',
        paragraphs: [
          'If the upstream connection drops mid-stream, the gateway closes the downstream connection at the same byte boundary and writes a partial-capture receipt with <code>terminated_early: true</code> and the bytes that did arrive. The fallback chain does NOT activate mid-stream &mdash; it only fires on pre-first-byte failures.',
        ],
        caveat: 'Mid-stream failures cannot be retried transparently because the caller has already received bytes. Applications should idempotently re-issue the request on <code>terminated_early</code> receipts. The route endpoint optionally buffers the entire response before forwarding (<code>X-Kolm-Buffer-Stream: true</code>) which restores fallback at the cost of time-to-first-token.',
      },
      {
        h2: 'Tool / function-calling streams',
        paragraphs: [
          'Tool-call deltas are forwarded unchanged. The capture stores the full reassembled tool-call payload on the receipt; intermediate deltas are not stored individually (the capture is per-call, not per-chunk).',
        ],
      },
    ],
    related: [
      { href: '/docs/gateway/providers', label: 'Providers' },
      { href: '/docs/gateway/troubleshooting', label: 'Troubleshooting' },
      { href: '/docs/routing/provider-failover', label: 'Provider failover' },
    ],
  },

  {
    slug: 'self-host',
    title: 'Self-host the gateway',
    description: 'Docker Compose walkthrough for production self-hosting. Kubernetes Helm chart pointer for HA deployments.',
    eyebrow: 'Gateway self-host',
    h1: 'Self-host in 10 minutes with Docker Compose.',
    lede: 'Three containers: gateway, Postgres, MinIO. One <code>docker compose up -d</code>. The same image runs in Kubernetes via the published Helm chart.',
    sections: [
      {
        h2: 'When to self-host',
        list: [
          'Regulated data that cannot leave your VPC.',
          'Latency-sensitive workloads where the hosted gateway adds a round-trip.',
          'Air-gapped deployments (artifact + image work fully offline).',
          'Multi-tenant SaaS where you want one gateway per customer namespace.',
        ],
      },
      {
        h2: 'Docker Compose layout',
        paragraphs: [
          'The published compose file ships three services. <code>gateway</code> runs the proxy; <code>postgres</code> stores captures and routing decisions; <code>minio</code> provides S3-compatible storage for long-term capture archives.',
        ],
        code: `# docker-compose.yml\nservices:\n  gateway:\n    image: ghcr.io/kolm-ai/kolm-gateway:latest\n    ports:\n      - "8080:8080"\n    environment:\n      KOLM_GATEWAY_CONFIG: /etc/kolm/gateway.toml\n    volumes:\n      - ./gateway.toml:/etc/kolm/gateway.toml:ro\n      - ./signing.ed25519:/etc/kolm/signing.ed25519:ro\n    depends_on: [postgres, minio]\n    restart: unless-stopped\n\n  postgres:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: kolm\n      POSTGRES_PASSWORD: change_me\n      POSTGRES_DB: kolm\n    volumes:\n      - pg-data:/var/lib/postgresql/data\n    restart: unless-stopped\n\n  minio:\n    image: minio/minio:latest\n    command: server /data --console-address ":9001"\n    environment:\n      MINIO_ROOT_USER: kolm\n      MINIO_ROOT_PASSWORD: change_me_too\n    volumes:\n      - minio-data:/data\n    ports:\n      - "9000:9000"\n      - "9001:9001"\n    restart: unless-stopped\n\nvolumes:\n  pg-data:\n  minio-data:`,
      },
      {
        h2: 'Boot sequence',
        ordered: true,
        list: [
          'Generate a signing key: <code>kolm key generate &gt; signing.ed25519</code> (chmod 0400).',
          'Write a <code>gateway.toml</code> with the provider blocks you need (see <a href="/docs/gateway/configuration">configuration</a>).',
          'Run <code>docker compose up -d</code>.',
          'Apply the Postgres schema: <code>docker compose exec gateway kolm db migrate</code>.',
          'Verify the health endpoint: <code>curl -s http://localhost:8080/v1/health | jq .</code>.',
          'Point a test SDK at <code>http://localhost:8080/v1/wrap/openai</code>; fire a call; check <code>kolm captures list</code>.',
        ],
      },
      {
        h2: 'Production hardening',
        list: [
          '<b>TLS termination</b> &mdash; run nginx, Caddy, or your cloud load balancer in front of the gateway. Do not expose port 8080 directly.',
          '<b>Postgres backups</b> &mdash; the capture lake is the audit trail; pg_dump nightly into the MinIO bucket.',
          '<b>Resource limits</b> &mdash; set <code>deploy.resources.limits</code> in compose or use a process manager. The gateway uses ~80 MB RSS idle plus ~2 KB per in-flight request.',
          '<b>Log shipping</b> &mdash; structured JSON logs to stderr; ship via your existing collector (Vector, Fluent Bit, Loki).',
          '<b>Key rotation</b> &mdash; <code>kolm key rotate</code> generates a new signing key and keeps the old public key valid for 30 days for verifier compatibility.',
        ],
      },
      {
        h2: 'Kubernetes via Helm',
        paragraphs: [
          'The same image runs in Kubernetes with the published chart. The chart includes a StatefulSet for Postgres, a Deployment for the gateway (with HPA on request rate), and a Service of type ClusterIP. Pair with cert-manager for TLS and external-dns for DNS.',
        ],
        code: `helm repo add kolm https://kolm-ai.github.io/kolmogorov-stack/charts\nhelm repo update\n\nhelm install gateway kolm/gateway \\\n  --namespace kolm --create-namespace \\\n  --set image.tag=latest \\\n  --set config.signingKeySecret=kolm-signing \\\n  --set ingress.host=gateway.internal.example.com \\\n  --set postgres.enabled=true \\\n  --set minio.enabled=true`,
      },
      {
        h2: 'Air-gapped install',
        paragraphs: [
          'Pull the image once on a connected host, save it as a tar, transfer to the air-gapped network, load with <code>docker load</code>. All provider blocks should target on-network endpoints (typically <code>local-vllm</code>, <code>local-ollama</code>, or <code>local-kolm</code>). The gateway has zero outbound calls when no hosted providers are configured.',
        ],
        caveat: 'The image and Helm chart are tagged by version; <code>latest</code> is fine for dev but pin to a specific tag for production. The first install requires the Postgres schema migration; subsequent restarts do not. Hosted (kolm.ai) and self-hosted deployments share the same capture schema, so you can migrate either direction by exporting / importing captures.',
      },
    ],
    related: [
      { href: '/docs/gateway/configuration', label: 'Configuration' },
      { href: '/docs/gateway/troubleshooting', label: 'Troubleshooting' },
      { href: '/docs/gateway/overview', label: 'Overview' },
    ],
  },

  {
    slug: 'troubleshooting',
    title: 'Gateway troubleshooting',
    description: 'Common gateway errors: 401 unauthorized, 429 rate limit, 502 upstream timeout, 503 capture write failure. Diagnose, fix, re-verify.',
    eyebrow: 'Gateway troubleshooting',
    h1: 'Diagnose, fix, re-verify.',
    lede: 'Every error from the gateway carries a stable error code and a remediation pointer. The most common four are listed below with the exact command to surface the root cause.',
    sections: [
      {
        h2: '401 unauthorized',
        paragraphs: [
          'The gateway rejected your <code>X-Kolm-Key</code> or your upstream provider rejected the passthrough credential. The error body distinguishes which side failed.',
        ],
        code: `{\n  "error": {\n    "code": "kolm_auth_failed",\n    "message": "X-Kolm-Key invalid or revoked",\n    "doc": "https://kolm.ai/docs/gateway/troubleshooting#401-unauthorized"\n  }\n}`,
        list: [
          '<code>kolm_auth_failed</code> &mdash; your kolm key is wrong. Run <code>kolm whoami</code>; if it says <code>logged_in: false</code>, re-run <code>kolm login</code> or paste a fresh key.',
          '<code>upstream_auth_failed</code> &mdash; your provider key (OpenAI / Anthropic / Gemini) is wrong. The body includes <code>upstream_status</code> and <code>upstream_body</code> verbatim.',
          '<code>tenant_disabled</code> &mdash; the tenant is suspended (billing or abuse). Contact <a href="mailto:dev@kolm.ai">support</a>.',
        ],
      },
      {
        h2: '429 rate limit',
        paragraphs: [
          'Two sources: the gateway’s own per-namespace quota, or the upstream provider’s rate limit. Headers distinguish them.',
        ],
        table: {
          headers: ['Header', 'Source', 'Action'],
          rows: [
            ['<code>X-Kolm-Quota-Reset</code>', 'Gateway namespace quota hit', 'Wait until midnight UTC or raise <code>quota_captures_per_day</code>.'],
            ['<code>Retry-After</code>', 'Upstream provider rate limit', 'Backoff per the header; fallback chain will try the next provider if configured.'],
            ['<code>X-Kolm-Free-Tier-Remaining: 0</code>', 'Hosted free-tier monthly cap hit', 'Upgrade or wait for monthly reset.'],
          ],
        },
        paragraphs2: [],
        code: `# Check current usage\nkolm usage --namespace default --since 1d\n# Free-tier monthly remaining\nkolm whoami --json | jq .free_tier`,
      },
      {
        h2: '502 upstream timeout / failure',
        paragraphs: [
          'The upstream provider did not respond within <code>[provider] timeout</code>, or returned 5xx, or the TCP connection failed. If a fallback chain is configured the gateway will have tried it; the 502 you see is after the entire chain exhausted. The receipt records every attempt with <code>fallback_reason</code>.',
        ],
        code: `# Inspect what was tried\nkolm captures get <receipt_cid> --json | jq '.attempts[]'\n# [\n#   {"provider":"openai","model":"gpt-4o","status":504,"latency_ms":30021,"reason":"timeout"},\n#   {"provider":"anthropic","model":"claude-sonnet-4-5","status":502,"latency_ms":1240,"reason":"upstream_5xx"},\n#   {"provider":"local-vllm","model":"qwen-3.6-7b","status":200,"latency_ms":840,"reason":"ok"}\n# ]`,
        list: [
          'Raise <code>[provider] timeout</code> if your prompts genuinely take longer than the default.',
          'Add a closer-region fallback (e.g. self-hosted vLLM) if hosted providers are flaky in your region.',
          'Check <a href="https://status.openai.com">provider status pages</a> &mdash; the gateway does not retry status-page outages.',
        ],
      },
      {
        h2: '503 capture write failure',
        paragraphs: [
          'The pipeline finished but stage 9 (capture) could not persist the receipt. The response is still returned to the caller; the 503 surfaces only on the next request if the capture backend stays unhealthy. Default behavior is non-blocking capture (<code>[capture] async = true</code>), so capture failures do not block traffic.',
        ],
        code: `# Backend-specific checks\n# JSONL: disk full?\ndf -h /var/kolm\n\n# SQLite: locked?\nsqlite3 /var/kolm/captures.db "PRAGMA integrity_check;"\n\n# Postgres: connection?\npsql $CONNECTION_URL -c "SELECT 1;"\n\n# S3: credentials?\naws s3 ls s3://your-capture-bucket --endpoint-url $MINIO_URL`,
        caveat: 'When capture is non-blocking and the backend is down, receipts are buffered in memory up to <code>[capture] max_buffer = 10000</code>. Beyond that, new requests get HTTP 503 with <code>capture_buffer_full</code>. Set <code>async = false</code> if you require capture durability before responding (adds ~3 ms p50).',
      },
      {
        h2: 'Diagnostic command',
        paragraphs: [
          'The CLI ships a one-shot diagnostic that probes every dependency.',
        ],
        code: `kolm doctor --gateway\n# checks:\n#   [OK]  gateway /v1/health reachable\n#   [OK]  signing key loaded, key_id=tenant_acme_v3\n#   [OK]  capture backend (postgres) reachable, rows=1248301\n#   [OK]  provider openai reachable, p95=420ms\n#   [WARN] provider anthropic returned 429 in last 5m (12 events)\n#   [OK]  telemetry exporter (otlp) reachable`,
      },
      {
        h2: 'Where to file a bug',
        paragraphs: [
          'Include the receipt CID (visible in <code>X-Kolm-Receipt-CID</code>) and the output of <code>kolm doctor --gateway --json</code>. Open an issue at <a href="https://github.com/kolm-ai/kolm/issues">github.com/kolm-ai/kolm/issues</a>.',
        ],
      },
    ],
    related: [
      { href: '/docs/gateway/quickstart', label: 'Quickstart' },
      { href: '/docs/gateway/configuration', label: 'Configuration' },
      { href: '/docs/gateway/self-host', label: 'Self-host' },
      { href: '/docs/routing/provider-failover', label: 'Provider failover' },
    ],
  },
];

// ---------- routing pages ---------------------------------------------------

const ROUTING_PAGES = [
  {
    slug: 'overview',
    title: 'Routing overview',
    description: 'What routing is in kolm: the decision layer that picks which model handles each call, why it matters for cost and privacy.',
    eyebrow: 'Routing overview',
    h1: 'Pick the cheapest model that still wins.',
    lede: 'Routing in kolm is the decision layer between the wrap endpoint and the upstream provider. Same request, smarter destination. Cost-aware by default, privacy-aware if you want it, learning-aware on the back end.',
    sections: [
      {
        h2: 'Why routing matters',
        paragraphs: [
          'Most LLM workloads have a long tail. The same prompt shape fires 50,000 times a month; 80% of those calls are easy and a small local model nails them; 20% are hard and need a frontier teacher. Sending all 50,000 to the frontier costs 5&ndash;25x more than necessary.',
          'Routing splits the call between a cheap local <strong>student</strong> and an expensive hosted <strong>teacher</strong>. The hard ones still get the teacher; the easy ones save you money and stay on your hardware (which matters when the prompt contains anything you would prefer not to ship to a third party).',
        ],
      },
      {
        h2: 'Three routing modes',
        table: {
          headers: ['Mode', 'How it decides', 'When to use'],
          rows: [
            ['<b>Pinned</b>', 'Header or namespace config forces a model.', 'Per-request override; legacy paths.'],
            ['<b>Fallback chain</b>', 'Primary model; fallback on 429 / 5xx / timeout.', 'Default. Buys availability.'],
            ['<b>Confidence-aware</b>', 'Local student probes; entropy threshold decides.', 'Cost optimization on repeated workflows.'],
          ],
        },
      },
      {
        h2: 'What you save',
        paragraphs: [
          'Measured on shipped customer workloads, the typical confidence-routed namespace runs 65&ndash;85% of calls on the local student and saves 60&ndash;90% of teacher cost vs. always-teacher. The exact number depends on how well your student handles your prompt distribution; we publish per-namespace receipts so you can verify, not just trust.',
        ],
      },
      {
        h2: 'Privacy as a side-effect',
        paragraphs: [
          'When 80% of calls stay on your local student, 80% of prompts never leave your network. For regulated workloads this matters more than the cost. Pair routing with PII redaction <code>redact_all</code> on the gateway and the model never sees the regulated fields either.',
        ],
      },
      {
        h2: 'How routing data feeds back',
        paragraphs: [
          'Every routing decision is a labeled training example. The student-handled calls confirm the student’s coverage; the teacher-handled calls (especially the ones with high entropy) become high-value seeds for the next round of distillation. The <a href="/docs/routing/active-learning">active learning</a> page details the flywheel.',
        ],
        caveat: 'Routing only saves money when the student is good enough. If your student’s K-Score on your eval set is below 0.85, run more distill iterations before turning confidence routing on; otherwise you ship low-quality answers on a third of your traffic.',
      },
    ],
    related: [
      { href: '/docs/routing/confidence-routing', label: 'Confidence routing' },
      { href: '/docs/routing/provider-failover', label: 'Provider failover' },
      { href: '/docs/routing/cost-attribution', label: 'Cost attribution' },
      { href: '/docs/routing/active-learning', label: 'Active learning' },
    ],
  },

  {
    slug: 'confidence-routing',
    title: 'Confidence routing',
    description: 'W807 entropy-based routing: the local student probes first-token uncertainty, escalates to the teacher only when above threshold.',
    eyebrow: 'Confidence routing (W807)',
    h1: 'Student probes first; teacher only on uncertainty.',
    lede: 'The local student computes the first-token distribution. If Shannon entropy is below the threshold, the student answers. If above, the request escalates to the teacher. One number (nats) decides every call.',
    sections: [
      {
        h2: 'The mechanism',
        paragraphs: [
          'When a request lands on a confidence-routed namespace, the gateway sends the prompt to the local student model (<code>local-kolm/&lt;artifact&gt;.kolm</code>) and asks for the first-token logits, not the completion. From the logits the gateway computes Shannon entropy in nats: <code>H = -&Sigma; p<sub>i</sub> log p<sub>i</sub></code>.',
          'Low entropy means the student is confident &mdash; the distribution concentrates on one or two tokens. High entropy means the student is uncertain &mdash; the distribution is spread thin. The threshold is a single scalar; below it the student completes the request; above it the request is forwarded to the teacher.',
        ],
        code: `# Pseudocode for the routing stage\nfirst_token_logits = student.probe(prompt)\np = softmax(first_token_logits)\nH = -sum(p[i] * log(p[i]) for i in vocab)   # nats\n\nif H <= namespace.confidence_threshold:\n    return student.complete(prompt)\nelse:\n    return teacher.complete(prompt)`,
      },
      {
        h2: 'Why first-token entropy works',
        paragraphs: [
          'Empirically, first-token uncertainty is the strongest signal of overall answer quality for repeated workflows. When the student knows the first token, it almost always knows the rest; when it does not, it tends to drift across the whole completion. We tested several alternatives (full-sequence perplexity, last-layer feature distance, retrieval-similarity) on the W807 eval set; first-token nats won on cost-quality Pareto frontier and was 100x cheaper to compute.',
        ],
      },
      {
        h2: 'The three profiles',
        paragraphs: [
          'Most users pick a profile rather than tuning the raw threshold. The profile maps to a fixed threshold; you can override.',
        ],
        table: {
          headers: ['Profile', 'Threshold (nats)', 'Typical student share', 'Quality vs. always-teacher'],
          rows: [
            ['<code>aggressive</code>', '0.85', '90&ndash;95%', '-2 to -4 K-Score points'],
            ['<code>balanced</code>', '0.70', '70&ndash;80%', '-0.5 to -2 K-Score points'],
            ['<code>conservative</code>', '0.55', '40&ndash;55%', 'Within noise of always-teacher'],
          ],
        },
      },
      {
        h2: 'Tuning the threshold yourself',
        paragraphs: [
          'Run <code>kolm bakeoff</code> on a held-out slice of recent captures. The bakeoff sweeps thresholds from 0.4 to 1.0 in 0.05 steps and reports K-Score + student share at each. Pick the threshold where K-Score crosses your acceptable floor.',
        ],
        code: `kolm bakeoff confidence \\\n  --namespace customer-support \\\n  --student local-kolm/support-v3.kolm \\\n  --teacher openai/gpt-4o \\\n  --eval-from captures:last-1000 \\\n  --threshold-sweep 0.4:1.0:0.05\n\n# threshold  student_share  K-Score  cost_per_1k\n#     0.40         42%        0.94      $0.84\n#     0.55         55%        0.93      $0.65\n#     0.70         74%        0.91      $0.42\n#     0.85         92%        0.86      $0.18\n#     1.00         99%        0.71      $0.02`,
      },
      {
        h2: 'Why local-first matters',
        paragraphs: [
          'The threshold can be set arbitrarily aggressively (a higher number sends more traffic local). At the extreme &mdash; threshold = infinity &mdash; everything stays local; the teacher is never called. This is the air-gapped configuration: the gateway can route 100% of traffic without any outbound calls. Useful for sensitive deployments and for offline development.',
          'Even in a mixed deployment, the local-first split means most prompts never cross your network boundary. The receipts mark each row with <code>route = student | teacher</code> so a compliance auditor can confirm the split.',
        ],
        caveat: 'The probe adds ~30 ms p50 for a 7B student on an RTX-class GPU. If your namespace is latency-critical (sub-100 ms total), skip confidence routing and use a fallback chain instead. The probe runs every call &mdash; it is not amortized across the completion.',
      },
    ],
    related: [
      { href: '/docs/routing/overview', label: 'Routing overview' },
      { href: '/docs/routing/cost-attribution', label: 'Cost attribution' },
      { href: '/docs/routing/active-learning', label: 'Active learning' },
      { href: '/docs/gateway/routing-rules', label: 'Routing rules' },
    ],
  },

  {
    slug: 'provider-failover',
    title: 'Provider failover',
    description: 'Fallback chain on 429 / timeout / 5xx with a documented retry budget. Same chain syntax for hosted and local providers.',
    eyebrow: 'Provider failover',
    h1: 'Ordered fallback on every retryable failure.',
    lede: 'Declare a primary plus an ordered fallback chain in <code>gateway.toml</code>. On 429, 502, 503, 504, or network timeout the gateway walks the chain in order until one succeeds or the retry budget is exhausted.',
    sections: [
      {
        h2: 'What counts as retryable',
        paragraphs: [
          'The gateway distinguishes retryable from terminal failures. Only retryable failures trigger the fallback chain; terminal failures (400 bad request, 401 unauthorized, 422 unprocessable) propagate to the caller because retrying the same request against a different provider will produce the same error.',
        ],
        table: {
          headers: ['Status / event', 'Retryable?', 'Default backoff'],
          rows: [
            ['<code>429</code> rate limit', 'Yes', 'Respect <code>Retry-After</code> header.'],
            ['<code>500</code> upstream error', 'Yes', '100ms + exponential.'],
            ['<code>502</code> bad gateway', 'Yes', '100ms + exponential.'],
            ['<code>503</code> service unavailable', 'Yes', '500ms + exponential.'],
            ['<code>504</code> upstream timeout', 'Yes', 'Immediate next provider.'],
            ['network timeout', 'Yes', 'Immediate next provider.'],
            ['TCP reset', 'Yes', 'Immediate next provider.'],
            ['<code>400</code> bad request', 'No', '&mdash; (propagates).'],
            ['<code>401</code> unauthorized', 'No', '&mdash; (propagates).'],
            ['<code>403</code> forbidden', 'No', '&mdash; (propagates).'],
            ['<code>404</code> not found', 'No', '&mdash; (propagates).'],
            ['<code>422</code> unprocessable', 'No', '&mdash; (propagates).'],
          ],
        },
      },
      {
        h2: 'Retry budget',
        paragraphs: [
          'The chain has a budget that caps total attempts. Defaults to <code>retry_budget = 3</code>. If the chain is longer than the budget, the gateway walks the chain in order until the budget runs out. A failed attempt counts against the budget even if it returns immediately (network refused).',
        ],
        code: `[[namespace]]\nname           = "production-rag"\nprimary        = "openai/gpt-4o"\nfallback       = [\n  "anthropic/claude-sonnet-4-5",   # tried on primary failure\n  "deepseek/deepseek-v3.1",        # tried if claude also fails\n  "local-vllm/qwen-3.6-27b"        # last-ditch local fallback\n]\nretry_budget   = 4\nretry_backoff  = "exponential"     # exponential | linear | none\nretry_jitter   = "0.1"             # 10% jitter on backoff`,
      },
      {
        h2: 'Fallback receipts',
        paragraphs: [
          'Every fallback attempt is recorded on the receipt under <code>attempts[]</code>. The final attempt that succeeded is the canonical response; previous attempts include the upstream status, latency, and reason. Use this to debug flaky providers and to feed the active-learning loop.',
        ],
        code: `kolm captures get <receipt_cid> --json | jq '.attempts'\n[\n  {"provider":"openai","model":"gpt-4o","status":429,"reason":"rate_limit","latency_ms":12},\n  {"provider":"anthropic","model":"claude-sonnet-4-5","status":200,"reason":"ok","latency_ms":847}\n]`,
      },
      {
        h2: 'Per-request override',
        paragraphs: [
          'A caller can disable fallback for one request (useful when the application has its own retry policy and does not want a slower fallback masking a primary outage).',
        ],
        code: `curl https://kolm.ai/v1/wrap/openai/chat/completions \\\n  -H "X-Kolm-No-Fallback: true" \\\n  ...`,
      },
      {
        h2: 'Health-based pre-emptive skip',
        paragraphs: [
          'Optionally, the gateway can skip a fallback entry that has failed N times in the last M seconds (circuit breaker). Off by default; opt in per namespace.',
        ],
        code: `[[namespace]]\nname                 = "production-rag"\nprimary              = "openai/gpt-4o"\nfallback             = ["anthropic/claude-sonnet-4-5", "deepseek/deepseek-v3.1"]\ncircuit_breaker      = true\ncircuit_window       = "60s"\ncircuit_threshold    = 5            # 5 failures in 60s opens the circuit\ncircuit_reset        = "30s"        # try again after 30s`,
        caveat: 'Circuit breakers can mask transient flapping that you would want to see. Pair with telemetry alerts on <code>kolm_circuit_open</code> events so you know when a provider is being skipped.',
      },
    ],
    related: [
      { href: '/docs/routing/overview', label: 'Routing overview' },
      { href: '/docs/gateway/routing-rules', label: 'Routing rules' },
      { href: '/docs/gateway/troubleshooting', label: 'Troubleshooting' },
    ],
  },

  {
    slug: 'cost-attribution',
    title: 'Cost attribution',
    description: 'Per-namespace cost breakdown and the cost-saved metric. Receipts carry USD; the dashboard rolls them up by tenant, namespace, model, and route decision.',
    eyebrow: 'Cost attribution',
    h1: 'Every dollar attributed to a namespace, model, and decision.',
    lede: 'Every receipt carries <code>cost_usd</code>, <code>tokens_in</code>, <code>tokens_out</code>, and the route decision that picked the model. The dashboard rolls them into per-namespace, per-model, and per-decision views; the CLI prints the same data.',
    sections: [
      {
        h2: 'What the receipt stores',
        paragraphs: [
          'Pricing is computed at receipt time using the published rate card for each provider + model + tier. The rate card ships in the gateway image and is refreshed on each release; you can override per provider for negotiated rates.',
        ],
        table: {
          headers: ['Field', 'Type', 'Source'],
          rows: [
            ['<code>cost_usd</code>', 'float', 'tokens × rate card.'],
            ['<code>tokens_in</code>', 'int', 'From provider response, or local count if not returned.'],
            ['<code>tokens_out</code>', 'int', 'From provider response, or local count if not returned.'],
            ['<code>provider</code>', 'string', 'Provider slug that handled the call.'],
            ['<code>model</code>', 'string', 'Model identifier.'],
            ['<code>route_decision</code>', 'string', 'pinned / fallback / student / teacher.'],
            ['<code>cost_saved_usd</code>', 'float', '(teacher rate - student rate) × tokens, when student handled it.'],
          ],
        },
      },
      {
        h2: 'Dashboard breakdown',
        paragraphs: [
          'The Account dashboard at <a href="/account/billing">/account/billing</a> rolls receipts up four ways: by tenant, by namespace, by model, by route decision. Pivot on any combination; export to CSV or chargeback report.',
        ],
        code: `# Pull the same data from the CLI\nkolm cost --by namespace --since 30d\nkolm cost --by model --since 30d --json\nkolm cost --by decision --namespace customer-support --since 7d`,
      },
      {
        h2: 'The cost-saved metric',
        paragraphs: [
          'When the student handles a call, the receipt records <code>cost_saved_usd</code> as the difference between what the teacher would have cost and what the student actually cost. Summed across the namespace it is the dollar saving from confidence routing. The dashboard headline number is this sum over the trailing 30 days.',
        ],
        code: `# Example: a confidence-routed namespace over 30 days\n# 142,000 calls, 78% student-handled\n#\n# kolm cost --by decision --namespace customer-support --since 30d\n#\n# decision     calls    cost_usd   cost_saved_usd\n# student      110,760     22.15        842.30\n# teacher       31,240    194.45          0.00\n# ----------------------------------------------\n# total        142,000    216.60        842.30\n#\n# Effective rate: $1.53 per 1k calls (vs. $7.45 always-teacher)\n# Saving: 79.5% of teacher-only baseline`,
      },
      {
        h2: 'Chargeback to internal teams',
        paragraphs: [
          'Map namespaces to internal cost centers and run <code>kolm chargeback</code> to produce a per-cost-center bill. The output is a CSV ready to feed your finance system.',
        ],
        code: `# namespace -> cost center mapping in ~/.kolm/chargeback.toml\n[mapping]\n"support-bot"     = "CC-1001-customer-success"\n"rag-pipeline"    = "CC-1042-product-eng"\n"dev-sandbox"     = "CC-9000-engineering"\n\n# generate the bill\nkolm chargeback --month 2026-05 --out chargeback-2026-05.csv`,
      },
      {
        h2: 'Negotiated provider rates',
        paragraphs: [
          'If your enterprise OpenAI / Anthropic contract has discounted rates, override per provider so cost attribution reflects reality.',
        ],
        code: `[[provider]]\nname        = "openai"\nbase_url    = "https://api.openai.com/v1"\nauth_scheme = "bearer_passthrough"\n\n# per-model overrides (USD per 1M tokens)\n[provider.rate_override."gpt-4o"]\ninput_per_1m  = 2.00       # default 2.50\noutput_per_1m = 8.00       # default 10.00`,
        caveat: 'Cost attribution assumes the request reached the upstream provider. Requests that the gateway rejected pre-forward (PII block, quota, auth) carry <code>cost_usd = 0</code>. The metered usage and the provider invoice should reconcile within tokens but may differ on edge cases like cached prompts; reconcile monthly against the provider invoice.',
      },
    ],
    related: [
      { href: '/docs/routing/overview', label: 'Routing overview' },
      { href: '/docs/routing/confidence-routing', label: 'Confidence routing' },
      { href: '/docs/gateway/configuration', label: 'Configuration' },
    ],
  },

  {
    slug: 'active-learning',
    title: 'Active learning flywheel',
    description: 'Every fallback and every high-entropy teacher call becomes a high-value capture seed for the next distill iteration. The flywheel closes the cost loop.',
    eyebrow: 'Active learning',
    h1: 'Every fallback is a training signal.',
    lede: 'A teacher-handled call (because the student was uncertain) is the most valuable training example you can collect &mdash; it is exactly where the student needs to improve. The gateway tags those captures and feeds them straight into the next distill iteration.',
    sections: [
      {
        h2: 'The loop',
        paragraphs: [
          'Routing produces two kinds of receipts: student-handled (the student was confident; the answer was cheap) and teacher-handled (the student was uncertain; the answer was expensive). The teacher-handled receipts are the gold seed set for the next round of distillation, because they are the exact prompts the current student does not yet cover.',
        ],
        code: `      [gateway]\n         |\n   ------+-------\n   |             |\nstudent      teacher\n confident   uncertain (high nats)\n   |             |\n   |             v\n   |   [tagged: active_learning_seed=true]\n   |             |\n   |             v\n   |   [accumulated in capture lake]\n   |             |\n   |             v\n   |   kolm distill --seed-tag active_learning_seed\n   |             |\n   |             v\n   |   new .kolm artifact (covers what previous missed)\n   |             |\n   |             v\n   +-----[deployed back to local-kolm provider]`,
      },
      {
        h2: 'Tagging and surfacing seeds',
        paragraphs: [
          'High-entropy teacher captures are auto-tagged with <code>active_learning_seed: true</code> and surfaced in the <a href="/account/active-learning">/account/active-learning</a> dashboard. The dashboard groups them by prompt-template similarity so you can see which weak spots are repeated.',
        ],
        code: `# List candidate seeds for the next distill\nkolm seeds list --namespace customer-support --min-entropy 0.85 --limit 200\n\n# Inspect a cluster of similar seeds\nkolm seeds cluster --namespace customer-support --threshold 0.9 --json | jq .clusters[0]`,
      },
      {
        h2: 'Triggering a distill iteration',
        paragraphs: [
          'Feed the tagged seeds straight into <code>kolm distill</code>. The compiler produces a new artifact; you redeploy by updating the <code>local-kolm</code> provider <code>base_url</code> to the new artifact path and reloading the gateway.',
        ],
        code: `kolm distill \\\n  --namespace customer-support \\\n  --seed-tag active_learning_seed \\\n  --teacher openai/gpt-4o \\\n  --base-student Qwen2.5-7B-Instruct \\\n  --eval-from captures:last-500 \\\n  --output support-v4.kolm\n\n# Verify before deploying\nkolm verify support-v4.kolm\n# K-Score: 0.91 (was 0.87) on 500-row eval\n# Student share at threshold 0.7: 84% (was 74%)\n\n# Redeploy\nkolm gateway provider update local-kolm-support \\\n  --base-url file:///var/kolm/artifacts/support-v4.kolm\nkolm gateway reload`,
      },
      {
        h2: 'Convergence behavior',
        paragraphs: [
          'Each iteration shrinks the teacher share. Typical trajectory on a 50k-capture / month workflow: v1 student handles 60%, v2 handles 75%, v3 handles 85%, then asymptote near 90% with the residual being genuinely novel prompts that need the frontier model.',
        ],
        table: {
          headers: ['Iteration', 'Seed count', 'K-Score', 'Student share', 'Cost-saved / month'],
          rows: [
            ['v1', '0 (cold start)', '0.83', '60%', '$420'],
            ['v2', '480 (active-learning)', '0.88', '75%', '$640'],
            ['v3', '320 (active-learning)', '0.91', '85%', '$780'],
            ['v4', '110 (active-learning)', '0.92', '88%', '$820'],
          ],
        },
      },
      {
        h2: 'Avoiding loop pathologies',
        list: [
          '<b>Drift detection</b> &mdash; if a new prompt-template appears in the active-learning queue without prior history, the dashboard flags it; do not auto-distill blindly.',
          '<b>Poison filter</b> &mdash; the capture lake runs the five poison signals (output_length_anomaly, embedding_anomaly, injection_pattern, inconsistent_labels, synthetic_spam) on every seed; flagged rows are excluded from the next iteration by default.',
          '<b>Held-out eval</b> &mdash; a frozen 500-row eval set is never used as a seed; the K-Score is measured on it across all iterations to detect quality regression.',
        ],
        caveat: 'Active learning amplifies whatever bias is in the teacher. If the teacher gets a class of queries wrong, the student will learn the same mistake. Pair with a periodic teacher-bakeoff (different teacher on the same seeds) to catch teacher bias before it ossifies into the student.',
      },
    ],
    related: [
      { href: '/docs/routing/overview', label: 'Routing overview' },
      { href: '/docs/routing/confidence-routing', label: 'Confidence routing' },
      { href: '/docs/routing/cost-attribution', label: 'Cost attribution' },
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
  if (!fs.existsSync(GATEWAY_DIR)) fs.mkdirSync(GATEWAY_DIR, { recursive: true });
  if (!fs.existsSync(ROUTING_DIR)) fs.mkdirSync(ROUTING_DIR, { recursive: true });

  const written = [];
  for (const p of GATEWAY_PAGES) written.push(writePage(GATEWAY_DIR, 'gateway', p));
  for (const p of ROUTING_PAGES) written.push(writePage(ROUTING_DIR, 'routing', p));

  for (const f of written) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    console.log(`wrote ${rel}`);
  }
  console.log(`\n${written.length} pages written.`);
}

if (require.main === module) main();

module.exports = { GATEWAY_PAGES, ROUTING_PAGES, pageShell };
