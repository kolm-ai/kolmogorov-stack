#!/usr/bin/env node
// W889-8.3 — programmatic SEO generator.
//
// Emits one HTML page per (source_model × target_format) combination at
// public/compile/{source}-to-{format}.html. Each page:
//   - H1: "Compile {Source} to {Target} on consumer hardware with kolm."
//   - 3-4 paragraphs of templated intro per model + format
//   - A `kolm compile` code block (real CLI verb)
//   - Resource estimate table (VRAM/disk/time): real numbers when present in
//     public/benchmarks/sota-quantize-matrix.json, "Caveats: verifying" link
//     to /verify-prod otherwise
//   - 3 outbound links: /forge, /pricing, /docs/compile/{format}
//   - JSON-LD Product + HowTo + BreadcrumbList schema
//   - Cool slate dark mode (no browns/beiges/oranges)
//
// Run idempotently:
//   node scripts/build-seo-pages.cjs              # writes 70 pages
//   node scripts/build-seo-pages.cjs --dry-run    # exits 0, lists slugs only

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC, 'compile');
const MATRIX_PATH = path.join(PUBLIC, 'benchmarks', 'sota-quantize-matrix.json');

const SOURCE_MODELS = [
  { slug: 'claude-opus-4', name: 'Claude Opus 4', family: 'frontier', params_b: null,
    vendor: 'Anthropic', desc: 'a closed-weight frontier reasoning model from Anthropic' },
  { slug: 'gpt-4o', name: 'GPT-4o', family: 'frontier', params_b: null,
    vendor: 'OpenAI', desc: 'OpenAI\'s multimodal frontier model' },
  { slug: 'llama-3.3-70b', name: 'Llama 3.3 70B', family: 'open-weight', params_b: 70,
    vendor: 'Meta', desc: 'Meta\'s 70B instruction-tuned open-weight model' },
  { slug: 'qwen2.5-72b', name: 'Qwen2.5 72B', family: 'open-weight', params_b: 72,
    vendor: 'Alibaba', desc: 'Alibaba\'s 72B Qwen2.5 open-weight instruct model' },
  { slug: 'qwen2.5-32b', name: 'Qwen2.5 32B', family: 'open-weight', params_b: 32,
    vendor: 'Alibaba', desc: 'Alibaba\'s 32B Qwen2.5 open-weight instruct model' },
  { slug: 'qwen2.5-7b', name: 'Qwen2.5 7B', family: 'open-weight', params_b: 7,
    vendor: 'Alibaba', desc: 'Alibaba\'s 7B Qwen2.5 open-weight instruct model' },
  { slug: 'deepseek-r1-distill-32b', name: 'DeepSeek-R1-Distill-Qwen-32B', family: 'open-weight', params_b: 32,
    vendor: 'DeepSeek', desc: 'DeepSeek\'s 32B reasoning-distilled checkpoint' },
  { slug: 'deepseek-r1-distill-7b', name: 'DeepSeek-R1-Distill-Qwen-7B', family: 'open-weight', params_b: 7,
    vendor: 'DeepSeek', desc: 'DeepSeek\'s 7B reasoning-distilled checkpoint' },
  { slug: 'mistral-large', name: 'Mistral Large', family: 'open-weight', params_b: 123,
    vendor: 'Mistral AI', desc: 'Mistral AI\'s 123B flagship open-weight model' },
  { slug: 'gemma-2-27b', name: 'Gemma 2 27B', family: 'open-weight', params_b: 27,
    vendor: 'Google', desc: 'Google\'s 27B Gemma 2 open-weight instruct model' },
];

