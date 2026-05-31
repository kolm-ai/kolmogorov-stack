#!/usr/bin/env node
/* W936 — rebuild index.html for the "AI control plane for teams" positioning.
 * Hero covers the ENTIRE product (see/own/run/govern). A dedicated section makes
 * the value-of-leaving-data case. Proof is demoted to the govern section.
 * Splices <style id="hp-w935"> .. </main>; keeps head/nav/footer/scripts.
 * Em-dash-free + banned-word-free. Always-visible (no opacity scroll-reveal). */
const fs = require('fs');
const path = require('path');
const F = path.resolve(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(F, 'utf8');
const A = html.indexOf('<style id="hp-w935">');
const B = html.indexOf('</main>');
if (A < 0 || B < 0 || B < A) throw new Error('splice anchors not found');

const STYLE = `<style id="hp-w936">
:root{ --hp-c:var(--ks-accent,#2563eb); --hp-ink:var(--ks-ink,#11151b); --hp-ink2:var(--ks-ink-2,#3b444f);
  --hp-mut:var(--ks-ink-3,#6a7480); --hp-bg:var(--ks-bg,#f5f7f9); --hp-pan:var(--ks-bg-1,#ffffff);
  --hp-line:var(--ks-line-2,#e3e7ec); --hp-line2:var(--ks-line-3,#cfd6de);
  --hp-mono:var(--ks-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); --hp-slate:#0e1320; --hp-slate-ink:#d6deea; }
html[data-theme=dark]{ --hp-c:var(--ks-accent,#6f9bff); --hp-ink:#eef1f5; --hp-ink2:#aeb8c4; --hp-mut:#7c8794;
  --hp-bg:#0b0e13; --hp-pan:#11151b; --hp-line:#1d2430; --hp-line2:#2a3340; }
.hp{ color:var(--hp-ink); }
.hp-wrap{ max-width:1160px; margin:0 auto; padding:0 28px; }
.hp-sec{ padding:clamp(54px,7vw,100px) 0; border-top:1px solid var(--hp-line); }
.hp-idx{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:var(--hp-mut); display:flex; align-items:center; gap:10px; margin:0 0 20px; }
.hp-idx b{ color:var(--hp-c); font-weight:600; } .hp-idx::after{ content:""; flex:0 0 28px; height:1px; background:var(--hp-c); opacity:.5; }
.hp-h2{ font-family:var(--ks-display,Inter,system-ui,sans-serif); font-weight:560; letter-spacing:-.022em; font-size:clamp(27px,3.6vw,44px); line-height:1.08; margin:0 0 14px; max-width:22ch; text-wrap:balance; }
.hp-lede{ font-size:clamp(15.5px,1.4vw,18px); line-height:1.55; color:var(--hp-ink2); max-width:64ch; margin:0 0 26px; }
.hp-btn{ display:inline-flex; align-items:center; gap:8px; font-size:14.5px; font-weight:540; border-radius:8px; padding:12px 20px; text-decoration:none; transition:transform .12s, background .12s, border-color .12s; }
.hp-btn--p{ background:var(--hp-c); color:#fff; } .hp-btn--p:hover{ transform:translateY(-1px); }
.hp-btn--g{ border:1px solid var(--hp-line2); color:var(--hp-ink); } .hp-btn--g:hover{ border-color:var(--hp-c); color:var(--hp-c); }
.hp-ctas{ display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.hp-link{ color:var(--hp-c); text-decoration:none; border-bottom:1px solid transparent; font-weight:500; } .hp-link:hover{ border-bottom-color:var(--hp-c); }
.hp-trust{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.14em; color:var(--hp-mut); text-transform:uppercase; }
/* hero */
.hp-hero{ display:grid; grid-template-columns:1.05fr 1fr; gap:clamp(28px,4vw,64px); align-items:center; padding:clamp(40px,6vw,84px) 0 clamp(48px,6vw,88px); }
.hp-hero__eye{ font-family:var(--hp-mono); font-size:12px; letter-spacing:.24em; text-transform:uppercase; color:var(--hp-c); margin:0 0 18px; }
.hp-hero h1{ font-family:var(--ks-display,Inter,system-ui,sans-serif); font-weight:580; letter-spacing:-.03em; font-size:clamp(36px,4.8vw,60px); line-height:1.03; margin:0 0 20px; }
.hp-hero__sub{ font-size:clamp(16px,1.5vw,19px); line-height:1.5; color:var(--hp-ink2); max-width:56ch; margin:0 0 26px; }
.hp-hero__trust{ margin-top:24px; }
@media(max-width:920px){ .hp-hero{ grid-template-columns:1fr; } }
/* control-plane panel */
.hp-cp{ background:var(--hp-pan); border:1px solid var(--hp-line2); border-radius:14px; overflow:hidden; box-shadow:0 24px 60px -34px rgba(20,30,50,.34); font-family:var(--hp-mono); font-size:12.5px; }
.hp-cp__bar{ display:flex; justify-content:space-between; align-items:center; padding:11px 16px; border-bottom:1px solid var(--hp-line); color:var(--hp-mut); font-size:11px; letter-spacing:.1em; text-transform:uppercase; }
.hp-cp__providers{ display:flex; flex-wrap:wrap; gap:7px; padding:14px 16px 8px; }
.hp-chip{ font-family:var(--hp-mono); font-size:11px; border:1px solid var(--hp-line2); border-radius:999px; padding:4px 11px; color:var(--hp-ink2); }
.hp-cp__arrow{ text-align:center; color:var(--hp-mut); font-size:14px; padding:2px 0; }
.hp-cp__feed{ padding:4px 0 6px; }
.hp-cp__row{ display:grid; grid-template-columns:1fr auto auto; gap:10px; padding:7px 16px; border-top:1px solid var(--hp-line); align-items:center; }
.hp-cp__who{ color:var(--hp-ink); } .hp-cp__mdl{ color:var(--hp-mut); } .hp-cp__cost{ color:var(--hp-c); font-variant-numeric:tabular-nums; }
.hp-cp__pillars{ display:grid; grid-template-columns:repeat(4,1fr); border-top:1px solid var(--hp-line); }
.hp-cp__p{ padding:11px 8px; text-align:center; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--hp-mut); border-right:1px solid var(--hp-line); }
.hp-cp__p:last-child{ border-right:0; } .hp-cp__p.on{ color:var(--hp-c); box-shadow:inset 0 -2px 0 var(--hp-c); }
.hp-cp__cap{ font-family:var(--hp-mono); font-size:11px; color:var(--hp-mut); margin:12px 2px 0; }
/* pillars triptych */
.hp-trip{ display:grid; grid-template-columns:repeat(3,1fr); gap:18px; margin-top:8px; }
@media(max-width:880px){ .hp-trip{ grid-template-columns:1fr; } }
.hp-card{ background:var(--hp-pan); border:1px solid var(--hp-line); border-radius:12px; padding:24px; }
.hp-card__tag{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--hp-mut); margin:0 0 12px; }
.hp-card h3{ font-size:18px; font-weight:560; letter-spacing:-.01em; line-height:1.2; margin:0 0 9px; }
.hp-card p{ font-size:14px; line-height:1.55; color:var(--hp-ink2); margin:0 0 14px; }
.hp-card__m{ font-family:var(--hp-mono); font-size:10.5px; letter-spacing:.06em; color:var(--hp-mut); text-transform:uppercase; border-top:1px solid var(--hp-line); padding-top:12px; }
/* problem tiles */
.hp-tiles{ display:grid; grid-template-columns:repeat(2,1fr); gap:16px; }
@media(max-width:760px){ .hp-tiles{ grid-template-columns:1fr; } }
.hp-tile{ border:1px solid var(--hp-line); border-radius:12px; padding:20px 22px; background:var(--hp-pan); }
.hp-tile h4{ margin:0 0 6px; font-size:15.5px; font-weight:560; }
.hp-tile p{ margin:0; font-size:14px; color:var(--hp-ink2); line-height:1.5; }
.hp-tile .fix{ display:block; margin-top:10px; font-family:var(--hp-mono); font-size:11.5px; color:var(--hp-c); }
/* two-col + ledger + govern grid */
.hp-2col{ display:grid; grid-template-columns:1fr 1fr; gap:clamp(20px,3vw,40px); align-items:start; } @media(max-width:860px){ .hp-2col{ grid-template-columns:1fr; } }
.hp-grid6{ display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--hp-line); border-radius:12px; overflow:hidden; } @media(max-width:760px){ .hp-grid6{ grid-template-columns:1fr; } }
.hp-cell{ padding:20px 22px; border-right:1px solid var(--hp-line); border-bottom:1px solid var(--hp-line); }
.hp-cell__l{ font-family:var(--hp-mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--hp-mut); margin:0 0 8px; }
.hp-cell--byoc .hp-cell__l{ color:var(--hp-c); } .hp-cell p{ margin:0; font-size:13.5px; line-height:1.5; color:var(--hp-ink2); }
.hp-soc{ font-family:var(--hp-mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--hp-mut); margin:16px 0 6px; }
/* close */
.hp-close{ text-align:center; } .hp-close .hp-h2{ margin:0 auto 14px; max-width:20ch; } .hp-close .hp-lede{ margin:0 auto 26px; } .hp-close .hp-ctas{ justify-content:center; }
</style>`;

const BODY = `
<div class="hp">

<!-- 01 Hero: the entire product -->
<section class="hp-sec" aria-label="kolm, the AI control plane for teams" style="border-top:0;padding-top:clamp(28px,4vw,52px);">
  <div class="hp-wrap">
    <div class="hp-hero">
      <div>
        <p class="hp-hero__eye">The AI control plane for teams</p>
        <h1>Own your company's<br>AI layer.</h1>
        <p class="hp-hero__sub">Every employee's AI use, in one place you control. kolm captures it, shows you the cost, turns it into models you own, runs them anywhere from the cloud to your own machines, and governs the whole thing. No AI team required.</p>
        <div class="hp-ctas">
          <a class="hp-btn hp-btn--p" href="/account/connect">See your team's AI <span aria-hidden="true">&rarr;</span></a>
          <a class="hp-btn hp-btn--g" href="/book-demo">Book a demo</a>
        </div>
        <p class="hp-trust hp-hero__trust">See &middot; Own &middot; Run anywhere &middot; Govern &mdash; one platform</p>
      </div>
      <div>
        <div class="hp-cp" aria-label="The kolm control plane">
          <div class="hp-cp__bar"><span>your team's AI</span><span>live</span></div>
          <div class="hp-cp__providers"><span class="hp-chip">OpenAI</span><span class="hp-chip">Anthropic</span><span class="hp-chip">Gemini</span><span class="hp-chip">vLLM</span><span class="hp-chip">your models</span></div>
          <div class="hp-cp__arrow" aria-hidden="true">&darr; routed &middot; redacted &middot; captured &darr;</div>
          <div class="hp-cp__feed">
            <div class="hp-cp__row"><span class="hp-cp__who">alex &middot; support</span><span class="hp-cp__mdl">gpt-4o</span><span class="hp-cp__cost">$0.011</span></div>
            <div class="hp-cp__row"><span class="hp-cp__who">priya &middot; legal</span><span class="hp-cp__mdl">claude</span><span class="hp-cp__cost">$0.043</span></div>
            <div class="hp-cp__row"><span class="hp-cp__who">sam &middot; eng</span><span class="hp-cp__mdl">your-specialist.kolm</span><span class="hp-cp__cost">$0.000</span></div>
          </div>
          <div class="hp-cp__pillars"><span class="hp-cp__p on">Capture</span><span class="hp-cp__p">Own</span><span class="hp-cp__p">Run</span><span class="hp-cp__p">Govern</span></div>
        </div>
        <p class="hp-cp__cap">Who asked what, what it cost, what is running where. One dashboard.</p>
      </div>
    </div>
  </div>
</section>

<!-- 02 The valuable data leaving -->
<section class="hp-sec" aria-label="The data leaving your company">
  <div class="hp-wrap">
    <p class="hp-idx"><b>02</b> Why it matters</p>
    <h2 class="hp-h2" style="max-width:26ch;">Your most valuable data is walking out the door.</h2>
    <p class="hp-lede">Every prompt and document your team pastes into ChatGPT or Claude is your real work: your processes, your decisions, your customer knowledge. Right now it trains someone else's model and leaves your control, with no record of what went where. kolm captures that value, keeps it yours, and compounds it into models your company owns.</p>
    <div class="hp-tiles">
      <div class="hp-tile"><h4>No visibility</h4><p>You don't know who uses AI, for what, or how often.</p><span class="fix">kolm shows every call, by person and team.</span></div>
      <div class="hp-tile"><h4>Unknown cost</h4><p>Spend is scattered across personal cards and provider bills no one reconciles.</p><span class="fix">kolm meters cost per team and per model.</span></div>
      <div class="hp-tile"><h4>Data leaking</h4><p>Sensitive customer and company data goes into tools you do not control.</p><span class="fix">kolm redacts it before it leaves, by your rules.</span></div>
      <div class="hp-tile"><h4>No reuse, no record</h4><p>The same work is redone daily, and you cannot prove what happened if asked.</p><span class="fix">kolm turns it into owned models and a signed record.</span></div>
    </div>
  </div>
</section>

<!-- 03 Capture (bedrock) -->
<section class="hp-sec" aria-label="See and control all of it">
  <div class="hp-wrap">
    <p class="hp-idx"><b>03</b> See &amp; control</p>
    <h2 class="hp-h2" style="max-width:24ch;">Connect every tool. See every call.</h2>
    <p class="hp-lede">Point any OpenAI, Anthropic, Gemini, or vLLM client at kolm and nothing changes for your team. Behind the scenes every call is routed, attributed to the person and team who made it, PII-redacted inline, and stored. You finally see cost per team, which prompts get repeated all day, and what touched sensitive data.</p>
    <div class="hp-trip">
      <div class="hp-card"><p class="hp-card__tag">Connect</p><h3>One URL, every provider.</h3><p>Members keep their own tools and keys. kolm routes their traffic and captures the request-and-response pairs worth keeping, in your tenant, not ours.</p><p class="hp-card__m">7 protocols &middot; one endpoint</p></div>
      <div class="hp-card"><p class="hp-card__tag">Attribute</p><h3>Who asked what, and what it cost.</h3><p>Every call is tagged to a member and team, metered, and shown on a live dashboard with a cost rollup. Finance and security finally get a single source of truth.</p><p class="hp-card__m">cost per team &middot; per model</p></div>
      <div class="hp-card"><p class="hp-card__tag">Protect</p><h3>Sensitive data, redacted on the way in.</h3><p>The redaction membrane scrubs PII before it leaves your boundary. You set the rules for what gets caught; every redaction is recorded.</p><p class="hp-card__m">you set the rules</p></div>
    </div>
  </div>
</section>

<!-- 04 Build & own (incl. intense training) -->
<section class="hp-sec" aria-label="Own what you build">
  <div class="hp-wrap">
    <p class="hp-idx"><b>04</b> Own what you build</p>
    <h2 class="hp-h2" style="max-width:24ch;">Turn your team's work into models you own.</h2>
    <p class="hp-lede">kolm finds the work your team repeats most and turns it into a dataset. From there you train a specialist on your own data: a light run distills and quantizes a small model in minutes, or an intense run distills from a council of frontier teachers and fine-tunes on rented cloud GPUs. Either way the model is yours, cheaper to run, and tuned to how your team actually works.</p>
    <div class="hp-2col">
      <div class="hp-card" style="border-left:2px solid var(--hp-c)"><p class="hp-card__tag" style="color:var(--hp-c)">Light path</p><h3>Distill a small model in minutes.</h3><p>Pick a captured task in the browser builder or run one CLI command. kolm distills and quantizes to INT4 and signs a portable .kolm file. No training code, no ML team.</p><p class="hp-card__m">browser builder or one CLI command</p></div>
      <div class="hp-card"><p class="hp-card__tag">Intense path</p><h3>Train a serious model on real GPUs.</h3><p>Need something heavier? Distill from a council of frontier teachers and fine-tune on rented cloud GPUs through the compute broker. You keep the weights, the data, and the receipts.</p><p class="hp-card__m">teacher council &middot; cloud GPU &middot; you own the weights</p></div>
    </div>
    <div class="hp-ctas" style="margin-top:24px;"><a class="hp-btn hp-btn--p" href="/account/create-model">Build a model <span aria-hidden="true">&rarr;</span></a><a class="hp-link" href="/docs/distillation">How training works</a></div>
  </div>
</section>

<!-- 05 Run anywhere / on devices -->
<section class="hp-sec" aria-label="Run it anywhere">
  <div class="hp-wrap">
    <p class="hp-idx"><b>05</b> Run anywhere</p>
    <h2 class="hp-h2" style="max-width:24ch;">Run it on your own machines, not just someone else's cloud.</h2>
    <p class="hp-lede">Some work should never leave the building. kolm shrinks a capable model to run on hardware you already own, so a 7B model runs on a workstation and a 32B model runs on a single high-end GPU. Reach it over a local endpoint, over SSH, or keep using hosted models. You choose per model and per team.</p>
    <div class="hp-trip">
      <div class="hp-card"><p class="hp-card__tag">On your machines</p><h3>Local, VPC, or air-gapped.</h3><p>Export to GGUF, Ollama, or Hugging Face with no proprietary loader, and run where your data already lives. A team shares one stable endpoint to the model it owns.</p><p class="hp-card__m">local &middot; VPC &middot; air-gapped &middot; SSH</p></div>
      <div class="hp-card"><p class="hp-card__tag">Proven on real hardware</p><h3>Big models, one GPU.</h3><p>A 7B specialist ships INT4 in-repo; DeepSeek-R1-32B runs at 17.9 GB INT4 on a single RTX 5090. Real, measured numbers, tied to the hardware they ran on.</p><p class="hp-card__m">DeepSeek-R1-32B &rarr; 17.9 GB INT4 &middot; one 5090</p></div>
      <div class="hp-card"><p class="hp-card__tag">Or stay hosted</p><h3>No forced migration.</h3><p>Keep routing to frontier models through kolm for the work that needs them. Own the routine, rent the frontier; the dashboard and receipts cover both.</p><p class="hp-card__m">own the routine, rent the frontier</p></div>
    </div>
  </div>
</section>

<!-- 06 Govern & prove (proof lives here) -->
<section class="hp-sec" aria-label="Govern and prove">
  <div class="hp-wrap">
    <p class="hp-idx"><b>06</b> Govern &amp; prove</p>
    <h2 class="hp-h2" style="max-width:26ch;">Govern it. Then prove the controls held.</h2>
    <p class="hp-lede">A security questionnaire should not decide which model you ship. SSO, SCIM, and RBAC are the floor. BYOC keeps training and inference inside your boundary, residency spans nine regions, and a signed Ed25519 receipt on every call makes all of it checkable after the fact, by you or an auditor, offline.</p>
    <div class="hp-grid6">
      <div class="hp-cell"><p class="hp-cell__l">SSO / SAML</p><p>Your identity provider decides access.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">SCIM</p><p>Provisioning and deprovisioning, automatic.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">RBAC</p><p>Who can route, build, and export, by role.</p></div>
      <div class="hp-cell hp-cell--byoc"><p class="hp-cell__l">BYOC</p><p>Train and serve in your own VPC. Data never leaves your network.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">Data residency</p><p>Pin training and serving to one of nine regions.</p></div>
      <div class="hp-cell"><p class="hp-cell__l">Signed receipts</p><p>Every call returns a verifiable record. Audit without you in the room.</p></div>
    </div>
    <p class="hp-soc">SOC&nbsp;2 Type&nbsp;I complete &middot; Type&nbsp;II in progress &middot; Apache&#8209;2.0 core</p>
    <div class="hp-ctas" style="margin-top:14px;"><a class="hp-btn hp-btn--p" href="/enterprise">Talk to us about BYOC <span aria-hidden="true">&rarr;</span></a><a class="hp-link" href="/verify">Verify a receipt</a></div>
  </div>
</section>

<!-- 07 Close -->
<section class="hp-sec hp-close" aria-label="Get started">
  <div class="hp-wrap">
    <p class="hp-idx" style="justify-content:center;"><b>07</b> Start</p>
    <h2 class="hp-h2">Get your team's AI under control.</h2>
    <p class="hp-lede">Connect your providers, invite your people, set who can use what, and watch the usage, cost, and risk become visible. Most teams get there in an afternoon. No machine-learning background required.</p>
    <div class="hp-ctas">
      <a class="hp-btn hp-btn--p" href="/account/connect">See your team's AI <span aria-hidden="true">&rarr;</span></a>
      <a class="hp-btn hp-btn--g" href="/book-demo">Book a demo</a>
    </div>
    <p class="hp-trust" style="margin-top:26px;">Apache&#8209;2.0 &middot; Self&#8209;hostable &middot; Air&#8209;gapped &middot; SOC&nbsp;2 Type&nbsp;I &middot; 6 SDKs</p>
    <p style="margin-top:18px;font-size:13px;"><a class="hp-link" href="/pricing">See pricing</a></p>
  </div>
</section>

</div>
`;

const out = html.slice(0, A) + STYLE + BODY + '\n\n' + html.slice(B);
fs.writeFileSync(F, out);
const ed = (out.match(/—/g) || []).length + (out.match(/&mdash;/g) || []).length;
console.log('homepage rebuilt (control-plane): ' + html.split('\n').length + ' -> ' + out.split('\n').length + ' lines; em-dashes(raw+entity): ' + ed);
for (const w of ['wrapper', 'studio', ' surface', 'evidence-to-artifact', 'honesty', 'honest ', 'bill goes to zero']) {
  const n = BODY.toLowerCase().split(w.toLowerCase()).length - 1; if (n) console.log('  BANNED in body: "' + w + '" x' + n);
}
