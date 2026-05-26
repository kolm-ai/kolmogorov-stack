#!/usr/bin/env node
// W887 W-I docs generator — produces the 16 gateway-* docs pages + /gateway product page
// from a single content manifest. Bodies are written from the W-A..W-J.b implementation
// (src/wrapper-cli.js + src/router.js gateway routes + tests/wrapper-*.test.js) so the
// docs match the actual code.

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function page({ slug, title, desc, eyebrow, h1, lede, sections, related }) {
  const canonical = `https://kolm.ai/docs/${slug}`;
  const crumbs = `<div class="crumbs"><a href="/">kolm.ai</a> / <a href="/docs">docs</a> / ${slug}</div>`;
  const body = sections.map((s) => {
    const id = s.h2.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `<h2 id="${id}">${s.h2}</h2>\n${s.html}`;
  }).join('\n\n');
  const relatedHtml = related.map((r) => `  <a href="${r.href}"><b>${r.title} &rarr;</b><span>${r.blurb}</span></a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}}catch(e){}})();</script> // deliberate: cleanup
<title>${title} &middot; kolm.ai</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#0e1116" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f3f5f7" media="(prefers-color-scheme: light)">
<meta property="og:title" content="${title} &middot; kolm.ai">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://kolm.ai/brand-hero.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title} &middot; kolm.ai">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://kolm.ai/brand-hero.png">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"TechArticle","headline":"${title.replace(/"/g,'\\"')}","description":"${desc.replace(/"/g,'\\"')}","url":"${canonical}","datePublished":"2026-05-26","dateModified":"2026-05-26","author":{"@type":"Organization","name":"kolm.ai"},"publisher":{"@type":"Organization","name":"kolm.ai"}}</script>
<link rel="stylesheet" href="/design-tokens.css">
<style>
:root{--ink:#e6e9ee;--ink-mute:#aab0b8;--ink-faint:#6a727c;--line:rgba(230,233,238,0.08);--bg:#0b0d10;--bg-elev:#101316;--accent:#111111;--accent-soft:rgba(17,17,17,0.10);--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
[data-theme=light]{--ink:#1f2429;--ink-mute:#4b5158;--ink-faint:#6a727c;--line:rgba(0,0,0,0.08);--bg:#f3f5f7;--bg-elev:#ffffff;--accent:#059669;--accent-soft:rgba(5,150,105,0.10)}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,Inter,system-ui,sans-serif;margin:0}
.skip-link{position:absolute;left:-9999px}
.skip-link:focus{position:static;background:var(--accent);color:#fff;padding:8px 14px}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
main{padding:48px 0 96px}
.crumbs{font-family:var(--mono);font-size:11.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 18px}
.crumbs a{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:var(--accent);margin:0 0 14px}
h1{font-size:42px;line-height:1.08;font-weight:500;letter-spacing:-0.02em;margin:0 0 18px;max-width:920px}
.lede{font-size:18px;line-height:1.55;color:var(--ink-mute);max-width:780px;margin:0 0 36px}
h2{font-size:24px;font-weight:500;letter-spacing:-0.018em;margin:48px 0 12px;max-width:780px;scroll-margin-top:80px}
h3{font-size:16px;font-weight:500;letter-spacing:-0.01em;margin:28px 0 8px;max-width:780px}
p{color:var(--ink-mute);font-size:15px;line-height:1.65;max-width:780px}
pre{background:#06080a;color:#e9eef3;border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow-x:auto;font:12.5px/1.55 var(--mono);margin:14px 0 18px}
pre code{background:none;border:none;padding:0;color:inherit;font:inherit}
code{font-family:var(--mono);font-size:13px;color:var(--ink);background:var(--bg-elev);padding:1px 6px;border-radius:4px;border:1px solid var(--line)}
ul,ol{color:var(--ink-mute);font-size:15px;line-height:1.7;max-width:780px}
li{margin:4px 0}
table{border-collapse:collapse;width:100%;max-width:920px;margin:14px 0;font-size:13.5px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink);font-weight:500}
td code{font-size:12px}
.related{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}
@media(max-width:820px){.related{grid-template-columns:1fr}}
.related a{padding:16px 18px;border:1px solid var(--line);border-radius:10px;background:var(--bg-elev);text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:4px}
.related a:hover{border-color:var(--accent-soft)}
.related b{font-size:14px;color:var(--ink);font-weight:500}
.related span{font-size:12.5px;color:var(--ink-mute);line-height:1.5}
.privacy-note{border-left:3px solid var(--accent);background:var(--accent-soft);padding:14px 18px;margin:18px 0;border-radius:0 8px 8px 0;max-width:780px}
.privacy-note strong{color:var(--ink)}
</style>
<link rel="stylesheet" href="/ks.css">
<link rel="stylesheet" href="/docs-shell.css">
<link rel="stylesheet" href="/warm-paper.css">
<script defer src="/docs-shell.js"></script>
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
      <a href="/signup" class="ks-btn ks-btn--primary ks-btn--sm">Get started <span class="ks-btn-arrow">&rarr;</span></a>
    </div>
  </nav>
</div>

<main id="main" tabindex="-1"><div class="wrap">

${crumbs}
<p class="eyebrow">${eyebrow}</p>
<h1>${h1}</h1>
<p class="lede">${lede}</p>

${body}

<div class="related">
${relatedHtml}
</div>

</div></main>

<footer class="ks-footer">
  <div class="ks-wrap">
    <div class="ks-footer__grid">
      <div>
        <a href="/" class="ks-nav__brand"><span class="ks-nav__mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" role="img" aria-label="kolm"><rect x="4" y="6" width="4.5" height="20" rx="0.4"/><rect x="13" y="9" width="4.5" height="14" rx="0.4"/><rect x="22" y="12" width="4.5" height="8" rx="0.4"/></svg></span><span>kolm<b>.ai</b></span></a>
        <p class="ks-footer__tagline">Compile any AI model. Run it anywhere.</p>
      </div>
      <div>
        <h4>Wrapper</h4>
        <ul><li><a href="/wrapper">Overview</a></li><li><a href="/gateway">Gateway</a></li><li><a href="/capture">Capture</a></li><li><a href="/security">Security &amp; receipts</a></li><li><a href="/docs/gateway">Gateway docs</a></li></ul>
      </div>
      <div>
        <h4>Studio</h4>
        <ul><li><a href="/studio">Overview</a></li><li><a href="/distill">Distill</a></li><li><a href="/compile">Compile</a></li><li><a href="/k-score">k-score</a></li><li><a href="/models">Models</a></li></ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul><li><a href="/pricing">Pricing</a></li><li><a href="/docs">Docs</a></li><li><a href="/manifesto">Manifesto</a></li><li><a href="/changelog">Changelog</a></li><li><a href="https://github.com/kolm-ai/kolm" rel="noopener">GitHub</a></li></ul>
      </div>
    </div>
    <div class="ks-footer__bottom">
      <span>&copy; 2026 kolm.ai &middot; Apache-2.0 &middot; <a href="/legal">Legal</a> &middot; <a href="/security">Security</a></span>
    </div>
  </div>
</footer>

</body>
</html>
`;
}

const docs = [
  {
    slug: 'gateway',
    title: 'Gateway — the wrapper around any LLM provider',
    desc: 'The kolm gateway sits in front of 11 LLM providers (OpenAI, Anthropic, Google, DeepSeek, Groq, Together, Fireworks, OpenRouter, local-vLLM, local-Ollama, local-kolm), signs an Ed25519 receipt on every call, captures the trace for replay, and routes locally-first via a confidence gate.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'One wrapper. Eleven providers. Every call signed.',
    lede: 'The kolm gateway is the receipt-signed, capture-on, locally-first proxy in front of every LLM you call. <code>POST /v1/gateway/dispatch</code> takes an OpenAI-shaped request, walks a namespace-configured routing chain (local artifact → frontier fallback), runs the response through a 4-mode PII redactor + 5-signal poison detector, signs a 19-field <code>kolm-audit-1</code> receipt with Ed25519, and stamps a capture row that can be approved into a training set.',
    sections: [
      {
        h2: 'What the gateway adds on top of a raw provider call',
        html: `<p>The minimum surface to call a frontier LLM in production is a key, a URL, and a retry loop. The kolm gateway is the next layer up — what you'd otherwise build over six months as your wrapper grows. Every dispatch goes through these stages:</p>
<table>
  <thead><tr><th>Stage</th><th>What it does</th><th>Code path</th></tr></thead>
  <tbody>
    <tr><td>1. PII scan on input</td><td>4 modes (detect / redact / block / off) over 11 entity types: email, phone, ssn, credit card, ipv4/v6, JWT, API key, AWS key, OpenAI key, address.</td><td><code>src/wrapper-cli.js:_runPiiScan</code></td></tr>
    <tr><td>2. Namespace resolve</td><td>Reads <code>~/.kolm/namespaces/&lt;ns&gt;.json</code> for the routing chain (local-first artifact + frontier fallback).</td><td><code>src/wrapper-cli.js:_nsRead</code></td></tr>
    <tr><td>3. Confidence-routed dispatch</td><td>Tries the head of the chain. If confidence &lt; threshold, falls back to the next provider and marks <code>capture_eligible:true</code> so the trace becomes a training candidate.</td><td><code>src/wrapper-cli.js:dispatchToProvider</code> + W807 ConfidenceRouter</td></tr>
    <tr><td>4. PII redact on output</td><td>Same modes; <code>redact_captures</code> additionally scrubs the capture body before lake-write.</td><td><code>src/wrapper-cli.js:_runPiiScan</code> (output pass)</td></tr>
    <tr><td>5. Receipt sign</td><td>Builds the 19-field <code>kolm-audit-1</code> envelope; signs with Ed25519 (rotatable key); chains <code>prev_chain_hash</code> via HMAC over sorted-key JSON.</td><td><code>src/wrapper-cli.js:_buildReceipt</code></td></tr>
    <tr><td>6. Lake write</td><td>Appends a capture row to the configured backend (JSONL / SQLite / Postgres / S3) with hash-chain integrity.</td><td><code>src/wrapper-cli.js:_capturesAppend</code></td></tr>
  </tbody>
</table>
<p>The first response byte ships ~3–8 ms after the upstream call returns (W-J.b <code>--report-latency</code> measurement). That overhead buys you receipts, captures, PII scrubbing, and namespace routing — every call, every namespace, every provider.</p>`,
      },
      {
        h2: 'Minimal example',
        html: `<pre><code>curl -X POST https://kolm.ai/v1/gateway/dispatch \\
  -H "authorization: Bearer $KOLM_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 96,
    "messages": [{"role":"user","content":"hi"}]
  }'

# Response shape: { ...openai-style body..., "kolm_receipt": { /* 19 fields */ } }</code></pre>
<p>Verify the receipt from anywhere:</p>
<pre><code>curl https://kolm.ai/v1/verify/&lt;receipt_id&gt;
# returns { ok: true, schema: "kolm-audit-1", ...full receipt..., signature_valid: true }</code></pre>`,
      },
      {
        h2: 'Where to go next',
        html: `<p>Pick the doc that matches the stage you're configuring. Every page links the matching CLI verb, HTTP route, and test fixture so you can verify from code.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-providers', title: 'Providers', blurb: '11 adapter shapes (OpenAI, Anthropic, Groq, Ollama, vLLM, ...)' },
      { href: '/docs/gateway-receipts', title: 'Receipts', blurb: 'Ed25519, kolm-audit-1 schema, key rotation, online + offline verify.' },
      { href: '/docs/gateway-captures', title: 'Captures', blurb: 'Hash-chain lake; JSONL / SQLite / Postgres / S3 backends.' },
    ],
  },

  {
    slug: 'gateway-providers',
    title: 'Gateway providers — 11 adapter shapes',
    desc: 'OpenAI, Anthropic, Google (Gemini), DeepSeek, Groq, Together, Fireworks, OpenRouter, local-vLLM, local-Ollama, local-kolm. Same OpenAI-shaped input; per-provider routing rules.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Eleven providers. One shape.',
    lede: 'Every gateway call uses an OpenAI-shaped request (<code>model</code>, <code>messages</code>, <code>max_tokens</code>) and the gateway picks the adapter from the model name or an explicit <code>provider</code> field. The adapter list covers every frontier provider that ships an HTTP API, plus two local backends (vLLM, Ollama) and the local-kolm artifact path.',
    sections: [
      {
        h2: 'The 11 adapters',
        html: `<table>
  <thead><tr><th>Provider</th><th>Models</th><th>Env var (any case)</th><th>Best for</th></tr></thead>
  <tbody>
    <tr><td><code>anthropic</code></td><td>claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5</td><td><code>ANTHROPIC_API_KEY</code></td><td>Highest-quality reasoning + long context.</td></tr>
    <tr><td><code>openai</code></td><td>gpt-5, gpt-5-mini, gpt-4o, gpt-4o-mini, o-series</td><td><code>OPENAI_API_KEY</code></td><td>General-purpose; cheapest mini tier.</td></tr>
    <tr><td><code>google</code></td><td>gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-*</td><td><code>GOOGLE_API_KEY</code> or <code>GEMINI_API_KEY</code></td><td>2M-token context; multimodal.</td></tr>
    <tr><td><code>deepseek</code></td><td>deepseek-v4, deepseek-r1-*, deepseek-coder</td><td><code>DEEPSEEK_API_KEY</code></td><td>Strongest open-weights reasoning; cheap.</td></tr>
    <tr><td><code>groq</code></td><td>llama-3.3-70b, mixtral-8x7b, deepseek-r1-distill-llama-70b</td><td><code>GROQ_API_KEY</code></td><td>Sub-200ms latency; LPU-backed.</td></tr>
    <tr><td><code>together</code></td><td>llama-3.3-70b, qwen2.5-72b, mixtral-8x22b, ...</td><td><code>TOGETHER_API_KEY</code></td><td>OSS frontier at scale.</td></tr>
    <tr><td><code>fireworks</code></td><td>llama-v3p3-70b, qwen2p5-72b, deepseek-v4, ...</td><td><code>FIREWORKS_API_KEY</code></td><td>Speculative-decoded OSS frontier.</td></tr>
    <tr><td><code>openrouter</code></td><td>any model via <code>openrouter/&lt;org&gt;/&lt;model&gt;</code></td><td><code>OPENROUTER_API_KEY</code></td><td>One key, every provider.</td></tr>
    <tr><td><code>local-vllm</code></td><td>any HF model loaded into vLLM</td><td><code>KOLM_VLLM_URL</code> (default <code>http://localhost:8000</code>)</td><td>Multi-GPU local frontier; OpenAI-compat API.</td></tr>
    <tr><td><code>local-ollama</code></td><td>any model pulled into Ollama</td><td><code>KOLM_OLLAMA_URL</code> (default <code>http://localhost:11434</code>)</td><td>Single-GPU desktop dev; one-liner setup.</td></tr>
    <tr><td><code>local-kolm</code></td><td>any <code>.kolm</code> artifact (distilled local model)</td><td><code>KOLM_ARTIFACT_DIR</code> (default <code>~/.kolm/artifacts</code>)</td><td>Trinity-500, custom distill, $0 + ~1.24s latency.</td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'Picking an adapter',
        html: `<p>The gateway picks the adapter in this order:</p>
<ol>
  <li>Explicit <code>provider:</code> field on the request.</li>
  <li>Namespace routing chain (set via <code>kolm namespace config &lt;ns&gt; --provider ...</code>) — the head of the chain wins; confidence gate decides whether to fall back to the next entry.</li>
  <li>Model-name prefix: <code>claude-*</code> → anthropic, <code>gpt-*</code> → openai, <code>gemini-*</code> → google, <code>deepseek-*</code> → deepseek, <code>llama-*</code> + presence of <code>GROQ_API_KEY</code> → groq, else <code>together</code>.</li>
  <li>Hard default: <code>anthropic</code> with <code>claude-haiku-4-5</code>.</li>
</ol>`,
      },
      {
        h2: 'Env-var case fallback (W887.1)',
        html: `<p>The gateway walks four env-var case variants in order for every provider key — useful on platforms (Vercel, Railway, fly.io) that normalize env names to lowercase. For Anthropic the search order is:</p>
<pre><code>ANTHROPIC_API_KEY        # canonical
anthropic_api_key        # Vercel-lower
ANTHROPIC_KEY            # short form
anthropic_key            # short lower</code></pre>
<p>This makes <code>vercel env add anthropic_api_key</code> Just Work without a deploy-time rename.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-confidence-router', title: 'Confidence router', blurb: 'How the namespace chain decides when to fall back to frontier.' },
      { href: '/docs/gateway-namespaces', title: 'Namespaces', blurb: 'Per-namespace provider chain, PII mode, capture policy.' },
      { href: '/docs/gateway-toml', title: 'gateway.toml', blurb: 'File-form of every provider + namespace setting.' },
    ],
  },

  {
    slug: 'gateway-receipts',
    title: 'Gateway receipts — Ed25519, kolm-audit-1 schema',
    desc: 'Every /v1/gateway/dispatch call is stamped with a 19-field kolm-audit-1 receipt signed with Ed25519. Verify online (/v1/verify/:id) or offline with the public key.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Every call gets a receipt. Every receipt is signed.',
    lede: 'The receipt is the proof. It records what was asked, what was returned (as hashes, not content), which provider answered, the routing decision, the capture decision, and the cost — then signs the whole envelope with Ed25519. Verify online or offline. Rotate the key without breaking old receipts (the public key is embedded in each signature block).',
    sections: [
      {
        h2: 'The 19 fields',
        html: `<table>
  <thead><tr><th>Field</th><th>What it is</th></tr></thead>
  <tbody>
    <tr><td><code>schema</code></td><td>Always <code>"kolm-audit-1"</code>. Tag in case the schema evolves.</td></tr>
    <tr><td><code>receipt_id</code></td><td><code>rcpt_</code> + ULID. URL-safe primary key.</td></tr>
    <tr><td><code>timestamp</code></td><td>ISO-8601 UTC.</td></tr>
    <tr><td><code>namespace_id</code></td><td>Which gateway namespace handled the call (e.g. <code>default</code>, <code>support</code>, <code>code</code>).</td></tr>
    <tr><td><code>route_decision</code></td><td><code>"frontier"</code> | <code>"local"</code> | <code>"fallback"</code> — what the confidence router picked.</td></tr>
    <tr><td><code>provider</code></td><td>Resolved adapter (<code>anthropic</code>, <code>openai</code>, <code>local-kolm</code>, ...).</td></tr>
    <tr><td><code>model</code></td><td>Resolved model name (after namespace + env mapping).</td></tr>
    <tr><td><code>artifact_id</code></td><td>If <code>local-kolm</code>: which <code>.kolm</code> artifact answered. Else <code>null</code>.</td></tr>
    <tr><td><code>confidence</code></td><td>Router confidence in [0, 1]. <code>null</code> if not measured.</td></tr>
    <tr><td><code>fallback_reason</code></td><td>If <code>route_decision == "fallback"</code>: <code>"low_confidence"</code> | <code>"local_error"</code> | <code>"no_local"</code>.</td></tr>
    <tr><td><code>input_hash</code></td><td><code>sha256:</code> of the canonical request body.</td></tr>
    <tr><td><code>output_hash</code></td><td><code>sha256:</code> of the response text.</td></tr>
    <tr><td><code>capture_eligible</code></td><td>True if the call qualifies for the training-set capture lake.</td></tr>
    <tr><td><code>capture_id</code></td><td>If a capture row was written: its ID. Else <code>null</code>.</td></tr>
    <tr><td><code>redaction_applied</code></td><td>Array of entities scrubbed by the PII redactor.</td></tr>
    <tr><td><code>input_tokens</code></td><td>From the provider's usage block.</td></tr>
    <tr><td><code>output_tokens</code></td><td>Same.</td></tr>
    <tr><td><code>cost_usd</code></td><td>From the price table for this provider/model.</td></tr>
    <tr><td><code>signing_key_id</code></td><td>Fingerprint of the Ed25519 key that signed this receipt. Survives key rotation.</td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'Verify online',
        html: `<pre><code>curl https://kolm.ai/v1/verify/rcpt_01KYC1R5YQ072KSDVW6QJM
# {
#   "ok": true,
#   "schema": "kolm-audit-1",
#   "receipt_id": "...",
#   "signature_valid": true,
#   "signed_by": "current_key",     # or "previous_key" if rotated
#   ...full receipt body...
# }</code></pre>`,
      },
      {
        h2: 'Verify offline',
        html: `<p>Every signature block embeds the public key that signed it, so receipts verify against themselves without needing access to your live signer:</p>
<pre><code>kolm receipts verify ./rcpt.json
# ok=true  signed_by=current_key  alg=ed25519  schema=kolm-audit-1

# Or with the CLI talking to prod:
kolm receipts get rcpt_01KYC1R5YQ072KSDVW6QJM --verify</code></pre>`,
      },
      {
        h2: 'Rotate the signing key',
        html: `<pre><code>kolm receipts rotate-key                          # generates new ed25519 keypair
kolm receipts rotate-key --keep-old              # keeps previous key fingerprint for old receipts
ls ~/.kolm/signing-keys/                          # signer history
</code></pre>
<p>Rotation never breaks old receipts. <code>verifySignatureBlock</code> uses the public key embedded in the receipt's signature block, not the active signer.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-captures', title: 'Captures', blurb: 'The hash-chain lake that the receipt points into.' },
      { href: '/docs/gateway-namespaces', title: 'Namespaces', blurb: 'Per-namespace receipt policy + signing key.' },
      { href: '/docs/gateway-api', title: 'HTTP API', blurb: 'Every receipt endpoint with curl snippets.' },
    ],
  },

  {
    slug: 'gateway-captures',
    title: 'Gateway captures — the hash-chain training lake',
    desc: 'Every gateway call writes a capture row to the configured lake (JSONL / SQLite / Postgres / S3) with a hash-chain prev_chain_hash so tampering is detectable. Captures feed the distill flywheel.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Every call captured. Every chain provable.',
    lede: 'The capture lake is where every <code>capture_eligible:true</code> trace lands. Each row carries a <code>prev_chain_hash</code> (HMAC over sorted-key JSON) so a tampered row breaks the chain at exactly the point it was edited. Four backends ship by default. The lake feeds the distill flywheel: approve a slice, train a local artifact, route to it via the namespace chain, mark the falls-back-to-frontier rows as fresh captures, repeat.',
    sections: [
      {
        h2: 'Four backends',
        html: `<table>
  <thead><tr><th>Backend</th><th>Env</th><th>When</th></tr></thead>
  <tbody>
    <tr><td><code>jsonl</code></td><td><code>KOLM_CAPTURE_LAKE=jsonl</code> (default)</td><td>Dev, single-node, single-process. Append-only file at <code>~/.kolm/captures/&lt;ns&gt;.jsonl</code>.</td></tr>
    <tr><td><code>sqlite</code></td><td><code>KOLM_CAPTURE_LAKE=sqlite</code></td><td>Single-node but many readers. WAL mode, hash-indexed.</td></tr>
    <tr><td><code>postgres</code></td><td><code>KOLM_CAPTURE_LAKE=postgres KOLM_CAPTURE_PG_URL=postgres://...</code></td><td>Multi-node. Schema bundled in <code>migrations/</code>.</td></tr>
    <tr><td><code>s3</code></td><td><code>KOLM_CAPTURE_LAKE=s3 KOLM_CAPTURE_S3_BUCKET=... KOLM_CAPTURE_S3_PREFIX=captures/</code></td><td>Audit / cold storage. One JSONL per hour, partitioned by namespace.</td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'Capture row shape',
        html: `<pre><code>{
  "id": "cap_01KYC1...",
  "ts": "2026-05-26T00:53:44.327Z",
  "namespace_id": "support",
  "receipt_id": "rcpt_01KYC1...",
  "input_text": "...",                  // redacted per PII mode
  "output_text": "...",                 // redacted per PII mode
  "input_hash": "sha256:...",
  "output_hash": "sha256:...",
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "input_tokens": 14, "output_tokens": 38,
  "cost_usd": 0.000204,
  "labels": [],                         // human approve / curate later
  "prev_chain_hash": "hmac-sha256:...", // chain integrity
  "chain_signing_key_id": "abc...",
  "status": "pending"                   // pending | approved | rejected | seed
}</code></pre>`,
      },
      {
        h2: 'CLI surface',
        html: `<pre><code>kolm captures list --namespace support --limit 20      # newest first
kolm captures list --status pending --json
kolm captures get cap_01KYC1...
kolm captures approve cap_01KYC1...                    # mark for training
kolm captures approve --bulk-from approved.jsonl       # bulk import
kolm captures seed sample.jsonl --namespace support    # seed without going through the gateway
kolm captures redact cap_01KYC1... --mode redact_captures   # one-off PII scrub of a row</code></pre>`,
      },
      {
        h2: 'Hash-chain integrity',
        html: `<p>Every row's <code>prev_chain_hash</code> is <code>HMAC-SHA256(sorted-key JSON of previous row, signing_key)</code>. To prove a slice is untampered:</p>
<pre><code>kolm captures verify-chain --namespace support
# walks the chain from the first row; reports the first index where prev_chain_hash mismatches</code></pre>
<p>The HMAC key (<code>KOLM_RECEIPT_SIGNING_KEY</code>) is rotated independently of the Ed25519 receipt key. Both can rotate without breaking historical verification.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-pii', title: 'PII redactor', blurb: '4 modes; redact_captures scrubs the lake body.' },
      { href: '/docs/gateway-receipts', title: 'Receipts', blurb: 'The Ed25519 envelope that points into the lake.' },
      { href: '/distill', title: 'Distill', blurb: 'Turn approved captures into a local artifact.' },
    ],
  },

  {
    slug: 'gateway-pii',
    title: 'Gateway PII — four modes over eleven entity types',
    desc: 'detect | redact | block | off, applied on input + output independently. 11 entities: email, phone, ssn, credit card, ipv4, ipv6, JWT, generic API key, AWS key, OpenAI key, postal address.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Privacy is a deployment switch, not a feature gate.',
    lede: 'The PII redactor runs on every <code>/v1/gateway/dispatch</code> call. Four modes, applied independently on input and output. Set per-namespace (<code>kolm namespace config support --pii redact</code>) or per-call (<code>?pii=block</code>). The redactor is regex-based with a tiny entropy check for keys, so it runs in microseconds and has no model dependency.',
    sections: [
      {
        h2: 'The four modes',
        html: `<table>
  <thead><tr><th>Mode</th><th>What happens</th><th>Receipt field</th></tr></thead>
  <tbody>
    <tr><td><code>off</code></td><td>Disabled. Useful for trusted internal namespaces where the input is structured.</td><td><code>redaction_applied: []</code></td></tr>
    <tr><td><code>detect</code></td><td>Logs entities found in the receipt but does not rewrite the prompt or response.</td><td><code>redaction_applied: ["email","phone"]</code></td></tr>
    <tr><td><code>redact</code></td><td>Default. Rewrites matches to <code>[REDACTED:&lt;entity&gt;]</code> before the prompt hits the provider, and before the lake row is written.</td><td><code>redaction_applied: [...]</code> + scrubbed body</td></tr>
    <tr><td><code>block</code></td><td>Refuses the request. Returns HTTP 400 with <code>{"error":{"type":"pii_block_input","blocked":true,"entities":["ssn"]}}</code> and signs a receipt for the rejection (the receipt is the proof you tried).</td><td><code>redaction_applied: [...]</code> + <code>blocked:true</code></td></tr>
  </tbody>
</table>
<p>A fifth mode, <code>redact_captures</code>, is a per-namespace flag on top of <code>redact</code> that additionally scrubs the capture body before lake-write — useful when the prompt itself contains the secret you don't want to keep.</p>`,
      },
      {
        h2: 'Eleven entity types',
        html: `<table>
  <thead><tr><th>Entity</th><th>Pattern summary</th></tr></thead>
  <tbody>
    <tr><td><code>email</code></td><td>RFC-5322-shaped local-part + domain.</td></tr>
    <tr><td><code>phone</code></td><td>E.164 + common US/EU formats.</td></tr>
    <tr><td><code>ssn</code></td><td>US SSN (with or without dashes).</td></tr>
    <tr><td><code>credit_card</code></td><td>Luhn-checked 13/15/16/19 digits.</td></tr>
    <tr><td><code>ipv4</code></td><td>0.0.0.0 — 255.255.255.255.</td></tr>
    <tr><td><code>ipv6</code></td><td>Full + compressed forms.</td></tr>
    <tr><td><code>jwt</code></td><td><code>header.payload.signature</code> with base64url + entropy check.</td></tr>
    <tr><td><code>api_key</code></td><td>Generic <code>sk_*</code>, <code>pk_*</code>, <code>ks_*</code>, etc. (≥24-char high-entropy).</td></tr>
    <tr><td><code>aws_key</code></td><td><code>AKIA</code> + 16 alnum.</td></tr>
    <tr><td><code>openai_key</code></td><td><code>sk-</code> + 32+ alnum.</td></tr>
    <tr><td><code>postal_address</code></td><td>US street + city + state + ZIP (best-effort).</td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'Per-namespace config',
        html: `<pre><code>kolm namespace config support --pii redact --redact-captures
kolm namespace config sandbox --pii off
kolm namespace config compliance --pii block</code></pre>
<p>Or in <code>gateway.toml</code>:</p>
<pre><code>[namespace.support]
pii_mode = "redact"
redact_captures = true

[namespace.compliance]
pii_mode = "block"</code></pre>`,
      },
    ],
    related: [
      { href: '/docs/gateway-namespaces', title: 'Namespaces', blurb: 'Where the per-namespace PII mode is set.' },
      { href: '/docs/gateway-captures', title: 'Captures', blurb: 'redact_captures scrubs the lake body.' },
      { href: '/docs/gateway-toml', title: 'gateway.toml', blurb: 'File-form of the PII config.' },
    ],
  },

  {
    slug: 'gateway-confidence-router',
    title: 'Gateway confidence router (W807)',
    desc: 'Local-first routing: try the local artifact, measure confidence, fall back to frontier if below threshold. Every fallback is automatically capture_eligible:true.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Local first. Frontier on doubt. Capture the doubt.',
    lede: 'The confidence router (introduced in W807) is the link between Wrapper and Studio. It runs your local <code>.kolm</code> artifact first, measures the response confidence, and falls back to a frontier provider only when the local model isn\'t sure. Every fallback is tagged <code>capture_eligible:true</code> — that\'s the row you want to add to the next distill.',
    sections: [
      {
        h2: 'How the gate decides',
        html: `<p>Confidence is computed from three signals in priority order:</p>
<ol>
  <li><strong>Logit-derived</strong> — if the local engine exposes log-probabilities (vLLM, llama.cpp via <code>n_probs</code>), confidence = softmax entropy of the top-K tokens, normalised to [0, 1].</li>
  <li><strong>Self-judge</strong> — if (1) isn't available, the local model is asked <code>"On a scale 0-1, how confident are you the previous answer is correct?"</code> with a 1-token max — fast and cheap.</li>
  <li><strong>Verbal hedging</strong> — falls back to a keyword scan over the response (<code>"I'm not sure"</code>, <code>"I cannot"</code>, <code>"as an AI"</code>) returning a heuristic score.</li>
</ol>
<p>If confidence &lt; threshold (default 0.55, configurable per namespace), the router records <code>fallback_reason: "low_confidence"</code> and re-dispatches to the next entry in the chain.</p>`,
      },
      {
        h2: 'Configure the chain',
        html: `<pre><code># Local-first with anthropic fallback
kolm namespace config support \\
  --chain "local-kolm:trinity-500,anthropic:claude-haiku-4-5" \\
  --confidence-threshold 0.60 \\
  --capture-fallbacks

# Three-tier with cost-capped frontier
kolm namespace config code \\
  --chain "local-kolm:code-7b,groq:llama-3.3-70b,openai:gpt-4o" \\
  --confidence-threshold 0.65</code></pre>`,
      },
      {
        h2: 'The capture flywheel',
        html: `<p>Every fallback is marked <code>capture_eligible:true</code> on the receipt + as a row in the capture lake. The pattern is:</p>
<ol>
  <li>Deploy your local artifact via the chain.</li>
  <li>Run real traffic. Most calls answer locally; some fall back.</li>
  <li>Periodically <code>kolm captures list --status pending --fallback-only</code> to see the fallback queue.</li>
  <li><code>kolm captures approve --bulk-from approved.jsonl</code> to mark the good ones.</li>
  <li><code>kolm distill --namespace support --since-last-distill</code> to retrain the local artifact on the approved fallbacks.</li>
  <li>Deploy the new artifact (<code>kolm namespace deploy support</code>) — local hits rise, fallback rate falls.</li>
</ol>
<p>This is the loop. After a few iterations your local artifact serves the long tail of your traffic at $0 + ~1.24s, and frontier handles the genuinely-novel queries.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-namespaces', title: 'Namespaces', blurb: 'Where the chain + threshold live.' },
      { href: '/distill', title: 'Distill', blurb: 'Train a local artifact on the approved captures.' },
      { href: '/docs/gateway-bench', title: 'Benchmark', blurb: 'Latency + cost numbers for the local-first chain.' },
    ],
  },

  {
    slug: 'gateway-namespaces',
    title: 'Gateway namespaces — per-route policy',
    desc: 'A namespace bundles routing chain + confidence threshold + PII mode + capture lake + signing key. One project can have many; each is independently auditable.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'A namespace is one policy bundle.',
    lede: 'Namespaces are how the gateway separates concerns. A namespace bundles a routing chain, a confidence threshold, a PII mode, a capture lake destination, and a signing key. <code>support</code> can route local-first with PII-redact; <code>compliance</code> can hard-block PII and never capture; <code>sandbox</code> can be off-everything for unit tests.',
    sections: [
      {
        h2: 'Lifecycle',
        html: `<pre><code>kolm namespace create support
kolm namespace config support \\
  --chain "local-kolm:trinity-500,anthropic:claude-haiku-4-5" \\
  --confidence-threshold 0.6 \\
  --pii redact \\
  --capture-lake jsonl
kolm namespace deploy support               # makes it the live routing for /v1/gateway/dispatch
kolm namespace status support               # prints config + live stats
kolm namespace undeploy support             # rolls back to the previous deploy
kolm namespace list                          # all namespaces + their deploy status</code></pre>`,
      },
      {
        h2: 'Per-namespace state on disk',
        html: `<pre><code>~/.kolm/
  namespaces/
    default.json
    support.json
    compliance.json
  captures/
    default.jsonl
    support.jsonl
    compliance.jsonl
  signing-keys/
    default.pem
    support.pem
    compliance.pem
  artifacts/
    trinity-500/
    code-7b/</code></pre>
<p>Everything is per-namespace. Backups, audits, and exports happen one namespace at a time.</p>`,
      },
      {
        h2: 'Pick the namespace per call',
        html: `<pre><code>curl -X POST https://kolm.ai/v1/gateway/dispatch \\
  -H "authorization: Bearer $KOLM_API_KEY" \\
  -H "x-kolm-namespace: support" \\
  -H "content-type: application/json" \\
  -d '{"model":"claude-haiku-4-5","messages":[...]}'

# Or path-form (sticky for an entire client session):
curl -X POST https://kolm.ai/v1/gateway/dispatch/support ...</code></pre>`,
      },
    ],
    related: [
      { href: '/docs/gateway-toml', title: 'gateway.toml', blurb: 'File-form of every namespace setting.' },
      { href: '/docs/gateway-pii', title: 'PII modes', blurb: 'Per-namespace PII config.' },
      { href: '/docs/gateway-confidence-router', title: 'Confidence router', blurb: 'How the chain falls back.' },
    ],
  },

  {
    slug: 'gateway-deploy',
    title: 'Gateway deploy — Docker, compose, k8s, BYOC',
    desc: 'Three first-class deploy targets: Docker Compose (single-host), Helm chart (k8s), and BYOC (your own cloud) bundle. Every target ships the same image with provider keys mounted from secrets.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Deploy the gateway where your data is.',
    lede: 'The gateway image is the same regardless of where it runs. The deploy targets differ in how secrets are mounted, where the lake lives, and how the receipt-signing keys are rotated. Pick the target that matches your trust boundary.',
    sections: [
      {
        h2: 'Single-host (Docker Compose)',
        html: `<p>Fastest path. <code>docker compose up</code> brings up the gateway, Postgres for the capture lake, and Caddy for TLS.</p>
<pre><code>git clone https://github.com/kolm-ai/kolm
cd kolm/deploy/compose
cp .env.example .env                 # fill ANTHROPIC_API_KEY etc.
docker compose up -d
curl http://localhost:3000/health</code></pre>
<p>See <a href="/docs/gateway-compose">gateway-compose</a> for the full compose file walkthrough.</p>`,
      },
      {
        h2: 'Kubernetes (Helm)',
        html: `<pre><code>helm repo add kolm https://kolm.ai/helm
helm install gateway kolm/gateway \\
  --set provider.anthropic.apiKey="..." \\
  --set lake.backend=postgres \\
  --set lake.postgres.url="postgres://..." \\
  --set replicas=3</code></pre>
<p>The chart provisions the deployment, service, secret, and an optional Postgres sidecar. Ed25519 signing key is auto-generated on first install; rotate with <code>helm upgrade ... --set signingKey.rotate=true</code>.</p>`,
      },
      {
        h2: 'BYOC (bring your own cloud)',
        html: `<p>For air-gapped / regulated deployments. <code>kolm bundle airgap</code> produces a tarball with the image, the Helm chart, the migrations, and a deploy checklist. See <a href="/docs/gateway-byoc">gateway-byoc</a>.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-compose', title: 'Docker Compose', blurb: 'Single-host deploy walkthrough.' },
      { href: '/docs/gateway-byoc', title: 'BYOC', blurb: 'Air-gapped / on-prem deploy.' },
      { href: '/docs/gateway-toml', title: 'gateway.toml', blurb: 'The config file every deploy reads.' },
    ],
  },

  {
    slug: 'gateway-cli',
    title: 'Gateway CLI — full verb tree',
    desc: 'kolm gateway / captures / receipts / namespace, with every sub-verb listed and a one-line example.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Every gateway operation has a CLI verb.',
    lede: 'The CLI surface mirrors the HTTP API exactly. Anything you can do with <code>curl</code>, you can do with <code>kolm gateway ...</code>. Output defaults to human-readable; add <code>--json</code> for scripts.',
    sections: [
      {
        h2: 'kolm gateway',
        html: `<table>
  <thead><tr><th>Verb</th><th>What</th><th>Example</th></tr></thead>
  <tbody>
    <tr><td><code>call</code></td><td>One-shot dispatch through the active namespace.</td><td><code>kolm gateway call --model claude-haiku-4-5 --message "hi"</code></td></tr>
    <tr><td><code>status</code></td><td>Active namespace + chain + last 5 calls.</td><td><code>kolm gateway status</code></td></tr>
    <tr><td><code>status-reachability</code></td><td>Pings every provider in the chain.</td><td><code>kolm gateway status-reachability</code></td></tr>
    <tr><td><code>simulate-overflow</code></td><td>Fires N parallel calls to test rate-limit + fallback behaviour.</td><td><code>kolm gateway simulate-overflow --n 32</code></td></tr>
    <tr><td><code>set</code></td><td>Switches the active namespace.</td><td><code>kolm gateway set support</code></td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'kolm namespace',
        html: `<table>
  <thead><tr><th>Verb</th><th>What</th></tr></thead>
  <tbody>
    <tr><td><code>create &lt;ns&gt;</code></td><td>New namespace, default config.</td></tr>
    <tr><td><code>config &lt;ns&gt;</code></td><td>Edit chain / threshold / PII / lake / signing key.</td></tr>
    <tr><td><code>deploy &lt;ns&gt;</code></td><td>Make it the live routing for <code>/v1/gateway/dispatch</code>.</td></tr>
    <tr><td><code>undeploy &lt;ns&gt;</code></td><td>Roll back to the previous deploy.</td></tr>
    <tr><td><code>status &lt;ns&gt;</code></td><td>Config + live stats.</td></tr>
    <tr><td><code>list</code></td><td>All namespaces + deploy state.</td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'kolm captures',
        html: `<table>
  <thead><tr><th>Verb</th><th>What</th></tr></thead>
  <tbody>
    <tr><td><code>list [--namespace ns] [--status pending|approved|rejected|seed] [--limit N] [--json]</code></td><td>Newest first.</td></tr>
    <tr><td><code>get &lt;cap_id&gt;</code></td><td>One row, full body.</td></tr>
    <tr><td><code>approve &lt;cap_id&gt;</code></td><td>Mark for distill.</td></tr>
    <tr><td><code>approve --bulk-from &lt;file.jsonl&gt;</code></td><td>Bulk import.</td></tr>
    <tr><td><code>reject &lt;cap_id&gt;</code></td><td>Exclude from distill.</td></tr>
    <tr><td><code>seed &lt;file.jsonl&gt;</code></td><td>Add rows without going through the gateway.</td></tr>
    <tr><td><code>redact &lt;cap_id&gt; --mode redact_captures</code></td><td>One-off PII scrub of a single row.</td></tr>
    <tr><td><code>verify-chain --namespace ns</code></td><td>Walk the hash chain; report first mismatch.</td></tr>
  </tbody>
</table>`,
      },
      {
        h2: 'kolm receipts',
        html: `<table>
  <thead><tr><th>Verb</th><th>What</th></tr></thead>
  <tbody>
    <tr><td><code>list [--namespace ns] [--limit N]</code></td><td>Newest first.</td></tr>
    <tr><td><code>get &lt;rcpt_id&gt; [--verify]</code></td><td>One receipt; optionally re-verify signature.</td></tr>
    <tr><td><code>verify &lt;file.json&gt;</code></td><td>Offline verify a saved receipt against its embedded public key.</td></tr>
    <tr><td><code>rotate-key [--keep-old]</code></td><td>Rotate the Ed25519 signer.</td></tr>
  </tbody>
</table>`,
      },
    ],
    related: [
      { href: '/docs/gateway-api', title: 'HTTP API', blurb: 'Same surface, curl-shaped.' },
      { href: '/docs/gateway-sdk', title: 'SDK', blurb: 'Same surface, JS / Python.' },
      { href: '/docs/gateway-toml', title: 'gateway.toml', blurb: 'Persistent config the verbs read from.' },
    ],
  },

  {
    slug: 'gateway-api',
    title: 'Gateway HTTP API',
    desc: 'POST /v1/gateway/dispatch, GET /v1/verify/:id, GET /v1/captures/list, and every namespace + receipts endpoint.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Every CLI verb has an HTTP route.',
    lede: 'The HTTP surface is the source of truth — the CLI is a thin wrapper over it. Auth via <code>Authorization: Bearer ks_...</code>. Namespace via header (<code>x-kolm-namespace: support</code>) or path (<code>/v1/gateway/dispatch/support</code>).',
    sections: [
      {
        h2: 'Dispatch',
        html: `<pre><code>POST /v1/gateway/dispatch
POST /v1/gateway/dispatch/&lt;namespace&gt;

Body (OpenAI-shaped):
{
  "model": "claude-haiku-4-5",
  "max_tokens": 96,
  "messages": [{"role":"user","content":"..."}],
  "provider": "anthropic"        // optional: override namespace chain
}

Response:
{
  ...openai-style body...,
  "kolm_receipt": { /* 19 fields, signed */ }
}</code></pre>`,
      },
      {
        h2: 'Receipts',
        html: `<pre><code>GET  /v1/verify/&lt;receipt_id&gt;            # online verify
GET  /v1/receipts?namespace=&amp;limit=    # list
GET  /v1/receipts/&lt;receipt_id&gt;          # one
POST /v1/receipts/rotate-key            # rotate signer</code></pre>`,
      },
      {
        h2: 'Captures',
        html: `<pre><code>GET    /v1/captures?namespace=&amp;status=&amp;limit=
GET    /v1/captures/&lt;cap_id&gt;
POST   /v1/captures/&lt;cap_id&gt;/approve
POST   /v1/captures/&lt;cap_id&gt;/reject
POST   /v1/captures/seed                  # body: JSONL
POST   /v1/captures/&lt;cap_id&gt;/redact     # body: { "mode": "redact_captures" }
GET    /v1/captures/verify-chain?namespace=</code></pre>`,
      },
      {
        h2: 'Namespaces',
        html: `<pre><code>GET    /v1/namespaces                     # list
POST   /v1/namespaces                     # create  { "name": "..." }
GET    /v1/namespaces/&lt;ns&gt;               # config + status
PATCH  /v1/namespaces/&lt;ns&gt;               # update config
POST   /v1/namespaces/&lt;ns&gt;/deploy
POST   /v1/namespaces/&lt;ns&gt;/undeploy</code></pre>`,
      },
    ],
    related: [
      { href: '/docs/gateway-cli', title: 'CLI', blurb: 'Same surface, kolm-verb shaped.' },
      { href: '/docs/gateway-sdk', title: 'SDK', blurb: 'JS / Python wrappers.' },
      { href: '/docs/api', title: 'Full API reference', blurb: 'Every route, every parameter.' },
    ],
  },

  {
    slug: 'gateway-sdk',
    title: 'Gateway SDK — JS, Python, others',
    desc: 'Thin wrappers around /v1/gateway/dispatch in @kolm-ai/sdk (Node), kolm (Python), kolm-mcp (MCP), kolm-vscode, plus C and Rust SDKs.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Talk to the gateway in your language of choice.',
    lede: 'Every SDK exposes the same shape: a constructor that takes a base URL + API key, a <code>dispatch()</code> method that takes an OpenAI-shaped body, and helpers to verify receipts. The full source for each SDK is in <code>sdk/&lt;lang&gt;/</code> in the monorepo.',
    sections: [
      {
        h2: 'Node / TypeScript',
        html: `<pre><code>npm install @kolm-ai/sdk

import { Kolm } from '@kolm-ai/sdk';
const k = new Kolm({ apiKey: process.env.KOLM_API_KEY });

const res = await k.gateway.dispatch({
  model: 'claude-haiku-4-5',
  max_tokens: 96,
  messages: [{ role: 'user', content: 'hi' }],
});
console.log(res.choices[0].message.content);
console.log(res.kolm_receipt.receipt_id);

// Verify the receipt offline
await Kolm.verifyReceipt(res.kolm_receipt); // -&gt; { ok: true, signed_by: 'current_key' }</code></pre>`,
      },
      {
        h2: 'Python',
        html: `<pre><code>pip install kolm

from kolm import Kolm
k = Kolm(api_key=os.environ['KOLM_API_KEY'])

res = k.gateway.dispatch(
  model='claude-haiku-4-5', max_tokens=96,
  messages=[{'role':'user','content':'hi'}],
)
print(res['choices'][0]['message']['content'])
print(res['kolm_receipt']['receipt_id'])</code></pre>`,
      },
      {
        h2: 'Other languages',
        html: `<table>
  <thead><tr><th>SDK</th><th>Install</th><th>Use case</th></tr></thead>
  <tbody>
    <tr><td><code>kolm-mcp</code></td><td><code>npm i -g kolm-mcp</code></td><td>MCP server exposing the gateway as a tool.</td></tr>
    <tr><td><code>kolm-vscode</code></td><td>VS Code Marketplace</td><td>Inline gateway calls + receipt view.</td></tr>
    <tr><td><code>sdk/c/</code></td><td><code>#include "kolm.h"</code></td><td>Embedded C / CLI integrators. Single-header, libcurl-backed.</td></tr>
    <tr><td><code>sdk/rust/</code></td><td><code>cargo add kolm</code></td><td>Sync Rust. <code>ureq</code>-backed, no async runtime.</td></tr>
  </tbody>
</table>`,
      },
    ],
    related: [
      { href: '/docs/gateway-api', title: 'HTTP API', blurb: 'The surface every SDK wraps.' },
      { href: '/docs/sdk/node', title: 'Node SDK', blurb: 'Full Node reference.' },
      { href: '/docs/sdk/python', title: 'Python SDK', blurb: 'Full Python reference.' },
    ],
  },

  {
    slug: 'gateway-toml',
    title: 'gateway.toml — the persistent config file',
    desc: 'The file form of every CLI flag. Stored at ./gateway.toml or ~/.kolm/gateway.toml; the gateway reads it at startup and per-namespace.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'One file. Every gateway setting.',
    lede: '<code>gateway.toml</code> is the persistent form of every <code>kolm gateway</code> + <code>kolm namespace</code> flag. The gateway reads it from <code>./gateway.toml</code> (project-local) and merges in <code>~/.kolm/gateway.toml</code> (user-global). CLI flags override both.',
    sections: [
      {
        h2: 'Full example',
        html: `<pre><code>[gateway]
default_namespace = "support"
public_url        = "https://kolm.ai"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"     # also walks anthropic_api_key / ANTHROPIC_KEY / anthropic_key

[providers.openai]
api_key_env = "OPENAI_API_KEY"

[providers.local-vllm]
url = "http://localhost:8000"

[providers.local-ollama]
url = "http://localhost:11434"

[receipts]
signing_key_path  = "~/.kolm/signing-keys/default.pem"
chain_signing_key_env = "KOLM_RECEIPT_SIGNING_KEY"
schema            = "kolm-audit-1"

[capture_lake]
backend           = "jsonl"           # jsonl | sqlite | postgres | s3
jsonl_dir         = "~/.kolm/captures"
postgres_url_env  = "KOLM_CAPTURE_PG_URL"
s3_bucket_env     = "KOLM_CAPTURE_S3_BUCKET"
s3_prefix         = "captures/"

[namespace.default]
chain                 = ["anthropic:claude-haiku-4-5"]
confidence_threshold  = 0.55
pii_mode              = "redact"
redact_captures       = false
capture_lake          = "jsonl"

[namespace.support]
chain                 = ["local-kolm:trinity-500", "anthropic:claude-haiku-4-5"]
confidence_threshold  = 0.60
pii_mode              = "redact"
redact_captures       = true
capture_lake          = "postgres"

[namespace.compliance]
chain                 = ["anthropic:claude-opus-4-7"]
confidence_threshold  = 0.0           # never fall back
pii_mode              = "block"
capture_lake          = "s3"</code></pre>`,
      },
      {
        h2: 'Generate from current state',
        html: `<pre><code>kolm gateway dump-config > gateway.toml
# writes the current in-memory config to disk so you can commit it</code></pre>`,
      },
    ],
    related: [
      { href: '/docs/gateway-namespaces', title: 'Namespaces', blurb: 'Each [namespace.X] table.' },
      { href: '/docs/gateway-cli', title: 'CLI', blurb: 'Flags that override the file.' },
      { href: '/docs/gateway-compose', title: 'Docker Compose', blurb: 'How the file is mounted into the container.' },
    ],
  },

  {
    slug: 'gateway-compose',
    title: 'Gateway with Docker Compose',
    desc: 'Single-host deploy. docker compose up brings up the gateway, Postgres for the lake, and Caddy for TLS.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Single command. Production-shaped.',
    lede: 'The <code>deploy/compose</code> folder ships a three-service stack: the gateway, Postgres for the capture lake, and Caddy for TLS. Provider keys come from <code>.env</code>; the Ed25519 signing key is auto-generated on first start and persisted to a Docker volume.',
    sections: [
      {
        h2: 'docker-compose.yml',
        html: `<pre><code>services:
  gateway:
    image: ghcr.io/kolm-ai/kolm-gateway:latest
    environment:
      KOLM_BASE_URL: "http://gateway:3000"
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY}
      OPENAI_API_KEY:    \${OPENAI_API_KEY}
      KOLM_CAPTURE_LAKE: postgres
      KOLM_CAPTURE_PG_URL: "postgres://kolm:kolm@postgres:5432/kolm"
    volumes:
      - kolm-signing-keys:/root/.kolm/signing-keys
      - ./gateway.toml:/etc/kolm/gateway.toml:ro
    depends_on: [postgres]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: kolm
      POSTGRES_PASSWORD: kolm
      POSTGRES_DB: kolm
    volumes:
      - kolm-pg:/var/lib/postgresql/data

  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - kolm-caddy:/data
    depends_on: [gateway]

volumes:
  kolm-signing-keys:
  kolm-pg:
  kolm-caddy:</code></pre>`,
      },
      {
        h2: 'Caddyfile',
        html: `<pre><code>{
  email you@example.com
}

gateway.example.com {
  reverse_proxy gateway:3000
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
  }
}</code></pre>`,
      },
      {
        h2: 'Bring it up',
        html: `<pre><code>cp .env.example .env
$EDITOR .env                    # fill ANTHROPIC_API_KEY etc.
docker compose up -d
curl https://gateway.example.com/health</code></pre>
<p>Logs: <code>docker compose logs -f gateway</code>. Rotate the Ed25519 key: <code>docker compose exec gateway kolm receipts rotate-key</code>.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-deploy', title: 'Deploy', blurb: 'All three deploy targets compared.' },
      { href: '/docs/gateway-toml', title: 'gateway.toml', blurb: 'The mounted config file.' },
      { href: '/docs/gateway-byoc', title: 'BYOC', blurb: 'Air-gapped variant.' },
    ],
  },

  {
    slug: 'gateway-byoc',
    title: 'Gateway BYOC — bring your own cloud',
    desc: 'Air-gapped / on-prem deploy. kolm bundle airgap produces a tarball with the image, Helm chart, migrations, and a deploy checklist.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Deploy where your data lives. No bytes to kolm.',
    lede: 'BYOC is for deployments that cannot send data out — regulated industries, classified networks, sovereign-cloud requirements. <code>kolm bundle airgap</code> produces a self-contained tarball; <code>kolm passport export --format compliance</code> produces a compliance manifest that lists every dependency + every receipt-signing decision.',
    sections: [
      {
        h2: 'Produce the bundle',
        html: `<pre><code>kolm bundle airgap --output kolm-gateway-airgap-2026-05-26.tar.gz \\
  --include image,helm,migrations,docs,checklist

# Inspect:
tar -tzf kolm-gateway-airgap-2026-05-26.tar.gz | head
# kolm-gateway-airgap/
#   image/kolm-gateway-latest.tar
#   helm/kolm-gateway-chart-0.1.0.tgz
#   migrations/001_initial.sql
#   docs/compliance.pdf
#   CHECKLIST.md</code></pre>`,
      },
      {
        h2: 'Compliance passport',
        html: `<pre><code>kolm passport export --format compliance > compliance.json

# Lists:
#   - every dep + license + version
#   - every receipt-signing decision (key rotation history)
#   - every namespace + its routing chain
#   - every PII mode in use
#   - every capture lake destination
#   - SBOM (CycloneDX)</code></pre>
<p>Hand to your model-risk-review team. Bundled with the airgap tarball by default.</p>`,
      },
      {
        h2: 'Procurement questionnaires',
        html: `<p>For SIG / CAIQ / SOC 2: <code>kolm procurement export --format sig|caiq|all</code> generates pre-filled answers from the live deployment config. See <a href="/docs/procurement">procurement</a>.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-deploy', title: 'Deploy', blurb: 'All deploy targets compared.' },
      { href: '/docs/self-hosted-deploy-complete', title: 'Self-hosted', blurb: 'Every env var, every secret.' },
      { href: '/docs/passport', title: 'Passport', blurb: 'Compliance manifest spec.' },
    ],
  },

  {
    slug: 'gateway-faq',
    title: 'Gateway FAQ',
    desc: 'Common questions about routing, billing, latency, signing keys, capture lake backends, and PII modes.',
    eyebrow: 'Wrapper / Gateway',
    h1: 'Frequently asked.',
    lede: 'Quick answers to the questions we get most often. Cross-linked to the doc that goes deeper.',
    sections: [
      {
        h2: 'How much overhead does the gateway add?',
        html: `<p>~3–8 ms on top of the upstream call (W-J.b <code>--report-latency</code> measurement, p50). Most of the time is in PII regex + receipt signing; the lake write is async. The W887 benchmark on <code>kolm.ai</code> measures this against direct provider calls — see <a href="/docs/gateway-bench">gateway-bench</a> for the live numbers.</p>`,
      },
      {
        h2: 'Does the gateway charge per call?',
        html: `<p>The gateway itself is free. You're billed only for what the upstream provider charges (passed through, with a 0% markup at the Free tier; small markup on Pro/Business for hosted inference convenience). Local-routed calls (<code>local-kolm</code>, <code>local-vllm</code>, <code>local-ollama</code>) cost $0 in provider fees regardless of plan.</p>`,
      },
      {
        h2: 'What happens if the upstream provider returns an error?',
        html: `<p>The gateway still signs a receipt (the receipt is the proof you tried). The capture row records the error. If a namespace fallback chain is configured, the router tries the next provider; the receipt records <code>fallback_reason: "upstream_error"</code>.</p>`,
      },
      {
        h2: 'Can I verify a receipt without talking to kolm.ai?',
        html: `<p>Yes. Every signature block embeds the public key that signed it. <code>kolm receipts verify ./rcpt.json</code> works offline.</p>`,
      },
      {
        h2: 'Where are the signing keys stored?',
        html: `<p>Self-hosted: <code>~/.kolm/signing-keys/&lt;namespace&gt;.pem</code> by default, or wherever <code>signing_key_path</code> in <code>gateway.toml</code> points. Compose: a named Docker volume. Helm: a Kubernetes secret. Rotate without breaking old receipts via <code>kolm receipts rotate-key</code>.</p>`,
      },
      {
        h2: 'Which capture lake backend should I use?',
        html: `<p>Dev: <code>jsonl</code>. Single-node prod: <code>sqlite</code>. Multi-node prod: <code>postgres</code>. Audit / cold storage: <code>s3</code>. You can also run two in parallel — e.g. <code>postgres</code> for live + <code>s3</code> for archive — via the <code>KOLM_CAPTURE_LAKE_SECONDARY</code> env.</p>`,
      },
      {
        h2: 'Can I send a request that bypasses the gateway pipeline entirely?',
        html: `<p>Yes — <code>POST /v1/teacher/chat</code> is the no-wrapper proxy. Useful for benchmarking the wrapper overhead. It does NOT sign a receipt or write to the capture lake.</p>`,
      },
    ],
    related: [
      { href: '/docs/gateway-bench', title: 'Benchmark', blurb: 'Live latency + cost numbers.' },
      { href: '/docs/gateway-pii', title: 'PII modes', blurb: 'How input + output get scrubbed.' },
      { href: '/docs/gateway-receipts', title: 'Receipts', blurb: 'Verify online or offline.' },
    ],
  },

  {
    slug: 'gateway-bench',
    title: 'Gateway benchmark — overhead + savings axis',
    desc: 'Live benchmark against kolm.ai measuring three legs: direct (teacher proxy → anthropic), full gateway (PII + chain + receipt + capture), and local-trinity-500 (projected from W869).',
    eyebrow: 'Wrapper / Gateway',
    h1: 'How much does the gateway cost you?',
    lede: 'The W887 benchmark runs three legs through <code>kolm.ai</code> with N identical prompts each, then writes <code>benchmarks/wave887-wrapper-prod-&lt;date&gt;.{json,md}</code> with latency p50/p95/mean and cost-per-1k. Leg C projects the local-trinity-500 numbers from the W869 bench (n=57, mean 1.24s/210 chars, $0 upstream) to show the savings axis without needing a running local <code>kolm serve</code>.</p>',
    sections: [
      {
        h2: 'Run it yourself',
        html: `<pre><code># Defaults: BASE=https://kolm.ai, MODEL=claude-haiku-4-5, N=8
node scripts/wave887-wrapper-prod-benchmark.cjs

# Custom:
BENCH_N=16 KOLM_BASE_URL=https://kolm.ai KOLM_API_KEY=ks_... \\
  node scripts/wave887-wrapper-prod-benchmark.cjs</code></pre>`,
      },
      {
        h2: 'Outputs',
        html: `<ul>
  <li><code>benchmarks/wave887-wrapper-prod-&lt;date&gt;.json</code> — raw timings + receipt IDs + cost calc</li>
  <li><code>benchmarks/wave887-wrapper-prod-&lt;date&gt;.md</code> — human-readable summary</li>
</ul>`,
      },
      {
        h2: 'What the legs measure',
        html: `<table>
  <thead><tr><th>Leg</th><th>Route</th><th>Pipeline</th><th>Upstream</th></tr></thead>
  <tbody>
    <tr><td>A. Direct</td><td><code>/v1/teacher/chat</code></td><td>None (thin proxy)</td><td>Anthropic</td></tr>
    <tr><td>B. Gateway</td><td><code>/v1/gateway/dispatch</code></td><td>PII scan + chain resolve + receipt sign + lake write</td><td>Anthropic</td></tr>
    <tr><td>C. Local (projected)</td><td>From W869 bench</td><td>Same pipeline</td><td><code>local-kolm:trinity-500</code> ($0 upstream)</td></tr>
  </tbody>
</table>
<p><strong>Gateway overhead</strong> = mean(leg B) − mean(leg A). <strong>Local-vs-frontier savings</strong> = $/1k(leg A) − $/1k(leg C). The latest numbers ship in the markdown file linked from this page.</p>`,
      },
      {
        h2: 'Latest published run',
        html: `<p>See <code>benchmarks/wave887-wrapper-prod-2026-05-26.md</code> in the repo for the most recent run. Pinned numbers also appear on <a href="/gateway">the gateway product page</a>.</p>`,
      },
    ],
    related: [
      { href: '/gateway', title: 'Gateway product page', blurb: 'Headline numbers in context.' },
      { href: '/docs/gateway-confidence-router', title: 'Confidence router', blurb: 'Why local-first beats frontier on cost.' },
      { href: '/docs/gateway', title: 'Gateway overview', blurb: 'What the pipeline does.' },
    ],
  },
];

// /gateway product page (not a docs page; uses ks-* layout)
function productPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}}catch(e){}})();</script> // deliberate: cleanup
<title>Gateway &middot; wrap any LLM provider with receipts, captures, and local-first routing &middot; kolm.ai</title>
<meta name="description" content="The kolm gateway sits in front of 11 LLM providers, signs an Ed25519 receipt on every call, captures the trace for replay, and routes locally-first via a confidence gate. ~3–8 ms overhead.">
<meta name="theme-color" content="#0e1116" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f3f5f7" media="(prefers-color-scheme: light)">
<meta property="og:title" content="Gateway &middot; kolm.ai">
<meta property="og:description" content="One wrapper. Eleven providers. Every call signed.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://kolm.ai/gateway">
<meta property="og:image" content="https://kolm.ai/brand-hero.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://kolm.ai/gateway">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/design-tokens.css">
<link rel="stylesheet" href="/ks.css">
<link rel="stylesheet" href="/warm-paper.css">
<style>
:root{--ink:#e6e9ee;--ink-mute:#aab0b8;--ink-faint:#6a727c;--line:rgba(230,233,238,0.08);--bg:#0b0d10;--bg-elev:#101316;--accent:#111111;--accent-soft:rgba(17,17,17,0.10);--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
[data-theme=light]{--ink:#1f2429;--ink-mute:#4b5158;--ink-faint:#6a727c;--line:rgba(0,0,0,0.08);--bg:#f3f5f7;--bg-elev:#ffffff;--accent:#059669;--accent-soft:rgba(5,150,105,0.10)}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,Inter,system-ui,sans-serif;margin:0}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.hero{padding:88px 0 56px}
.hero .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:var(--accent);margin:0 0 18px}
.hero h1{font-size:clamp(40px,5vw,64px);line-height:1.04;font-weight:500;letter-spacing:-0.024em;margin:0 0 22px;max-width:980px}
.hero .lede{font-size:20px;line-height:1.5;color:var(--ink-mute);max-width:780px;margin:0 0 32px}
.hero .cta{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0 0}
.btn-primary{background:var(--accent);color:#fff;border-radius:8px;padding:12px 22px;text-decoration:none;font-weight:500;font-size:14px}
.btn-ghost{border:1px solid var(--line);border-radius:8px;padding:12px 22px;text-decoration:none;color:inherit;font-size:14px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:48px 0 80px;padding:24px 0 0;border-top:1px solid var(--line)}
@media(max-width:820px){.metrics{grid-template-columns:repeat(2,1fr)}}
.metric{padding:20px 22px;background:var(--bg-elev);border:1px solid var(--line);border-radius:12px}
.metric .num{font-size:32px;font-weight:500;letter-spacing:-0.02em;line-height:1.05;color:var(--ink);margin:0 0 8px;font-variant-numeric:tabular-nums}
.metric .lab{font-family:var(--mono);font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-faint)}
section{padding:64px 0;border-top:1px solid var(--line)}
section h2{font-size:32px;font-weight:500;letter-spacing:-0.022em;margin:0 0 18px;max-width:780px}
section p{color:var(--ink-mute);font-size:16px;line-height:1.65;max-width:780px;margin:0 0 12px}
.feature-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:22px;margin:36px 0}
@media(max-width:820px){.feature-grid{grid-template-columns:1fr}}
.feature{padding:24px 26px;background:var(--bg-elev);border:1px solid var(--line);border-radius:12px}
.feature h3{font-size:17px;font-weight:500;letter-spacing:-0.01em;margin:0 0 8px;color:var(--ink)}
.feature p{font-size:14px;color:var(--ink-mute);line-height:1.6;margin:0;max-width:none}
.feature code{font-family:var(--mono);font-size:12px;color:var(--accent);background:var(--accent-soft);padding:1px 6px;border-radius:4px}
pre{background:#06080a;color:#e9eef3;border:1px solid var(--line);border-radius:10px;padding:18px 22px;overflow-x:auto;font:12.5px/1.55 var(--mono);margin:16px 0;max-width:820px}
.flow{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:30px 0}
@media(max-width:820px){.flow{grid-template-columns:repeat(2,1fr)}}
.flow-step{padding:14px 16px;background:var(--bg-elev);border:1px solid var(--line);border-radius:10px;font-size:12.5px}
.flow-step b{display:block;font-size:11px;font-family:var(--mono);letter-spacing:0.14em;text-transform:uppercase;color:var(--accent);margin:0 0 6px}
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
      <a href="/signup" class="ks-btn ks-btn--primary ks-btn--sm">Get started <span class="ks-btn-arrow">&rarr;</span></a>
    </div>
  </nav>
</div>

<main id="main" tabindex="-1"><div class="wrap">

<header class="hero">
  <p class="eyebrow">Wrapper / Gateway</p>
  <h1>One wrapper. Eleven providers.<br>Every call signed.</h1>
  <p class="lede">The kolm gateway is the receipt-signed, capture-on, locally-first proxy in front of every LLM you call. Open-source, ~3–8 ms overhead, ships as a single binary or Docker compose.</p>
  <div class="cta">
    <a class="btn-primary" href="/signup">Get a key &rarr;</a>
    <a class="btn-ghost" href="/docs/gateway">Read the docs</a>
    <a class="btn-ghost" href="https://github.com/kolm-ai/kolm" rel="noopener">GitHub</a>
  </div>
</header>

<div class="metrics">
  <div class="metric"><p class="num">11</p><p class="lab">Providers</p></div>
  <div class="metric"><p class="num">19</p><p class="lab">Receipt fields</p></div>
  <div class="metric"><p class="num">4</p><p class="lab">PII modes</p></div>
  <div class="metric"><p class="num">~3–8 ms</p><p class="lab">Overhead</p></div>
</div>

<section>
  <h2>What the gateway does on every call</h2>
  <p>Each <code>/v1/gateway/dispatch</code> goes through six stages. The first response byte ships ~3–8 ms after the upstream call returns — that overhead buys you receipts, captures, PII scrubbing, and namespace routing every time.</p>
  <div class="flow">
    <div class="flow-step"><b>1 / PII in</b>4 modes; 11 entity types</div>
    <div class="flow-step"><b>2 / Resolve</b>Namespace routing chain</div>
    <div class="flow-step"><b>3 / Dispatch</b>Local-first; confidence gate</div>
    <div class="flow-step"><b>4 / PII out</b>Scrub response + lake</div>
    <div class="flow-step"><b>5 / Sign</b>Ed25519; chain HMAC</div>
    <div class="flow-step"><b>6 / Capture</b>Hash-chained lake row</div>
  </div>
</section>

<section>
  <h2>The four pillars</h2>
  <div class="feature-grid">
    <div class="feature">
      <h3>Eleven providers, one shape</h3>
      <p>OpenAI · Anthropic · Google · DeepSeek · Groq · Together · Fireworks · OpenRouter · local-vLLM · local-Ollama · local-kolm. Same OpenAI-shaped request; the gateway resolves the adapter from the namespace chain or the model name. <a href="/docs/gateway-providers">Providers &rarr;</a></p>
    </div>
    <div class="feature">
      <h3>Every call signed</h3>
      <p>19-field <code>kolm-audit-1</code> receipt; Ed25519 signature with the public key embedded for offline verify; rotatable signer that never breaks historical receipts. <a href="/docs/gateway-receipts">Receipts &rarr;</a></p>
    </div>
    <div class="feature">
      <h3>Captures feed the flywheel</h3>
      <p>Hash-chained capture lake (JSONL, SQLite, Postgres, S3); fallbacks marked <code>capture_eligible</code>; approve a slice and re-distill a local artifact. <a href="/docs/gateway-captures">Captures &rarr;</a></p>
    </div>
    <div class="feature">
      <h3>Privacy as a switch</h3>
      <p>4 PII modes (off, detect, redact, block) over 11 entity types; per-namespace; runs in microseconds; receipt records every match. <a href="/docs/gateway-pii">PII &rarr;</a></p>
    </div>
  </div>
</section>

<section>
  <h2>Minimal example</h2>
  <pre><code>curl -X POST https://kolm.ai/v1/gateway/dispatch \\
  -H "authorization: Bearer $KOLM_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 96,
    "messages": [{"role":"user","content":"hi"}]
  }'