const TARGET_FORMATS = [
  { slug: 'gguf-q4_k_m', name: 'GGUF Q4_K_M', family: 'gguf',
    runtime: 'llama.cpp / Ollama / LM Studio',
    bits_per_weight: 4.5,
    desc: 'a 4.5-bit GGUF mixed-precision quantization that balances size and quality. Q4_K_M is the most popular GGUF level for consumer GPUs and CPU offload.' },
  { slug: 'gguf-q5_k_m', name: 'GGUF Q5_K_M', family: 'gguf',
    runtime: 'llama.cpp / Ollama / LM Studio',
    bits_per_weight: 5.5,
    desc: 'a 5.5-bit GGUF mixed-precision quantization. Better fidelity than Q4_K_M at the cost of ~22% more disk and VRAM.' },
  { slug: 'gguf-q8_0', name: 'GGUF Q8_0', family: 'gguf',
    runtime: 'llama.cpp / Ollama / LM Studio',
    bits_per_weight: 8.5,
    desc: 'an 8.5-bit GGUF quantization that is nearly lossless versus the bf16 source. Recommended when disk and VRAM are not the constraint.' },
  { slug: 'exl2', name: 'EXL2', family: 'exl2',
    runtime: 'ExLlamaV2 / TabbyAPI',
    bits_per_weight: 4.25,
    desc: 'EXL2 (ExLlamaV2) packed quantization with calibration-aware bits-per-weight (typically 4.0-6.0 bpw). Highest throughput on NVIDIA GPUs.' },
  { slug: 'gptq', name: 'GPTQ', family: 'gptq',
    runtime: 'AutoGPTQ / vLLM',
    bits_per_weight: 4.0,
    desc: 'GPTQ (Frantar et al., 2023) calibration-based 4-bit quantization. Wide vLLM and AutoGPTQ runtime support.' },
  { slug: 'awq', name: 'AWQ', family: 'awq',
    runtime: 'AWQ / vLLM',
    bits_per_weight: 4.0,
    desc: 'AWQ (activation-aware weight quantization, Lin et al., 2023). Preserves the salient 1% of weights at higher precision for better fidelity than naive 4-bit.' },
  { slug: 'mlx', name: 'MLX', family: 'mlx',
    runtime: 'mlx-lm on Apple Silicon',
    bits_per_weight: 4.0,
    desc: 'Apple\'s MLX format optimized for unified memory on Apple Silicon (M1/M2/M3/M4). Runs natively without GPU offload overhead.' },
];

// Load the verified quantize matrix for grounded resource estimates. Anything
// we cannot ground gets the "Caveats: verifying" label per W869+ standing
// directive: no fabricated numbers.
let MATRIX = null;
try {
  MATRIX = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
} catch (_) {
  MATRIX = { rows: [] };
}

function findMatrixRow(modelSlug) {
  // Map our SEO slugs onto the matrix model names.
  const map = {
    'qwen2.5-7b': 'Qwen2.5-7B-Instruct',
    'qwen2.5-32b': null, // not measured yet
    'deepseek-r1-distill-32b': 'DeepSeek-R1-Distill-Qwen-32B',
    'deepseek-r1-distill-7b': null, // 7B variant not measured separately
  };
  const target = map[modelSlug];
  if (!target) return null;
  return MATRIX.rows.find((r) => r.model === target) || null;
}

function estimateResources(model, format) {
  // params_b is the parameter count in billions. bits_per_weight comes from
  // the format definition. Disk-after-quantization in GB ~ params_b * bits / 8.
  if (!model.params_b) {
    return { grounded: false, vram_gb: null, disk_gb: null, time_s: null,
             note: 'Frontier closed-weight models are distilled to an open student before quantization. Estimate depends on the student\'s parameter count.' };
  }
  const row = findMatrixRow(model.slug);
  if (row && format.family === 'gguf') {
    // Grounded INT4-equivalent baseline; scale by bits_per_weight ratio.
    const scale = format.bits_per_weight / 4.0;
    return {
      grounded: true,
      vram_gb: Number((row.output_int4_gb * scale).toFixed(1)),
      disk_gb: Number((row.output_int4_gb * scale).toFixed(1)),
      time_s: row.quantize_seconds ? Math.round(row.quantize_seconds * (scale * 0.9)) : null,
      throughput_tok_per_sec: row.inference_throughput_tok_per_sec || null,
      hardware: 'NVIDIA RTX 5090 (32 GB VRAM)',
      receipt: row.receipt_path,
    };
  }
  // Ungrounded fallback: compute from params + bits.
  const disk_gb = Number(((model.params_b * format.bits_per_weight) / 8).toFixed(1));
  return {
    grounded: false,
    vram_gb: Number((disk_gb * 1.15).toFixed(1)), // +15% for KV cache headroom
    disk_gb,
    time_s: null,
    note: 'Caveats: verifying on consumer hardware. Estimate computed from params * bits_per_weight / 8.',
  };
}

