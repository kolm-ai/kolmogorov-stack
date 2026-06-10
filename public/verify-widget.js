// verify-widget.js - the live, in-page proof for kolm.ai.
//
// It mounts an "exhibit plate" that fetches a REAL signed artifact and runs the
// ACTUAL Ed25519 verification in the visitor's own browser. No upload, no kolm
// server in the path, no shared secret. Every check rendered is the genuine
// result; there are no pre-filled "OK" lines. If a browser lacks native
// Ed25519, the widget says so rather than faking a pass.
//
// Two modes:
//   report  (default for /sample-audit-report.json) - the deliverable. Verifies
//           an Agent Security-Review evidence report with kolm-audit-verify.js
//           (tier 1: signed + untampered) AND issuerProvenance against the
//           published keyring (tier 2: the key is one kolm publishes). Renders
//           the subject, readiness, severities, the embossed seal, the streamed
//           crypto checks, the issuer verdict, and the framework crosswalk.
//   receipt (legacy) - verifies a cost/usage receipt with kolm-verify.js.
//
// The "Tamper a field" button mutates one signed value and re-runs the SAME
// verifier - the signature breaks, the seal fractures to VOID. That is the
// falsifiable claim made physical: altered evidence cannot pass.
//
// Markup contract (kolm-2026.css):
//   <div class="vw" data-verify-widget data-src="/sample-audit-report.json"></div>
// Optional: data-mode="report|receipt", data-keyring="/keys/kolm-issuers.json",
//           data-fields="receipt_id,model,..." (receipt mode only).

import { verifyReceipt } from '/kolm-verify.js';
import { verifyAuditReport, issuerProvenance, canonicalizeReport, keyFingerprintFromPem } from '/kolm-audit-verify.js';

const CHECKMARK = '<svg class="mk" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS = '<svg class="mk" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const RECEIPT_FIELDS = ['receipt_id', 'model', 'provider', 'input_hash', 'output_hash', 'cost_usd', 'signing_key_id'];

let SEAL_SEQ = 0;