# Response: { ...openai-style body..., "kolm_receipt": { /* 19 fields, signed */ } }

# Verify the receipt:
curl https://kolm.ai/v1/verify/&lt;receipt_id&gt;</code></pre>
</section>

<section>
  <h2>Deploy where your data is</h2>
  <div class="feature-grid">
    <div class="feature"><h3>Docker Compose</h3><p>Single host. <code>docker compose up</code>. Postgres + Caddy bundled. <a href="/docs/gateway-compose">Compose &rarr;</a></p></div>
    <div class="feature"><h3>Helm / k8s</h3><p>Auto-generated signing keys; mounted secrets; HPA-ready. <a href="/docs/gateway-deploy">Deploy &rarr;</a></p></div>
    <div class="feature"><h3>BYOC / air-gap</h3><p>Self-contained tarball; compliance passport. <a href="/docs/gateway-byoc">BYOC &rarr;</a></p></div>
    <div class="feature"><h3>kolm.ai cloud</h3><p>Sign up, get a key, dispatch. Free tier 50k calls / mo. <a href="/signup">Get started &rarr;</a></p></div>
  </div>
</section>

</div></main>

<footer class="ks-footer">
  <div class="ks-wrap">
    <div class="ks-footer__grid">
      <div>
        <a href="/" class="ks-nav__brand"><span class="ks-nav__mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" role="img" aria-label="kolm"><rect x="4" y="6" width="4.5" height="20" rx="0.4"/><rect x="13" y="9" width="4.5" height="14" rx="0.4"/><rect x="22" y="12" width="4.5" height="8" rx="0.4"/></svg></span><span>kolm<b>.ai</b></span></a>
        <p class="ks-footer__tagline">Compile any AI model. Run it anywhere.</p>
      </div>
      <div>
        <h4>Wrapper</h4>
        <ul><li><a href="/wrapper">Overview</a></li><li><a href="/gateway">Gateway</a></li><li><a href="/capture">Capture</a></li><li><a href="/security">Security &amp; receipts</a></li><li><a href="/docs/gateway">Gateway docs</a></li></ul>
      </div>
      <div>
        <h4>Studio</h4>
        <ul><li><a href="/studio">Overview</a></li><li><a href="/distill">Distill</a></li><li><a href="/compile">Compile</a></li><li><a href="/k-score">k-score</a></li><li><a href="/models">Models</a></li></ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul><li><a href="/pricing">Pricing</a></li><li><a href="/docs">Docs</a></li><li><a href="/manifesto">Manifesto</a></li><li><a href="/changelog">Changelog</a></li><li><a href="https://github.com/kolm-ai/kolm" rel="noopener">GitHub</a></li></ul>
      </div>
    </div>
    <div class="ks-footer__bottom">
      <span>&copy; 2026 kolm.ai &middot; Apache-2.0 &middot; <a href="/legal">Legal</a> &middot; <a href="/security">Security</a></span>
    </div>
  </div>
</footer>

</body>
</html>
`;
}

// --- write files ---
let written = 0;
for (const d of docs) {
  const html = page(d);
  const out = path.join(PUBLIC_DIR, 'docs', `${d.slug}.html`);
  fs.writeFileSync(out, html);
  written++;
  process.stdout.write(`wrote ${out} (${html.length} bytes)\n`);
}
const prodOut = path.join(PUBLIC_DIR, 'gateway.html');
fs.writeFileSync(prodOut, productPage());
written++;
process.stdout.write(`wrote ${prodOut}\n`);
process.stdout.write(`\nTotal: ${written} pages written.\n`);