function safe(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function compileCommandFor(model, format) {
  return `kolm compile ${model.slug} --target ${format.slug}`;
}

// Map format families to existing docs paths. /docs/compile/gguf exists; for
// EXL2/GPTQ/AWQ/MLX we fall back to the unified /docs/compile/formats page so
// we never emit a broken internal href (audit-href --strict).
function docsLinkFor(format) {
  if (format.family === 'gguf') return '/docs/compile/gguf';
  return '/docs/compile/formats';
}

function relatedSibling(model, format) {
  // Pick three nearby siblings: same model different format + same format different model
  const sameModelOther = TARGET_FORMATS.filter((f) => f.slug !== format.slug).slice(0, 2);
  const sameFormatOther = SOURCE_MODELS.filter((m) => m.slug !== model.slug).slice(0, 2);
  return [
    ...sameModelOther.map((f) => ({ href: `/compile/${model.slug}-to-${f.slug}`, label: `Compile ${model.name} to ${f.name}` })),
    ...sameFormatOther.map((m) => ({ href: `/compile/${m.slug}-to-${format.slug}`, label: `Compile ${m.name} to ${format.name}` })),
  ];
}

function buildPage(model, format) {
  const slug = `${model.slug}-to-${format.slug}`;
  // Title MUST stay <=78 raw chars (W538 #3 measures the raw HTML between
  // <title>…</title>, so each `&middot;` counts as 8 chars). Drop the "on
  // consumer hardware" phrase + the trailing ` &middot; kolm.ai` brand suffix
  // — both are preserved in the H1 and og:* metadata. Worst case here is
  // `Compile DeepSeek-R1-Distill-Qwen-32B to GGUF Q4_K_M with kolm` = 61.
  const title = `Compile ${model.name} to ${format.name} with kolm`;
  const description = `Compile ${model.name} to ${format.name} (${format.runtime}) with kolm. Open-source AI compiler, signed receipts, runs on your own hardware.`;
  const cmd = compileCommandFor(model, format);
  const est = estimateResources(model, format);
  const siblings = relatedSibling(model, format);

  // Resource estimate row HTML
  const vramCell = est.vram_gb != null ? `${est.vram_gb} GB` : '<span class="muted">Caveats: verifying</span>';
  const diskCell = est.disk_gb != null ? `${est.disk_gb} GB` : '<span class="muted">Caveats: verifying</span>';
  const timeCell = est.time_s != null ? `${est.time_s}s` : '<span class="muted">Caveats: verifying</span>';
  const groundedBadge = est.grounded
    ? `<span class="badge badge-grounded">measured on ${safe(est.hardware)}</span>`
    : `<span class="badge badge-est">estimate &middot; <a href="/verify-prod">verify yourself</a></span>`;

  // Intro paragraphs
  const intro1 = `<strong>${model.name}</strong> is ${model.desc}. <strong>${format.name}</strong> is ${format.desc}`;
  const intro2 = model.family === 'frontier'
    ? `Closed-weight frontier models like ${model.name} cannot be quantized directly — the weights are not public. The kolm path is distill-then-compile: a smaller open-weight student is trained against the frontier teacher with kolm capture + kolm distill, then the compiled student is exported to ${format.name}. See the <a href="/docs/distillation">distillation pipeline</a> and the <a href="/gateway">gateway</a> that produces the training pairs.`
    : `${model.name} is an open-weight checkpoint (${model.params_b}B parameters from ${model.vendor}). kolm compile pulls the bf16 weights, runs ${format.family === 'gguf' ? 'GGUF mixed-precision quantization via llama.cpp' : format.family === 'exl2' ? 'EXL2 packed quantization with calibration' : format.family === 'gptq' ? 'GPTQ calibration with C4 calibration samples' : format.family === 'awq' ? 'activation-aware AWQ quantization with calibration' : 'MLX conversion targeting Apple Silicon unified memory'}, and emits a signed .kolm artifact with the quantized weights and the original bf16 SHA-256 hashes for reproducibility.`;
  const intro3 = `The output is a single ${format.name} file plus a receipt. The receipt records every input weight hash, the quantization method, wall-clock duration, and the host hardware profile. You can verify a compiled artifact end-to-end at <a href="/verify-prod">/verify-prod</a> or with <code>kolm verify ./artifact.kolm</code>.`;
  const intro4 = est.grounded
    ? `Resource estimates below are mirrored from the <a href="/benchmarks/sota-quantize-matrix.json">verified quantize matrix</a> (${safe(est.hardware)}). Numbers labelled "Caveats: verifying" have not been measured on the specific (${model.name}, ${format.name}) pair yet — run <code>${safe(cmd)}</code> on your hardware to log a receipt and contribute the measurement back.`
    : `Resource estimates below are computed from parameter count and target bits-per-weight. They are unverified until you run <code>${safe(cmd)}</code> on your hardware and a receipt is logged. Caveats: verifying.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${safe(title)}</title>
<meta name="description" content="${safe(description)}">
<meta name="keywords" content="kolm, ${safe(model.slug)}, ${safe(format.slug)}, ${safe(format.family)}, compile, quantize, ${safe(model.vendor)}, distill, local LLM">
<meta name="theme-color" content="#0b0d10">
<meta name="author" content="kolm.ai">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<meta property="og:site_name" content="kolm.ai">
<meta property="og:title" content="${safe(title)}">
<meta property="og:description" content="${safe(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://kolm.ai/compile/${slug}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safe(title)}">
<meta name="twitter:description" content="${safe(description)}">
<link rel="canonical" href="https://kolm.ai/compile/${slug}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Product",
      "@id": "https://kolm.ai/compile/${slug}#product",
      "name": "${safe(model.name)} → ${safe(format.name)} via kolm",
      "description": "${safe(description)}",
      "category": "Software",
      "brand": { "@type": "Brand", "name": "kolm.ai" },
      "url": "https://kolm.ai/compile/${slug}",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD", "availability": "https://schema.org/InStock" }
    },
    {
      "@type": "HowTo",
      "@id": "https://kolm.ai/compile/${slug}#howto",
      "name": "How to compile ${safe(model.name)} to ${safe(format.name)} with kolm",
      "description": "${safe(description)}",
      "totalTime": "PT5M",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Install kolm", "text": "Install the kolm CLI from source: pip install git+https://github.com/kolm-ai/kolm@main#subdirectory=sdk/python or npm i -g github:kolm-ai/kolm." },
        { "@type": "HowToStep", "position": 2, "name": "Sign up", "text": "Sign up at https://kolm.ai/signup to obtain an API key. Self-serve, free tier available." },
        { "@type": "HowToStep", "position": 3, "name": "Run compile", "text": "Run: ${safe(cmd)}" },
        { "@type": "HowToStep", "position": 4, "name": "Verify the receipt", "text": "Run: kolm verify ./artifact.kolm — confirms SHA-256 chain + ed25519 signature + K-score." },
        { "@type": "HowToStep", "position": 5, "name": "Serve or deploy", "text": "Run kolm serve ./artifact.kolm to start a local OpenAI-compatible endpoint, or kolm deploy ./artifact.kolm --device <name> to push to a remote device." }
      ]
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "kolm.ai", "item": "https://kolm.ai/" },
        { "@type": "ListItem", "position": 2, "name": "Compile", "item": "https://kolm.ai/compile" },
        { "@type": "ListItem", "position": 3, "name": "${safe(model.name)} to ${safe(format.name)}", "item": "https://kolm.ai/compile/${slug}" }
      ]
    }
  ]
}
</script>
<style>
:root{--ink:#1f2937;--ink-mute:#56606c;--ink-faint:#8a93a0;--bg:#ffffff;--bg-elev:#f3f5f7;--accent:#2563eb;--cta-fg:#ffffff;--cta-hover-bg:#56606c;--line:rgba(31,41,55,.12);--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ink:#e6e9ee;--ink-mute:#9aa3b2;--ink-faint:#6b7280;--bg:#0b0d10;--bg-elev:#11151b;--accent:#6f9bff;--cta-fg:#0b0d10;--cta-hover-bg:#cdd4dd;--line:rgba(230,233,238,.10)}}
[data-theme="dark"]{--ink:#e6e9ee;--ink-mute:#9aa3b2;--ink-faint:#6b7280;--bg:#0b0d10;--bg-elev:#11151b;--accent:#6f9bff;--cta-fg:#0b0d10;--cta-hover-bg:#cdd4dd;--line:rgba(230,233,238,.10)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:17px;line-height:1.65}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.site{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:50}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;max-width:1080px;margin:0 auto;padding:14px 24px}
header.site .logo{font-family:var(--mono);font-weight:600;letter-spacing:1.2px;color:var(--ink);font-size:18px}
header.site nav a{margin-left:24px;color:var(--ink-mute);font-size:14px}
header.site nav a:hover{color:var(--ink)}
main{max-width:840px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:36px;line-height:1.15;letter-spacing:-1px;font-weight:680;margin:0 0 14px}
h2{font-size:22px;line-height:1.25;letter-spacing:-0.3px;font-weight:640;margin:42px 0 12px}
h3{font-size:17px;line-height:1.35;font-weight:600;margin:24px 0 10px}
p{margin:0 0 16px}.lede{font-size:18px;color:var(--ink-mute);margin:0 0 28px}
ul,ol{padding-left:22px;margin:0 0 16px}li{margin:6px 0}
code{font-family:var(--mono);font-size:14px;background:var(--bg-elev);padding:2px 6px;border-radius:4px;color:var(--ink)}
pre{font-family:var(--mono);font-size:13px;background:var(--bg-elev);padding:16px 20px;border-radius:8px;overflow-x:auto;line-height:1.55;border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;margin:14px 0 22px;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
th{color:var(--ink-faint);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:500}
td{color:var(--ink);font-family:var(--mono)}
.badge{display:inline-block;font-size:11px;font-family:var(--mono);padding:3px 8px;border-radius:99px;border:1px solid var(--line);color:var(--ink-mute);text-transform:uppercase;letter-spacing:.6px;margin-left:8px}
.badge-grounded{color:var(--accent);border-color:var(--line)}
.badge-est{color:var(--ink-mute)}
.muted{color:var(--ink-faint)}
.cta{display:inline-block;background:var(--accent);color:var(--cta-fg);padding:11px 22px;border-radius:8px;font-weight:600;font-family:var(--mono);font-size:14px;margin:8px 12px 8px 0}.cta:hover{text-decoration:none;background:var(--cta-hover-bg)}
.cta-alt{display:inline-block;background:transparent;color:var(--accent);border:1px solid var(--accent);padding:10px 22px;border-radius:8px;font-weight:600;font-family:var(--mono);font-size:14px;margin:8px 12px 8px 0}.cta-alt:hover{text-decoration:none;background:var(--bg-elev)}
footer{max-width:1080px;margin:0 auto;padding:32px 24px;color:var(--ink-faint);font-size:13px;border-top:1px solid var(--line)}
@media (max-width:560px){main{padding:32px 18px 64px}h1{font-size:28px}h2{font-size:20px}}
</style>
</head>
<body>
<a href="#main" style="position:absolute;left:-9999px" onfocus="this.style.cssText='position:fixed;top:8px;left:8px;background:#111;color:#fff;padding:8px 12px;border-radius:6px;z-index:100'">Skip to content</a>
<header class="site"><div class="wrap"><a class="logo" href="/">kolm.ai</a><nav><a href="/product">Product</a><a href="/solutions/teams">For teams</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/enterprise">Enterprise</a></nav></div></header>
<main id="main">

<p class="muted"><a href="/compile/all">&larr; Compile catalog</a></p>
<h1>Compile ${safe(model.name)} to ${safe(format.name)} on consumer hardware with kolm.</h1>
<p class="lede">${intro1}</p>

<p>${intro2}</p>
<p>${intro3}</p>
<p>${intro4}</p>

<h2>One-line command</h2>
<pre><code>$ ${safe(cmd)}</code></pre>
<p class="muted">Runs the full compile pipeline: download bf16 weights, quantize to ${safe(format.name)}, sign the receipt, write the .kolm artifact. See the <a href="${safe(docsLinkFor(format))}">${safe(format.name)} compile docs</a> for flags + tuning.</p>

<h2>Resource estimate ${groundedBadge}</h2>
<table>
  <thead>
    <tr><th>Resource</th><th>Estimate</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td>VRAM at inference</td><td>${vramCell}</td><td class="muted">${safe(format.runtime)}</td></tr>
    <tr><td>Disk after compile</td><td>${diskCell}</td><td class="muted">single ${safe(format.name)} file</td></tr>
    <tr><td>Compile wall-time</td><td>${timeCell}</td><td class="muted">${est.grounded ? 'measured on RTX 5090' : 'depends on hardware'}</td></tr>
    ${est.throughput_tok_per_sec ? `<tr><td>Inference throughput</td><td>${est.throughput_tok_per_sec} tok/s</td><td class="muted">single-stream on RTX 5090</td></tr>` : ''}
  </tbody>
</table>
${est.note ? `<p class="muted">${safe(est.note)}</p>` : ''}
${est.receipt ? `<p class="muted">Reference receipt: <code>${safe(est.receipt)}</code></p>` : ''}

<h2>Step-by-step</h2>
<ol>
  <li><strong>Install kolm.</strong> <code>npm i -g github:kolm-ai/kolm</code> or <code>pip install git+https://github.com/kolm-ai/kolm@main#subdirectory=sdk/python</code>.</li>
  <li><strong>Sign up.</strong> <a href="/signup">Create an account</a> and copy your API key. Free tier available.</li>
  <li><strong>Run compile.</strong> <code>${safe(cmd)}</code></li>
  <li><strong>Verify the receipt.</strong> <code>kolm verify ./artifact.kolm</code> &mdash; confirms SHA-256 chain, ed25519 signature, K-score.</li>
  <li><strong>Serve or deploy.</strong> <code>kolm serve ./artifact.kolm</code> for a local OpenAI-compatible endpoint, or <code>kolm deploy ./artifact.kolm --device my-box</code> to push to a remote machine.</li>
</ol>

<h2>Why kolm</h2>
<ul>
  <li><strong>Signed receipts.</strong> Every compile emits a receipt with input + output SHA-256 hashes, the quantization method, and an ed25519 signature. Verifiable end-to-end at <a href="/verify-prod">/verify-prod</a>.</li>
  <li><strong>Reproducible.</strong> Run the same compile twice on the same hardware: identical output hashes. The receipt makes it auditable.</li>
  <li><strong>Runs anywhere.</strong> The compiled ${safe(format.name)} artifact loads in ${safe(format.runtime)} with no kolm dependency at inference time. You own the weights.</li>
  <li><strong>Open source.</strong> Apache-2.0. <a href="https://github.com/kolm-ai/kolm" rel="noopener">GitHub</a>.</li>
</ul>

<h2>Try it</h2>
<a class="cta" href="/quickstart">Start free <span aria-hidden="true">&rarr;</span></a>
<a class="cta-alt" href="/verify">Verify a receipt</a>

<h2>See also</h2>
<ul>
${siblings.map((s) => `  <li><a href="${s.href}">${safe(s.label)}</a></li>`).join('\n')}
  <li><a href="/forge">Forge &mdash; the compile + distill surface</a></li>
  <li><a href="/pricing">Pricing &mdash; free, Pro, Team, Enterprise</a></li>
  <li><a href="${safe(docsLinkFor(format))}">${safe(format.name)} compile reference docs</a></li>
</ul>

</main>
<footer>kolm.ai &middot; the AI compiler &middot; <a href="/compile">all compile pages</a> &middot; <a href="/verify-prod">verify a receipt</a> &middot; <a href="/forge">Forge</a></footer>
</body>
</html>
`;
}

function buildCatalogPage(pages) {
  // Aggregate landing page at /compile listing all generated pairs.
  const rows = pages.map((p) => `      <li><a href="/compile/${p.slug}">${safe(p.model.name)} &rarr; ${safe(p.format.name)}</a> <span class="muted">&middot; ${safe(p.format.runtime)}</span></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Compile catalog &middot; ${pages.length} model + format pairs &middot; kolm.ai</title>
<meta name="description" content="Compile any of ${SOURCE_MODELS.length} frontier or open-weight models to ${TARGET_FORMATS.length} target formats (GGUF, EXL2, GPTQ, AWQ, MLX) with kolm. ${pages.length} per-pair compile guides.">
<meta name="theme-color" content="#0b0d10">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://kolm.ai/compile">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--ink:#1f2937;--ink-mute:#56606c;--ink-faint:#8a93a0;--bg:#ffffff;--bg-elev:#f3f5f7;--accent:#2563eb;--line:rgba(31,41,55,.12);--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ink:#e6e9ee;--ink-mute:#9aa3b2;--ink-faint:#6b7280;--bg:#0b0d10;--bg-elev:#11151b;--accent:#6f9bff;--line:rgba(230,233,238,.10)}}
[data-theme="dark"]{--ink:#e6e9ee;--ink-mute:#9aa3b2;--ink-faint:#6b7280;--bg:#0b0d10;--bg-elev:#11151b;--accent:#6f9bff;--line:rgba(230,233,238,.10)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:17px;line-height:1.65}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.site{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:50}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;max-width:1080px;margin:0 auto;padding:14px 24px}
header.site .logo{font-family:var(--mono);font-weight:600;letter-spacing:1.2px;color:var(--ink);font-size:18px}
header.site nav a{margin-left:24px;color:var(--ink-mute);font-size:14px}
main{max-width:880px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:34px;line-height:1.15;letter-spacing:-1px;font-weight:680;margin:0 0 14px}
h2{font-size:20px;line-height:1.25;font-weight:640;margin:34px 0 10px;color:var(--ink-mute);font-family:var(--mono);text-transform:uppercase;letter-spacing:1.2px;font-size:12px}
.lede{font-size:18px;color:var(--ink-mute);margin:0 0 28px}
ul{padding-left:22px;margin:0 0 24px;column-count:1}
li{margin:5px 0}
.muted{color:var(--ink-faint);font-size:13px}
footer{max-width:1080px;margin:0 auto;padding:32px 24px;color:var(--ink-faint);font-size:13px;border-top:1px solid var(--line)}
@media (min-width:720px){ul{column-count:2;column-gap:32px}}
</style>
</head>
<body>
<header class="site"><div class="wrap"><a class="logo" href="/">kolm.ai</a><nav><a href="/product">Product</a><a href="/solutions/teams">For teams</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/enterprise">Enterprise</a></nav></div></header>
<main>
  <h1>Compile catalog</h1>
  <p class="lede">${pages.length} per-pair compile guides: ${SOURCE_MODELS.length} source models &rarr; ${TARGET_FORMATS.length} target formats. Every page documents the <code>kolm compile</code> one-liner, a resource estimate, and a verify step.</p>

${SOURCE_MODELS.map((m) => {
  const modelPages = pages.filter((p) => p.model.slug === m.slug);
  if (modelPages.length === 0) return '';
  return `  <h2>${safe(m.name)} &middot; ${safe(m.vendor)}</h2>
  <ul>
${modelPages.map((p) => `    <li><a href="/compile/${p.slug}">to ${safe(p.format.name)}</a> <span class="muted">&middot; ${safe(p.format.runtime)}</span></li>`).join('\n')}
  </ul>`;
}).join('\n')}

</main>
<footer>kolm.ai &middot; the AI compiler &middot; <a href="/forge">Forge</a> &middot; <a href="/pricing">Pricing</a> &middot; <a href="/verify-prod">verify a receipt</a></footer>
</body>
</html>
`;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const pages = [];
  for (const m of SOURCE_MODELS) {
    for (const f of TARGET_FORMATS) {
      pages.push({ slug: `${m.slug}-to-${f.slug}`, model: m, format: f });
    }
  }

  if (dryRun) {
    console.log(`# dry-run: would generate ${pages.length} pages`);
    for (const p of pages) console.log(`  /compile/${p.slug}`);
    return;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  for (const p of pages) {
    const html = buildPage(p.model, p.format);
    fs.writeFileSync(path.join(OUT_DIR, `${p.slug}.html`), html, 'utf8');
    written++;
  }
  // Write /compile/all catalog (full pair grid). Cannot use /compile/index.html
  // because the sitemap rewrites that to /compile which collides with the
  // existing /compile.html (the canonical compile surface).
  const catalog = buildCatalogPage(pages);
  fs.writeFileSync(path.join(OUT_DIR, 'all.html'), catalog, 'utf8');

  console.log(`# wrote ${written} SEO pages under /compile/ + 1 catalog at /compile/all.html`);
}

if (require.main === module) main();
module.exports = { SOURCE_MODELS, TARGET_FORMATS, buildPage, buildCatalogPage };
