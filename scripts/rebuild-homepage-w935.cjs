#!/usr/bin/env node
/* W935 — rebuild index.html: replace the ~18-section kitchen-sink body (hero..</main>)
 * with a tight 7-section homepage that leads with the moat and gives all three product
 * pillars equal weight (capture / build-and-own / govern). Keeps head, nav, footer, scripts.
 * Authored em-dash-free + banned-word-free. */
const fs = require('fs');
const path = require('path');
const F = path.resolve(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(F, 'utf8');

const A = html.indexOf('<section class="ks-hero"');
const B = html.indexOf('</main>');
if (A < 0 || B < 0 || B < A) throw new Error('splice anchors not found');

const STYLE = `
<style id="hp-w935">
/* ---- W935 homepage: precision-instrument, cool-slate, cobalt rationed ---- */
:root{ --hp-c:var(--ks-accent,#2563eb); --hp-ink:var(--ks-ink,#11151b); --hp-ink2:var(--ks-ink-2,#3b444f);
  --hp-mut:var(--ks-ink-3,#6a7480); --hp-bg:var(--ks-bg,#f5f7f9); --hp-pan:var(--ks-bg-1,#ffffff);
  --hp-line:var(--ks-line-2,#e3e7ec); --hp-line2:var(--ks-line-3,#cfd6de);
  --hp-mono:var(--ks-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  --hp-slate:#0e1320; --hp-slate-ink:#d6deea; }
html[data-theme=dark]{ --hp-c:var(--ks-accent,#6f9bff); --hp-ink:#eef1f5; --hp-ink2:#aeb8c4; --hp-mut:#7c8794;
  --hp-bg:#0b0e13; --hp-pan:#11151b; --hp-line:#1d2430; --hp-line2:#2a3340; }
.hp{ color:var(--hp-ink); }
.hp-wrap{ max-width:1160px; margin:0 auto; padding:0 28px; }
.hp-sec{ padding:clamp(56px,7vw,104px) 0; border-top:1px solid var(--hp-line); position:relative; }
.hp-sec:first-of-type{ border-top:0; }
.hp-idx{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.22em; text-transform:uppercase;
  color:var(--hp-mut); display:flex; align-items:center; gap:10px; margin:0 0 22px; }
.hp-idx b{ color:var(--hp-c); font-weight:600; }
.hp-idx::after{ content:""; flex:0 0 28px; height:1px; background:var(--hp-c); opacity:.5; }
.hp-h2{ font-family:var(--ks-display,Inter,system-ui,sans-serif); font-weight:560; letter-spacing:-.022em;
  font-size:clamp(27px,3.6vw,44px); line-height:1.08; margin:0 0 14px; max-width:20ch; text-wrap:balance; }
.hp-lede{ font-size:clamp(15.5px,1.4vw,18px); line-height:1.55; color:var(--hp-ink2); max-width:62ch; margin:0 0 26px; }
.hp-mono{ font-family:var(--hp-mono); }
.hp-trust{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.14em; color:var(--hp-mut); text-transform:uppercase; }
.hp-btn{ display:inline-flex; align-items:center; gap:8px; font-size:14.5px; font-weight:540; border-radius:8px;
  padding:12px 20px; text-decoration:none; transition:transform .12s ease, background .12s ease, border-color .12s; }
.hp-btn--p{ background:var(--hp-c); color:#fff; }
.hp-btn--p:hover{ transform:translateY(-1px); }
.hp-btn--g{ border:1px solid var(--hp-line2); color:var(--hp-ink); }
.hp-btn--g:hover{ border-color:var(--hp-c); color:var(--hp-c); }
.hp-ctas{ display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.hp-link{ color:var(--hp-c); text-decoration:none; border-bottom:1px solid transparent; font-weight:500; }
.hp-link:hover{ border-bottom-color:var(--hp-c); }

/* hero */
.hp-hero{ display:grid; grid-template-columns:5fr 7fr; gap:clamp(28px,4vw,64px); align-items:center;
  padding:clamp(40px,6vw,84px) 0 clamp(48px,6vw,88px); }
.hp-hero__eye{ font-family:var(--hp-mono); font-size:12px; letter-spacing:.24em; text-transform:uppercase; color:var(--hp-c); margin:0 0 18px; }
.hp-hero h1{ font-family:var(--ks-display,Inter,system-ui,sans-serif); font-weight:580; letter-spacing:-.03em;
  font-size:clamp(38px,5.2vw,66px); line-height:1.02; margin:0 0 20px; }
.hp-hero__sub{ font-size:clamp(16px,1.5vw,19px); line-height:1.5; color:var(--hp-ink2); max-width:54ch; margin:0 0 26px; }
.hp-hero__trust{ margin-top:24px; }
@media(max-width:920px){ .hp-hero{ grid-template-columns:1fr; } }

/* receipt artifact */
.hp-rcpt{ background:var(--hp-pan); border:1px solid var(--hp-line2); border-radius:14px; overflow:hidden;
  box-shadow:0 24px 60px -32px rgba(20,30,50,.35); font-family:var(--hp-mono); font-size:12.5px; }
.hp-rcpt__bar{ display:flex; justify-content:space-between; align-items:center; padding:11px 16px;
  border-bottom:1px solid var(--hp-line); color:var(--hp-mut); font-size:11px; letter-spacing:.12em; text-transform:uppercase; }
.hp-rcpt__rows{ padding:6px 0; }
.hp-rcpt__r{ display:grid; grid-template-columns:84px 1fr; gap:14px; padding:7px 18px; opacity:0; transform:translateY(3px);
  transition:opacity .35s ease, transform .35s ease; }
.hp-rcpt.is-signed .hp-rcpt__r{ opacity:1; transform:none; }
.hp-rcpt__k{ color:var(--hp-mut); text-transform:uppercase; font-size:10.5px; letter-spacing:.08em; padding-top:1px; }
.hp-rcpt__v{ color:var(--hp-ink); word-break:break-all; }
.hp-rcpt__foot{ display:flex; justify-content:space-between; align-items:center; padding:12px 18px;
  border-top:1px solid var(--hp-line); font-size:11.5px; color:var(--hp-mut); }
.hp-rcpt__sig{ color:var(--hp-mut); font-weight:600; transition:color .4s ease, text-shadow .4s ease; }
.hp-rcpt.is-signed .hp-rcpt__sig{ color:var(--hp-c); text-shadow:0 0 12px color-mix(in srgb, var(--hp-c) 45%, transparent); }
.hp-rcpt__cap{ font-family:var(--hp-mono); font-size:11px; color:var(--hp-mut); margin:12px 2px 0; }
@media(prefers-reduced-motion:reduce){ .hp-rcpt__r{ opacity:1; transform:none; transition:none; } }

/* moat */
.hp-2col{ display:grid; grid-template-columns:1fr 1fr; gap:clamp(20px,3vw,40px); align-items:start; }
@media(max-width:860px){ .hp-2col{ grid-template-columns:1fr; } }
.hp-ledger{ list-style:none; margin:0; padding:0; }
.hp-ledger li{ display:grid; grid-template-columns:30px 1fr; gap:14px; padding:16px 0; border-bottom:1px solid var(--hp-line); }
.hp-ledger li:last-child{ border-bottom:0; }
.hp-ledger b{ font-family:var(--hp-mono); color:var(--hp-c); font-weight:600; font-size:13px; }
.hp-ledger p{ margin:0; font-size:14.5px; line-height:1.5; color:var(--hp-ink2); }
.hp-ledger p strong{ color:var(--hp-ink); font-weight:560; }
.hp-term{ background:var(--hp-slate); color:var(--hp-slate-ink); border-radius:12px; padding:20px 22px;
  font-family:var(--hp-mono); font-size:13px; line-height:1.7; overflow-x:auto; }
.hp-term .c{ color:#6b7689; } .hp-term .ok{ color:var(--hp-c); font-weight:600; }

/* triptych */
.hp-trip{ display:grid; grid-template-columns:repeat(3,1fr); gap:18px; }
@media(max-width:880px){ .hp-trip{ grid-template-columns:1fr; } }
.hp-card{ background:var(--hp-pan); border:1px solid var(--hp-line); border-radius:12px; padding:26px 24px; }
.hp-card--build{ border-left:2px solid var(--hp-c); }
.hp-card__tag{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--hp-mut); margin:0 0 14px; }
.hp-card--build .hp-card__tag{ color:var(--hp-c); }
.hp-card h3{ font-size:19px; font-weight:560; letter-spacing:-.01em; line-height:1.2; margin:0 0 10px; }
.hp-card p{ font-size:14.5px; line-height:1.55; color:var(--hp-ink2); margin:0 0 16px; }
.hp-card__m{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.06em; color:var(--hp-mut); text-transform:uppercase;
  border-top:1px solid var(--hp-line); padding-top:14px; }

/* build deep-dive: browser-chrome mock */
.hp-browser{ border:1px solid var(--hp-line2); border-radius:12px; overflow:hidden; background:var(--hp-pan); box-shadow:0 24px 60px -34px rgba(20,30,50,.32); }
.hp-browser__bar{ display:flex; align-items:center; gap:8px; padding:11px 14px; background:var(--hp-bg); border-bottom:1px solid var(--hp-line); }
.hp-dot{ width:10px; height:10px; border-radius:50%; background:var(--hp-line2); }
.hp-browser__url{ margin-left:10px; font-family:var(--hp-mono); font-size:11.5px; color:var(--hp-mut); }
.hp-tabs{ display:flex; flex-wrap:wrap; gap:4px; padding:14px 16px 0; border-bottom:1px solid var(--hp-line); }
.hp-tab{ font-family:var(--hp-mono); font-size:11.5px; padding:8px 13px; border-radius:7px 7px 0 0; color:var(--hp-mut); border:1px solid transparent; border-bottom:0; }
.hp-tab.on{ color:var(--hp-ink); background:var(--hp-pan); border-color:var(--hp-line); }
.hp-build__body{ padding:24px; }
.hp-progress{ display:flex; align-items:center; gap:14px; padding:16px 18px; border:1px solid var(--hp-line); border-radius:10px; background:var(--hp-bg); }
.hp-progress__bar{ flex:1; height:6px; border-radius:3px; background:var(--hp-line2); overflow:hidden; }
.hp-progress__fill{ display:block; height:100%; width:62%; background:var(--hp-c); border-radius:3px; }
.hp-progress__st{ font-family:var(--hp-mono); font-size:12px; color:var(--hp-c); }
.hp-chip{ display:inline-flex; align-items:center; gap:8px; margin-top:16px; font-family:var(--hp-mono); font-size:12px;
  background:color-mix(in srgb,var(--hp-c) 12%, transparent); color:var(--hp-c); border:1px solid color-mix(in srgb,var(--hp-c) 35%, transparent); padding:7px 13px; border-radius:8px; }
.hp-build__caption{ font-family:var(--hp-mono); font-size:11px; color:var(--hp-mut); margin:12px 2px 30px; text-align:center; }

/* govern control plane */
.hp-govern{ background:var(--hp-pan); }
html[data-theme=dark] .hp-govern{ background:var(--hp-bg); }
.hp-grid6{ display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--hp-line); border-radius:12px; overflow:hidden; }
@media(max-width:760px){ .hp-grid6{ grid-template-columns:1fr; } }
.hp-cell{ padding:22px; border-right:1px solid var(--hp-line); border-bottom:1px solid var(--hp-line); }
.hp-cell__l{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--hp-mut); margin:0 0 9px; }
.hp-cell--byoc .hp-cell__l{ color:var(--hp-c); }
.hp-cell p{ margin:0; font-size:14px; line-height:1.5; color:var(--hp-ink2); }
.hp-soc{ font-family:var(--hp-mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--hp-mut); margin:18px 0 6px; }

/* benchmark table */
.hp-bench{ width:100%; border-collapse:collapse; font-family:var(--hp-mono); font-size:14px; }
.hp-bench th{ text-align:left; font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--hp-mut); font-weight:500; padding:0 16px 12px; border-bottom:1px solid var(--hp-line2); }
.hp-bench td{ padding:14px 16px; border-bottom:1px solid var(--hp-line); font-variant-numeric:tabular-nums; }
.hp-bench tr.win td{ color:var(--hp-ink); }
.hp-bench tr.win td:first-child{ color:var(--hp-c); font-weight:600; box-shadow:inset 2px 0 0 var(--hp-c); }
.hp-foot-note{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.04em; color:var(--hp-mut); text-transform:uppercase; margin:16px 2px 0; }

/* close */
.hp-close{ text-align:center; }
.hp-close .hp-h2{ margin-left:auto; margin-right:auto; max-width:18ch; }
.hp-close .hp-lede{ margin-left:auto; margin-right:auto; }
.hp-close .hp-ctas{ justify-content:center; }
.hp-quiet{ margin-top:20px; font-size:13px; }
.hp-reveal{ opacity:1; }
@media(prefers-reduced-motion:no-preference){ .hp-reveal{ opacity:0; transform:translateY(14px); transition:opacity .6s ease, transform .6s ease; } .hp-reveal.in{ opacity:1; transform:none; } }
</style>
`;

const BODY = `
<div class="hp">

<!-- 01 Hero: the receipt is the hero image -->
<section class="hp-sec" aria-label="kolm, the AI compiler" style="padding-top:clamp(28px,4vw,56px);">
  <div class="hp-wrap">
    <div class="hp-hero">
      <div>
        <p class="hp-hero__eye">The AI compiler</p>
        <h1>Own your AI.<br>Prove every call.</h1>
        <p class="hp-hero__sub">Point any client at one URL, compile frontier-model quality into a small private model you run on your own hardware, and get a signed receipt for every call that anyone can verify offline. No per-token bill after you compile.</p>
        <div class="hp-ctas">
          <a class="hp-btn hp-btn--p" href="/signup">Start free <span aria-hidden="true">&rarr;</span></a>
          <a class="hp-btn hp-btn--g" href="/verify">Verify this receipt</a>
        </div>
        <p class="hp-trust hp-hero__trust">Apache&#8209;2.0 &middot; Self&#8209;hostable &middot; Air&#8209;gapped &middot; SOC&nbsp;2 Type&nbsp;I &middot; 6 SDKs</p>
      </div>
      <div>
        <div class="hp-rcpt" id="hp-receipt" aria-label="A signed kolm receipt">
          <div class="hp-rcpt__bar"><span>kolm receipt</span><span>RS&#8209;1</span></div>
          <div class="hp-rcpt__rows">
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">model</span><span class="hp-rcpt__v">trinity-500 &middot; Qwen2.5-7B &middot; INT4 NF4</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">artifact</span><span class="hp-rcpt__v">specialist.kolm</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">data</span><span class="hp-rcpt__v">sha256:9f2c&hellip; approved-rows</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">recipe</span><span class="hp-rcpt__v">council-distill &middot; 3 teachers</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">prompt</span><span class="hp-rcpt__v">sha256:4b81&hellip;</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">output</span><span class="hp-rcpt__v">sha256:e7a0&hellip;</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">key</span><span class="hp-rcpt__v">ed25519:kolm-tenant-pub</span></div>
            <div class="hp-rcpt__r"><span class="hp-rcpt__k">sig</span><span class="hp-rcpt__v">3045&hellip;f1c9</span></div>
          </div>
          <div class="hp-rcpt__foot"><span>19 fields &middot; canonical JSON</span><span class="hp-rcpt__sig" id="hp-sig">&check; signature valid</span></div>
        </div>
        <p class="hp-rcpt__cap">Anyone with the public key can check it. No account, no call back to us.</p>
      </div>
    </div>
  </div>
</section>

<!-- 02 Moat: proof leads -->
<section class="hp-sec hp-reveal" aria-label="The signed receipt">
  <div class="hp-wrap">
    <p class="hp-idx"><b>02</b> Proof</p>
    <h2 class="hp-h2" style="max-width:24ch;">A record you keep is a record they take your word for. A signed receipt is not.</h2>
    <p class="hp-lede">Every call returns 19 fields bound by an Ed25519 signature: model, data, recipe, prompt, output, key, and time. Change any one of them after the fact and the check fails. Verification runs on your own machine, air-gapped, with nothing but the public key.</p>
    <div class="hp-2col">
      <ul class="hp-ledger">
        <li><b>01</b><p><strong>Take the public key.</strong> No account, no login, no call back to us.</p></li>
        <li><b>02</b><p><strong>Check the receipt.</strong> Paste it at kolm.ai/verify, or run kolm verify receipt.json --key tenant.pub.</p></li>
        <li><b>03</b><p><strong>Read the result.</strong> A genuine receipt confirms; a tampered field fails immediately, with no middle answer to argue about.</p></li>
      </ul>
      <div class="hp-term" aria-label="Verify a receipt from the command line">
<span class="c"># every call returns a receipt id</span>
curl https://kolm.ai/v1/verify/&lt;receipt-id&gt;
{ "valid": <span class="ok">true</span>, "model": "&hellip;", "data": "sha256:&hellip;", "key": "ed25519:&hellip;" }

<span class="c"># offline, air-gapped, just the public key</span>
kolm verify receipt.json --key tenant.pub
      </div>
    </div>
    <div class="hp-ctas" style="margin-top:28px;"><a class="hp-btn hp-btn--p" href="/verify">Verify a live receipt <span aria-hidden="true">&rarr;</span></a></div>
  </div>
</section>

<!-- 03 Pillars: three jobs, one file -->
<section class="hp-sec hp-reveal" aria-label="What kolm does">
  <div class="hp-wrap">
    <p class="hp-idx"><b>03</b> The product</p>
    <h2 class="hp-h2" style="max-width:26ch;">Three jobs, one file you own at the end.</h2>
    <p class="hp-lede">Capture the calls worth keeping. Build a private model you own, in the browser or the CLI. Govern it across your whole org. Every path ends at one signed .kolm file, and every card carries a number you can open.</p>
    <div class="hp-trip">
      <div class="hp-card">
        <p class="hp-card__tag">Capture</p>
        <h3>Point every client at one URL.</h3>
        <p>kolm speaks OpenAI, Anthropic, Gemini, and vLLM. It routes every call, scrubs PII on the way in, and records the request-and-response pairs worth training on, in your tenant and not ours.</p>
        <p class="hp-card__m">7 protocols &middot; one endpoint</p>
      </div>
      <div class="hp-card hp-card--build">
        <p class="hp-card__tag">Build</p>
        <h3>Build a private model without writing training code.</h3>
        <p>Pick a captured task in the browser builder, or run one CLI command. kolm distills frontier quality from up to three teacher models, quantizes to INT4, and signs the result into one .kolm file you own outright. No per-token bill after you compile.</p>
        <p class="hp-card__m">DeepSeek-R1-32B &rarr; 17.9 GB INT4 &middot; one RTX 5090</p>
      </div>
      <div class="hp-card">
        <p class="hp-card__tag">Run</p>
        <h3>Run it anywhere you already run software.</h3>
        <p>The .kolm file runs local, in your cloud, or air-gapped, and exports to GGUF, Ollama, or Hugging Face with no proprietary loader. Same file, same signed receipts, wherever it runs.</p>
        <p class="hp-card__m">Local &middot; VPC &middot; air-gapped &middot; export</p>
      </div>
    </div>
  </div>
</section>

<!-- 04 Build deep-dive: the no-code builder is a real product -->
<section class="hp-sec hp-reveal" aria-label="Build a model you own">
  <div class="hp-wrap">
    <p class="hp-idx"><b>04</b> Build</p>
    <h2 class="hp-h2" style="max-width:24ch;">From a tab of captured calls to a model you own, no ML team required.</h2>
    <p class="hp-lede">The browser builder turns your real traffic into a specialist. The same recipe runs from one CLI command. You keep the weights, the data, and the receipts.</p>
    <div class="hp-browser">
      <div class="hp-browser__bar"><span class="hp-dot"></span><span class="hp-dot"></span><span class="hp-dot"></span><span class="hp-browser__url">kolm.ai/account/create-model</span></div>
      <div class="hp-tabs"><span class="hp-tab on">Upload data</span><span class="hp-tab">Describe the task</span><span class="hp-tab">Connect a source</span><span class="hp-tab">Capture from your stack</span></div>
      <div class="hp-build__body">
        <div class="hp-progress"><span class="hp-progress__st">distilling</span><span class="hp-progress__bar"><span class="hp-progress__fill"></span></span><span class="hp-progress__st">412 pairs &middot; 79s</span></div>
        <span class="hp-chip">&check; specialist.kolm &middot; 1.9 GB &middot; ready to download</span>
      </div>
    </div>
    <p class="hp-build__caption">The browser builder. No CLI required.</p>
    <div class="hp-2col">
      <ul class="hp-ledger">
        <li><b>01</b><p><strong>Pick a task</strong> from your captured calls.</p></li>
        <li><b>02</b><p><strong>Choose teachers,</strong> up to three frontier models.</p></li>
        <li><b>03</b><p><strong>Compile:</strong> distill, quantize, sign, watched live.</p></li>
        <li><b>04</b><p><strong>Own it:</strong> download specialist.kolm.</p></li>
      </ul>
      <div class="hp-term" aria-label="The same build from the CLI">
<span class="c"># prefer the terminal? same backend, one command</span>
kolm compile --task support --teachers 3 --sign
<span class="ok">&check;</span> signed specialist.kolm &middot; K-Score 0.91 (gate &ge; 0.85)
      </div>
    </div>
    <div class="hp-ctas" style="margin-top:28px;"><a class="hp-btn hp-btn--p" href="/account/create-model">Open the builder <span aria-hidden="true">&rarr;</span></a><a class="hp-link" href="/docs">Read the CLI docs</a></div>
  </div>
</section>

<!-- 05 Govern: the restored enterprise pillar -->
<section class="hp-sec hp-govern hp-reveal" aria-label="Govern it across your org">
  <div class="hp-wrap">
    <p class="hp-idx"><b>05</b> Govern</p>
    <h2 class="hp-h2" style="max-width:26ch;">Train where your data already lives. Then prove the controls held.</h2>
    <p class="hp-lede">A security questionnaire should not decide which model you ship. SSO, SCIM, and RBAC are the floor. BYOC keeps training and inference inside your boundary so data never leaves, residency spans nine regions, and the receipts make every one of those controls checkable after the fact.</p>
    <div class="hp-grid6">
      <div class="hp-cell"><p class="hp-cell__l">SSO / SAML</p><p>Your identity provider decides access.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">SCIM</p><p>Provisioning and deprovisioning, automatic.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">RBAC</p><p>Who can route, build, and export, by role.</p></div>
      <div class="hp-cell hp-cell--byoc"><p class="hp-cell__l">BYOC</p><p>Train and serve in your own VPC. Data never leaves your network.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">Data residency</p><p>Pin training and serving to one of nine regions.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">Audit export</p><p>Hand an auditor receipts they verify without you in the room.</p></div>
    </div>
    <p class="hp-soc">SOC&nbsp;2 Type&nbsp;I complete &middot; Type&nbsp;II in progress &middot; Apache&#8209;2.0 core</p>
    <p class="hp-lede" style="margin-top:6px;">SSO, SCIM, and RBAC are the floor. The signed receipt chain is the part no other gateway ships.</p>
    <div class="hp-ctas" style="margin-top:22px;"><a class="hp-btn hp-btn--p" href="/enterprise">Talk to us about BYOC <span aria-hidden="true">&rarr;</span></a><a class="hp-link" href="/proof">Read the trust page</a></div>
  </div>
</section>

<!-- 06 Trinity: one bounded proof number -->
<section class="hp-sec hp-reveal" aria-label="Trinity-500 benchmark">
  <div class="hp-wrap">
    <p class="hp-idx"><b>06</b> Proof, measured</p>
    <h2 class="hp-h2" style="max-width:24ch;">A 7B you own, matching gpt-4o-mini on the task that matters.</h2>
    <p class="hp-lede">Trinity-500 is a Qwen2.5-7B council-distilled from three frontier teachers. On a 57-prompt held-out support-clarification set it asks the right clarifying question 96.5% of the time, equal to gpt-4o-mini and well above claude-haiku, at about 1.24s and 210 characters, running INT4 on a single RTX 5090.</p>
    <table class="hp-bench">
      <thead><tr><th>Model</th><th>Asks the right question</th><th>Mean latency</th></tr></thead>
      <tbody>
        <tr class="win"><td>trinity-500 (7B &middot; INT4)</td><td>96.5%</td><td>1.24s</td></tr>
        <tr><td>gpt-4o-mini</td><td>96.5%</td><td>1.74s</td></tr>
        <tr><td>claude-haiku-4-5</td><td>64.9%</td><td>2.72s</td></tr>
      </tbody>
    </table>
    <p class="hp-foot-note">57-prompt held-out set &middot; INT4 NF4 on RTX 5090 &middot; about 1/30th the active params &middot; every number at trinity-500-benchmark.json</p>
    <p class="hp-lede" style="margin-top:18px; max-width:64ch;">This is the support-clarification task. We do not claim it beats the frontier everywhere; we claim you can check the cases we do.</p>
    <div class="hp-ctas" style="margin-top:8px;"><a class="hp-link" href="/benchmarks/trinity-500-benchmark.json">Read the raw benchmark <span aria-hidden="true">&rarr;</span></a></div>
  </div>
</section>

<!-- 07 Close -->
<section class="hp-sec hp-close hp-reveal" aria-label="Get started">
  <div class="hp-wrap">
    <p class="hp-idx" style="justify-content:center;"><b>07</b> Start</p>
    <h2 class="hp-h2">Stop renting intelligence you cannot prove.</h2>
    <p class="hp-lede">Compile your first signed .kolm in under a minute, on a clean machine. Keep the model, the data, and the receipt. No per-token bill after you compile, no vendor lock-in, Apache-2.0 all the way down.</p>
    <div class="hp-ctas">
      <a class="hp-btn hp-btn--p" href="/signup">Start free <span aria-hidden="true">&rarr;</span></a>
      <a class="hp-btn hp-btn--g" href="/book-demo">Book a demo</a>
    </div>
    <p class="hp-trust" style="margin-top:26px;">Apache&#8209;2.0 &middot; Self&#8209;hostable &middot; Air&#8209;gapped &middot; SOC&nbsp;2 Type&nbsp;I &middot; 6 SDKs</p>
    <p class="hp-quiet"><a class="hp-link" href="/pricing">See pricing</a></p>
  </div>
</section>

</div>

<script>
(function(){
  // receipt signs on load
  var r=document.getElementById('hp-receipt');
  if(r){ var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(rm){ r.classList.add('is-signed'); }
    else { var rows=r.querySelectorAll('.hp-rcpt__r'); rows.forEach(function(el,i){ setTimeout(function(){ el.style.opacity='1'; el.style.transform='none'; }, 90*i); });
      setTimeout(function(){ r.classList.add('is-signed'); }, 90*rows.length+260); }
  }
  // scroll reveal
  if('IntersectionObserver' in window && !(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)){
    var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }); }, {threshold:0.12});
    document.querySelectorAll('.hp-reveal').forEach(function(el){ io.observe(el); });
  } else { document.querySelectorAll('.hp-reveal').forEach(function(el){ el.classList.add('in'); }); }
})();
</script>
`;

const out = html.slice(0, A) + STYLE + BODY + '\n\n' + html.slice(B);
fs.writeFileSync(F, out);
const before = html.split('\n').length, after = out.split('\n').length;
console.log('homepage rebuilt: ' + before + ' lines -> ' + after + ' lines');
const ed = (out.match(/—/g)||[]).length + (out.match(/&mdash;/g)||[]).length;
console.log('em-dashes (raw + entity): ' + ed);
for (const w of ['wrapper','studio',' surface','evidence-to-artifact','honesty','honest','bill goes to zero']) {
  var n=(BODY.toLowerCase().split(w.toLowerCase()).length-1); if(n) console.log('  BANNED in new body: "'+w+'" x'+n);
}
console.log('done.');