// The seal mark - three descending bars in a roundel, with the brand legend set
// as circular micro-type. Graphite when pending, spectral holographic foil when
// verified (the one place colour appears), ash + fracture when void. The foil is
// an SVG gradient (id `${uid}f`); the CSS binds it via --seal-foil only on the
// sealed state, so a graphite/void seal carries no colour at all.
function sealSvg(uid, animate) {
  const shimmer = animate
    ? `<animateTransform attributeName="gradientTransform" type="translate" values="-34 0; 34 0; -34 0" dur="6s" repeatCount="indefinite"/>`
    : '';
  return `<svg viewBox="0 0 128 128">
    <defs>
      <path id="${uid}" d="M64,64 m0,-44 a44,44 0 1,1 0,88 a44,44 0 1,1 0,-88"/>
      <linearGradient id="${uid}f" gradientUnits="userSpaceOnUse" x1="10" y1="14" x2="118" y2="114">
        <stop offset="0" stop-color="#79E8D6"/><stop offset="0.21" stop-color="#74C8FF"/>
        <stop offset="0.43" stop-color="#A99CFF"/><stop offset="0.63" stop-color="#FF9ED6"/>
        <stop offset="0.82" stop-color="#FFCB8E"/><stop offset="1" stop-color="#79E8D6"/>
        ${shimmer}
      </linearGradient>
    </defs>
    <circle class="seal-ring" cx="64" cy="64" r="58" stroke-width="1.4"/>
    <circle class="seal-ring-2" cx="64" cy="64" r="38" stroke-width="1"/>
    <g class="seal-rot"><text class="seal-type"><textPath href="#${uid}" startOffset="0">AGENT SECURITY EVIDENCE · ED25519 · VERIFIED OFFLINE · </textPath></text></g>
    <g class="seal-bars"><rect x="50" y="46" width="6" height="36" rx="0.6"/><rect x="61" y="52" width="6" height="24" rx="0.6"/><rect x="72" y="58" width="6" height="12" rx="0.6"/></g>
    <path class="seal-fracture" d="M40,30 66,68 52,82 92,104"/>
  </svg>`;
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// shorten long hex/sig values so a row reads at a glance but stays truthful.
function shortMid(s, head = 22, tail = 8) {
  s = String(s);
  if (s.length <= head + tail + 1) return esc(s);
  return esc(s.slice(0, head)) + '<span class="vw__el">…</span>' + esc(s.slice(-tail));
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  const last = ks.pop();
  let o = obj;
  for (const k of ks) { if (o == null) return; o = o[k]; }
  if (o != null) o[last] = val;
}

const prefersReduced = () =>
  globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

function sleep(ms) {
  if (prefersReduced()) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// DER (ArrayBuffer) -> PEM, for the forge control's freshly generated key.
function derToPem(der, label) {
  const bytes = new Uint8Array(der);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// signature ArrayBuffer -> base64url (the on-the-wire shape kolm-audit-verify reads).
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class VerifyWidget {
  constructor(root) {
    this.root = root;
    this.src = root.getAttribute('data-src') || '/sample-audit-report.json';
    this.mode = root.getAttribute('data-mode')
      || (/audit-report|asr|report/i.test(this.src) ? 'report' : 'receipt');
    this.keyringSrc = root.getAttribute('data-keyring') || '/keys/kolm-issuers.json';
    this.variant = root.getAttribute('data-variant') || 'compact';
    const f = root.getAttribute('data-fields');
    this.fields = f ? f.split(',').map((s) => s.trim()).filter(Boolean) : RECEIPT_FIELDS;
    this.tamperPath = this.mode === 'report' ? 'summary.readiness_pct' : null;
    this.original = null;   // pristine artifact (ground truth)
    this.current = null;    // what we verify (may be tampered)
    this.keyring = null;
    this.tampered = false;
    this.forgery = false;   // re-signed with a rogue (off-keyring) key
    this.forged = null;     // cached forged artifact (built once)
    this.busy = false;
    this.seal = null;
    this._build();
    this._load();
  }

  _build() {
    this.root.innerHTML = '';
    this.root.classList.add('vw');
    // 'is-live' arms the check-row entrance animation; without the script the
    // CSS keeps rows fully visible (fail-open).
    this.root.classList.add('is-live');

    const bar = el('div', 'vw__bar');
    bar.append(
      el('span', 'vw__dot'), el('span', 'vw__dot'), el('span', 'vw__dot'),
      el('span', 'vw__title', 'kolm verify · offline'),
    );
    this.status = el('span', 'vw__status', 'loading…');
    this.status.setAttribute('role', 'status');
    bar.append(this.status);
    this.root.append(bar);

    const body = el('div', 'vw__body');
    this.headEl = el('div');     // report-mode header (seal + subject + score)
    this.sevEl = el('div', 'vw__sev');
    this.fieldsEl = el('div', 'vw__fields');
    this.checksEl = el('div', 'vw__checks');
    this.provEl = el('div');     // report-mode tier-2 provenance
    this.fwEl = el('div', 'vw__fw');
    this.actions = el('div', 'vw__actions');

    this.tamperBtn = el('button', 'btn btn--ghost btn--sm vw__attack', this.mode === 'report' ? 'Inflate the score' : 'Tamper a field');
    this.tamperBtn.type = 'button';
    this.tamperBtn.addEventListener('click', () => this._toggleTamper());

    // The forge control is the live tier-2 proof: re-sign the SAME report with a
    // freshly minted key that is NOT in the keyring. Only offered on the full
    // (verify-page) variant, and only where the browser can actually keygen+sign.
    this.forgeBtn = null;
    if (this.mode === 'report' && this.variant === 'full' && this._forgeSupported()) {
      this.forgeBtn = el('button', 'btn btn--ghost btn--sm vw__attack', 'Forge with a rogue key');
      this.forgeBtn.type = 'button';
      this.forgeBtn.addEventListener('click', () => this._toggleForge());
    }

    this.reverifyBtn = el('button', 'btn btn--ghost btn--sm', 'Re-verify');
    this.reverifyBtn.type = 'button';
    this.reverifyBtn.addEventListener('click', () => this._run());

    this.actions.append(this.tamperBtn);
    if (this.forgeBtn) this.actions.append(this.forgeBtn);
    this.actions.append(this.reverifyBtn);
    // The attack drills ARE the demo; name the row so nobody mistakes the
    // buttons for chrome. Every attack is reversible (Restore labels).
    this.actionsK = el('p', 'vw__actions-k', 'Try to break it');
    body.append(this.headEl, this.sevEl, this.fieldsEl, this.checksEl, this.provEl, this.fwEl, this.actionsK, this.actions);
    this.root.append(body);
  }

  async _load() {
    try {
      const r = await fetch(this.src, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      this.original = await r.json();
    } catch (e) {
      this._setStatus('load failed', 'bad');
      this.fieldsEl.innerHTML = `<div class="vw__row"><span class="vw__key">error</span><span class="vw__val is-changed">could not fetch ${esc(this.src)}: ${esc(e.message)}</span></div>`;
      this.tamperBtn.disabled = true;
      this.reverifyBtn.disabled = true;
      return;
    }
    if (this.mode === 'report') {
      try {
        const kr = await fetch(this.keyringSrc, { cache: 'no-store' });
        if (kr.ok) this.keyring = await kr.json();
      } catch (_) { /* tier 2 is best-effort; absence just reads as "issuer unverified" */ }
    }
    this.current = JSON.parse(JSON.stringify(this.original));
    this._render();
    this._run();
  }

  _setStatus(text, kind) {
    this.status.textContent = text;
    this.status.classList.remove('is-ok', 'is-bad');
    if (kind === 'ok') this.status.classList.add('is-ok');
    if (kind === 'bad') this.status.classList.add('is-bad');
  }

  _setSeal(state) {
    if (!this.seal) return;
    this.seal.className = 'seal';
    void this.seal.offsetWidth;            // reflow so the press/fracture re-runs
    this.seal.classList.add(state);        // is-sealed | is-void | is-pending
  }

  _render() {
    if (this.mode === 'report') this._renderReport();
    else this._renderReceipt();
  }

  // ---------------- report mode ----------------
  _renderReport() {
    const rep = this.current;
    const subj = rep.subject || {};
    const sum = rep.summary || {};
    const pct = sum.readiness_pct == null ? 'n/a' : sum.readiness_pct;

    this.headEl.className = 'vw__head';
    this.headEl.innerHTML = '';
    const sealWrap = el('span', 'seal is-pending');
    sealWrap.setAttribute('aria-hidden', 'true');
    const uid = 'vwSeal' + (++SEAL_SEQ);
    sealWrap.innerHTML = sealSvg(uid, !prefersReduced());
    sealWrap.style.setProperty('--seal-foil', `url(#${uid}f)`);
    this.seal = sealWrap;

    const idBlock = el('div', 'vw__id');
    idBlock.append(
      el('div', 'vw__subject', esc(subj.name || 'Evidence report')),
      el('div', 'vw__sub', `${esc(rep.report_id || 'asrr')} · ${esc(subj.source || 'source')} · ${esc(String(subj.records ?? '?'))} records`),
    );
    const score = el('div', 'vw__score');
    // The readiness number lands WITH the verdict (_runReport), never before it:
    // a number over a "verifying" chip reads as a result preceding its proof.
    this.scoreB = el('b', this.tampered ? 'is-changed' : null, '·%');
    this.scorePct = esc(String(pct)) + '%';
    score.append(this.scoreB, el('span', null, 'readiness'));

    this.headEl.append(sealWrap, idBlock, score);

    // severity chips
    const bs = sum.by_severity || {};
    this.sevEl.innerHTML = '';
    const chips = [
      [`${sum.total_findings ?? 0} findings`, false],
      [`${bs.high || 0} high`, (bs.high || 0) > 0],
      [`${bs.low || 0} low`, false],
      [`tamper-evident: ${sum.tamper_evident ? 'yes' : 'no'}`, false],
    ];
    for (const [txt, hot] of chips) this.sevEl.append(el('span', 'vw__chip' + (hot ? ' is-high' : ''), esc(txt)));

    this.fieldsEl.innerHTML = '';  // not used in report mode
  }

  // ---------------- receipt mode ----------------
  _renderReceipt() {
    this.headEl.className = '';
    this.headEl.innerHTML = '';
    this.sevEl.innerHTML = '';
    this.seal = null;
    this.fieldsEl.innerHTML = '';
    for (const k of this.fields) {
      if (!(k in this.current)) continue;
      const row = el('div', 'vw__row');
      row.append(el('span', 'vw__key', esc(k)));
      const val = el('span', 'vw__val', shortMid(this.current[k]));
      val.dataset.field = k;
      if (this.tampered && k === this._receiptTamperField) val.classList.add('is-changed');
      row.append(val);
      this.fieldsEl.append(row);
    }
  }

  get _receiptTamperField() {
    for (const k of ['output_hash', 'input_hash', 'model', 'cost_usd', 'receipt_id']) {
      if (this.fields.includes(k) && k in this.original) return k;
    }
    return this.fields.find((k) => k in this.original);
  }

  _toggleTamper() {
    if (this.busy) return;
    // forge and tamper are mutually exclusive - leaving forge resets its label.
    if (this.forgery) { this.forgery = false; if (this.forgeBtn) this.forgeBtn.textContent = 'Forge with a rogue key'; }
    this.tampered = !this.tampered;
    this.current = JSON.parse(JSON.stringify(this.original));

    if (this.tampered) {
      if (this.mode === 'report') {
        // raise the readiness score - the classic "just say it's fine" forgery.
        const cur = getPath(this.current, this.tamperPath);
        const next = (typeof cur === 'number' && cur < 92) ? 92 : 100;
        setPath(this.current, this.tamperPath, next);
      } else {
        const k = this._receiptTamperField;
        const v = this.current[k];
        if (typeof v === 'string') {
          const hit = v.match(/[0-9a-f]/i);
          if (hit) {
            const i = v.indexOf(hit[0]);
            const repl = hit[0].toLowerCase() === 'a' ? 'b' : 'a';
            this.current[k] = v.slice(0, i) + repl + v.slice(i + 1);
          } else { this.current[k] = v + '*'; }
        } else if (typeof v === 'number') { this.current[k] = v + 1; }
        else { this.current[k] = 'tampered'; }
      }
      this.tamperBtn.textContent = 'Restore original';
    } else {
      this.tamperBtn.textContent = this.mode === 'report' ? 'Inflate the score' : 'Tamper a field';
    }
    this._render();
    this._run();
  }

  _resetChecks() { this.checksEl.innerHTML = ''; }

  _addCheck(check) {
    const row = el('div', 'vw__check ' + (check.ok ? 'ok' : 'bad'));
    row.innerHTML = (check.ok ? CHECKMARK : CROSS) +
      `<span>${esc(check.name)}${check.detail ? ` · <span class="vw__detail">${esc(String(check.detail))}</span>` : ''}</span>`;
    this.checksEl.append(row);
    void row.offsetWidth;
    requestAnimationFrame(() => row.classList.add('show'));
    return row;
  }

  async _run() {
    if (this.busy || !this.current) return;
    this.busy = true;
    this.tamperBtn.disabled = true;
    if (this.forgeBtn) this.forgeBtn.disabled = true;
    this.reverifyBtn.disabled = true;
    this._resetChecks();
    this.provEl.innerHTML = '';
    this.fwEl.innerHTML = '';
    this._setStatus('verifying…', null);
    this._setSeal('is-pending');
    // while verifying, the number is withheld (re-verify path skips _render).
    if (this.mode === 'report' && this.scoreB) this.scoreB.textContent = '·%';

    if (this.mode === 'report') await this._runReport();
    else await this._runReceipt();

    this.busy = false;
    this.tamperBtn.disabled = false;
    if (this.forgeBtn) this.forgeBtn.disabled = false;
    this.reverifyBtn.disabled = false;
  }

  _forgeSupported() {
    return !!(globalThis.crypto && crypto.subtle
      && typeof crypto.subtle.generateKey === 'function'
      && typeof crypto.subtle.exportKey === 'function'
      && typeof crypto.subtle.sign === 'function');
  }

  // Re-sign the SAME report payload with a freshly generated key that is NOT in
  // the keyring. Tier 1 (signature) still passes; tier 2 (issuer) fails. This is
  // the falsifiable proof made physical: a rogue signer cannot forge kolm-issued
  // evidence, because the buyer pins the issuer key, not just the signature.
  async _buildForgedReport() {
    const forged = JSON.parse(JSON.stringify(this.original));
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const pem = derToPem(spki, 'PUBLIC KEY');
    const fp = await keyFingerprintFromPem(pem);
    const block = (forged.signature_ed25519 && typeof forged.signature_ed25519 === 'object')
      ? forged.signature_ed25519 : {};
    block.spec = block.spec || 'kolm-ed25519-v1';
    block.alg = 'ed25519';
    block.public_key = pem;
    block.key_fingerprint = fp;
    block.signed_at = forged.generated_at || block.signed_at;
    forged.signature_ed25519 = block;
    // canonicalizeReport excludes the signature block, so the signed bytes are the
    // genuine report's bytes - only the signer (and thus the issuer) is rogue.
    const canonical = canonicalizeReport(forged);
    const sig = await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(canonical));
    block.signature = bufToBase64Url(sig);
    return forged;
  }

  async _toggleForge() {
    if (this.busy || !this.original) return;
    // forge and tamper are mutually exclusive - restore the tamper label.
    this.tampered = false;
    this.tamperBtn.textContent = this.mode === 'report' ? 'Inflate the score' : 'Tamper a field';

    if (this.forgery) {
      this.forgery = false;
      this.forgeBtn.textContent = 'Forge with a rogue key';
      this.current = JSON.parse(JSON.stringify(this.original));
      this._render(); this._run();
      return;
    }
    this.forgeBtn.disabled = true;
    this.forgeBtn.textContent = 'Forging…';
    try {
      if (!this.forged) this.forged = await this._buildForgedReport();
      this.current = JSON.parse(JSON.stringify(this.forged));
      this.forgery = true;
      this.forgeBtn.textContent = 'Restore genuine';
    } catch (e) {
      this.forgeBtn.textContent = 'Forge with a rogue key';
      this._setStatus('forge unsupported here', 'bad');
    }
    this.forgeBtn.disabled = false;
    this._render(); this._run();
  }

  async _runReport() {
    let result;
    try { result = await verifyAuditReport(this.current); }
    catch (e) { result = { ok: false, reason: 'verifier error: ' + e.message, checks: [] }; }

    // sleep BETWEEN checks only - after the last check lands, the seal and the
    // status chip must flip in the same frame, never linger on "verifying".
    for (let i = 0; i < result.checks.length; i++) { if (i) await sleep(190); this._addCheck(result.checks[i]); }
    if (result.reason && !result.ok) this._addCheck({ name: result.reason, ok: false, detail: '' });

    // tier 2: is the embedded key one kolm publishes?
    const prov = issuerProvenance(this.current, this.keyring || { issuers: [] });

    // the readiness number and the verdict land in the same frame as the last check.
    if (this.scoreB) this.scoreB.textContent = this.scorePct;

    if (result.ok) {
      this._setSeal('is-sealed');
      if (prov.recognized && prov.status === 'production') {
        this._setStatus('Verified · production', 'ok');
      } else if (prov.recognized) {
        this._setStatus('Verified · ' + (prov.status || 'known issuer'), 'ok');
      } else {
        // valid signature, untrusted key - the seal is green, but the status is
        // deliberately neutral, not a pass: tier 2 has not been satisfied.
        this._setStatus('Signed · issuer unknown', null);
      }
    } else {
      this._setSeal('is-void');
      this._setStatus('VOID · rejected', 'bad');
    }

    // provenance line
    let provHtml, provBad = false;
    if (!result.ok) {
      provHtml = 'Issuer not evaluated. The signature did not verify, so this evidence is <b>rejected</b>.';
      provBad = true;
    } else if (prov.recognized && prov.status === 'production') {
      provHtml = `Issuer: <b>${esc(prov.label || 'kolm production issuer')}</b>. Recognized as kolm-issued production evidence.`;
    } else if (prov.recognized) {
      provHtml = `Issuer: <b>${esc(prov.label || 'kolm issuer')}</b>. Recognized ${esc(prov.status || '')} key. A published sample, not production evidence.`;
    } else {
      provHtml = 'Issuer: <b>not in kolm’s keyring</b>. The signature is valid, but the key is not one kolm publishes. Treat as self-issued.';
      provBad = true;
    }
    this.provEl.className = 'vw__prov' + (provBad ? ' is-bad' : '');
    this.provEl.innerHTML = provHtml;

    // framework crosswalk chips
    const fws = Array.isArray(this.current.frameworks) ? this.current.frameworks : [];
    for (const f of fws) {
      const hot = f.worst_severity === 'high' || f.worst_severity === 'critical';
      this.fwEl.append(el('span', 'vw__chip' + (hot ? ' is-high' : ''),
        `${esc(f.framework)} · ${esc(String(f.findings ?? f.controls_touched ?? 0))}`));
    }
  }

  async _runReceipt() {
    let result;
    try { result = await verifyReceipt(this.current); }
    catch (e) { result = { ok: false, reason: 'verifier error: ' + e.message, checks: [] }; }

    // sleep between checks only (see _runReport) so the verdict lands with the last row.
    for (let i = 0; i < result.checks.length; i++) { if (i) await sleep(220); this._addCheck(result.checks[i]); }
    if (result.reason && !result.ok) this._addCheck({ name: result.reason, ok: false, detail: '' });

    if (result.ok) this._setStatus('Verified offline', 'ok');
    else this._setStatus(this.tampered ? 'Tampered · rejected' : 'Not verified', 'bad');
  }
}

function init() {
  const nodes = document.querySelectorAll('[data-verify-widget]');
  nodes.forEach((n) => {
    if (n.__kolmVW) return;
    n.__kolmVW = new VerifyWidget(n);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { VerifyWidget, init };
