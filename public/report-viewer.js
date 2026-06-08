// report-viewer.js - a 100%-browser, dependency-free viewer for a kolm Agent
// Security-Review evidence report.
//
// It LOADS a signed report (from ?src=<trust-url>, a paste, a URL field, or a
// dropped .json file), VERIFIES its Ed25519 signature offline by reusing the
// published verifier (/kolm-audit-verify.js - no crypto is reimplemented here),
// resolves the signing key against kolm's issuer keyring, and then RENDERS the
// report the way the reviewer reads it:
//
//   - an executive verdict header (readiness, red-team score, blocking count,
//     tamper-evident, the cryptographic verdict, and the signing issuer),
//   - an interactive control graph (inline SVG, no libraries: framework controls
//     as leaves coloured by their worst mapped finding, click to drill in),
//   - the framework crosswalk,
//   - the red-team resistance battery, and
//   - a visual diff between two reports (improved / regressed / resolved / new).
//
// Everything runs in this browser. There is no kolm server in the trust path.

import {
  verifyAuditReport,
  issuerProvenance,
  AUDIT_REPORT_SCHEMA,
} from '/kolm-audit-verify.js';

// kolm's published issuer keyring, INLINED as the offline anchor (view-source it).
// We also merge /keys/kolm-issuers.json when the network is reachable, but the
// inlined copy is what an offline reviewer resolves against. Mirrors verify.html.
const KOLM_ISSUERS = {
  schema: 'kolm-issuer-keyring-1',
  issuers: [
    { kid: 'kolm-demo-2026', label: 'kolm demo issuer', status: 'demo', public_key: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAcNW1vj5BUnzmEjH6iAdKM2p5of35Oe6znRifqpuLF7A=\n-----END PUBLIC KEY-----\n' },
    { kid: 'kolm-prod-2026', label: 'kolm production issuer', status: 'production', public_key: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAI1W4RkabFYhAOfk3DB+hE3CZWexFJE/7KFZ3X2G1+bk=\n-----END PUBLIC KEY-----\n' },
  ],
};
async function refreshKeyring() {
  try {
    const r = await fetch('/keys/kolm-issuers.json', { cache: 'no-store' });
    if (!r.ok) return;
    const fresh = await r.json();
    if (!fresh || !Array.isArray(fresh.issuers)) return;
    const byKid = new Map(KOLM_ISSUERS.issuers.map((i) => [i.kid, i]));
    for (const i of fresh.issuers) { if (i && i.public_key) byKid.set(i.kid || i.fingerprint || i.public_key, i); }
    KOLM_ISSUERS.issuers = Array.from(byKid.values());
  } catch (_) { /* offline: keep the inlined anchor */ }
}
refreshKeyring();

// --- small DOM + format helpers ---------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escA = (s) => esc(s).replace(/'/g, '&#39;');
const isReport = (o) => !!(o && typeof o === 'object' && o.schema === AUDIT_REPORT_SCHEMA);

const SEV_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const SEV_HEX = { critical: '#8C3A2E', high: '#C2603A', medium: '#B5852A', low: '#565C57', info: '#11875A', none: '#8A908B' };
const STATUS_HEX = { pass: '#11875A', attention: '#B5852A', blocking: '#8C3A2E' };
const FW_SHORT = {
  'EU AI Act': 'EU AI Act',
  'OWASP LLM & Agentic Top 10': 'OWASP',
  'MITRE ATLAS': 'ATLAS',
  'NIST AI RMF': 'NIST',
  'SOC 2 TSC': 'SOC 2',
  'ISO/IEC 42001': 'ISO 42001',
  ASR: 'ASR',
};
const shortFw = (f) => FW_SHORT[f] || String(f || '').split(/\s+/).slice(0, 2).join(' ');

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('is-ok', 'is-bad');
  if (kind) el.classList.add(kind === 'ok' ? 'is-ok' : 'is-bad');
}

// Verification state for the currently loaded reports, so the diff can show it.
const state = { A: null, B: null, model: null };

// ============================================================================
// VERIFY + RENDER report A.
// ============================================================================
async function openReport(report) {
  if (!isReport(report)) {
    setStatus($('statusA'), 'not a kolm report', 'bad');
    return;
  }
  setStatus($('statusA'), 'verifying...', null);

  let verify;
  try { verify = await verifyAuditReport(report); }
  catch (e) { verify = { ok: false, reason: 'verifier error: ' + e.message, checks: [] }; }
  const prov = issuerProvenance(report, KOLM_ISSUERS);
  state.A = { report, verify, prov };

  renderSummary(report, verify, prov);
  renderGraph(report);
  renderCrosswalk(report);
  renderProbes(report);

  $('rvReport').classList.remove('hidden');
  setStatus($('statusA'), verify.ok ? (prov.recognized ? 'verified · kolm issuer' : 'signature intact') : 'NOT verified', verify.ok ? 'ok' : 'bad');
  $('rvReport').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- executive verdict header -----------------------------------------------
function band(n) { return n == null ? 'none' : (n >= 80 ? 'ok' : (n >= 40 ? 'warn' : 'bad')); }

function renderSummary(report, verify, prov) {
  const s = report.summary || {};
  const rt = report.red_team && typeof report.red_team === 'object' ? report.red_team : null;
  const sig = report.signature_ed25519 || {};
  const readiness = s.readiness_pct == null ? 'n/a' : s.readiness_pct + '%';
  const rtScore = rt ? (rt.score == null ? 'n/a' : rt.score + '/100') : 'n/a';

  let sealClass = 'bad';
  let sealText = 'VOID';
  let note = '';
  if (verify.ok && prov.recognized) {
    sealClass = 'ok';
    sealText = prov.status === 'production' ? 'VERIFIED · KOLM ISSUER' : 'VERIFIED · ' + String(prov.status || 'kolm').toUpperCase() + ' ISSUER';
  } else if (verify.ok) {
    sealClass = 'ok';
    sealText = 'SIGNATURE INTACT';
    note = 'The signature is intact, but the embedded key is not in kolm’s published keyring, so this is not resolved as a kolm-issued report.';
  } else {
    sealClass = 'bad';
    sealText = 'VOID · ' + (verify.reason || 'signature did not verify');
  }

  const issuerLine = prov.recognized
    ? `${esc(prov.label || prov.kid || 'kolm')} (${esc(prov.status || 'issuer')})`
    : 'not a recognized kolm issuer key';
  const wm = report.watermark === true ? ' · <b style="color:var(--void)">UNPAID PREVIEW</b>' : '';

  $('rvSummary').innerHTML = `
    <div class="rv__vtop">
      <span class="rv__seal ${sealClass}">${esc(sealText)}</span>
      <div>
        <p class="rv__subject">${esc(report.subject ? report.subject.name : 'Agent fleet')}</p>
        <div class="muted mono" style="font-size:12px">generated ${esc(report.generated_at || '')}${wm}</div>
      </div>
      <div class="rv__meta">${esc(report.report_id || '')}<br>${esc(report.report_version || '')} · ${esc(report.spec_version || '')}</div>
    </div>
    <div class="rv__stats">
      <div class="rv__stat"><div class="big ${band(s.readiness_pct)}">${esc(readiness)}</div><div class="lab">Readiness (assessed controls)</div></div>
      <div class="rv__stat"><div class="big ${band(rt ? rt.score : null)}">${esc(rtScore)}</div><div class="lab">Red-team resistance</div></div>
      <div class="rv__stat"><div class="big ${(s.blocking_count || 0) > 0 ? 'bad' : 'ok'}">${esc(s.blocking_count ?? 0)}</div><div class="lab">Deal-blocking findings</div></div>
      <div class="rv__stat"><div class="big ${s.tamper_evident ? 'ok' : 'bad'}">${s.tamper_evident ? 'Yes' : 'No'}</div><div class="lab">Tamper-evident trail</div></div>
    </div>
    <div class="rv__sig">
      <div><span class="k">verdict:</span> ${verify.ok ? 'Ed25519 signature valid, untampered since signing' : esc(verify.reason || 'signature does not verify')}</div>
      <div><span class="k">issuer:</span> ${issuerLine}</div>
      <div><span class="k">key fingerprint:</span> ${esc(sig.key_fingerprint || 'n/a')}</div>
      <div><span class="k">algorithm:</span> ${esc(sig.alg || '?')} (${esc(sig.spec || '?')}) · signed ${esc(sig.signed_at || 'n/a')}</div>
      ${note ? `<div class="muted" style="margin-top:4px">${esc(note)}</div>` : ''}
    </div>`;
}

// --- interactive control graph (inline SVG, no libraries) -------------------
function buildGraph(report) {
  const W = 920, H = 560, CX = 460, CY = 280;
  const nodes = [], edges = [];
  const subj = report.subject ? report.subject.name : 'Agent fleet';
  nodes.push({ id: 'center', type: 'center', x: CX, y: CY, r: 34, color: '#0E1310', label: subj.length > 16 ? subj.slice(0, 15) + '…' : subj, data: { kind: 'subject', report } });

  const fws = Array.isArray(report.frameworks) ? report.frameworks : [];
  if (fws.length) {
    const N = fws.length, R1 = 150, R2 = 268;
    fws.forEach((fw, i) => {
      const ang = (-90 + i * (360 / N)) * Math.PI / 180;
      const hx = CX + R1 * Math.cos(ang), hy = CY + R1 * Math.sin(ang);
      nodes.push({ id: 'fw' + i, type: 'hub', x: hx, y: hy, r: 14, color: SEV_HEX[fw.worst_severity] || SEV_HEX.none, label: shortFw(fw.framework), data: { kind: 'framework', fw } });
      edges.push({ x1: CX, y1: CY, x2: hx, y2: hy });
      const ctrls = fw.controls || [], k = ctrls.length;
      const win = (2 * Math.PI / N) * 0.78;
      ctrls.forEach((c, j) => {
        const a2 = k > 1 ? ang + (j - (k - 1) / 2) * (win / (k - 1)) : ang;
        const lx = CX + R2 * Math.cos(a2), ly = CY + R2 * Math.sin(a2);
        const r = Math.max(6, Math.min(13, 6 + (c.findings || 0) * 2));
        nodes.push({ id: 'fw' + i + 'c' + j, type: 'leaf', x: lx, y: ly, r, color: SEV_HEX[c.max_severity] || SEV_HEX.none, label: c.id, data: { kind: 'control', fw, c } });
        edges.push({ x1: hx, y1: hy, x2: lx, y2: ly });
      });
    });
  } else {
    // Clean report: no framework controls were implicated. Show the ASR ring
    // (status-coloured) so the graph still reads, rather than an empty canvas.
    const ctrls = (report.summary && report.summary.controls) || [];
    const N = Math.max(ctrls.length, 1), R1 = 190;
    ctrls.forEach((c, i) => {
      const ang = (-90 + i * (360 / N)) * Math.PI / 180;
      const x = CX + R1 * Math.cos(ang), y = CY + R1 * Math.sin(ang);
      nodes.push({ id: 'asr' + i, type: 'hub', x, y, r: 17, color: STATUS_HEX[c.status] || SEV_HEX.none, label: c.id, data: { kind: 'asr', c } });
      edges.push({ x1: CX, y1: CY, x2: x, y2: y });
    });
  }
  return { W, H, nodes, edges };
}

function renderGraph(report) {
  const model = buildGraph(report);
  state.model = model;
  const edges = model.edges.map((e) => `<line class="edge" x1="${e.x1.toFixed(1)}" y1="${e.y1.toFixed(1)}" x2="${e.x2.toFixed(1)}" y2="${e.y2.toFixed(1)}"/>`).join('');
  const nodes = model.nodes.map((n) => {
    const cls = 'node ' + n.type;
    const labelY = n.type === 'center' ? n.y + 4 : n.y + n.r + 11;
    const inside = n.type === 'center';
    return `<g class="${cls}" data-id="${escA(n.id)}" tabindex="0" role="button" aria-label="${escA(n.label)}">
      <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" style="fill:${n.color}"/>
      <text x="${n.x.toFixed(1)}" y="${(inside ? labelY : labelY).toFixed(1)}" text-anchor="middle">${esc(n.label)}</text>
    </g>`;
  }).join('');
  $('rvGraph').innerHTML = `<svg class="rv__graph" viewBox="0 0 ${model.W} ${model.H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Control graph">${edges}${nodes}</svg>`;

  // legend
  $('rvLegend').innerHTML = ['critical', 'high', 'medium', 'low', 'info'].map((sv) =>
    `<span><i style="background:${SEV_HEX[sv]}"></i>${sv === 'info' ? 'clear' : sv}</span>`).join('');

  // interactivity: click / keyboard selects a node and renders its detail.
  const svg = $('rvGraph').querySelector('svg');
  const select = (id) => {
    svg.querySelectorAll('.node.sel').forEach((g) => g.classList.remove('sel'));
    const g = svg.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
    if (g) g.classList.add('sel');
    const node = model.nodes.find((n) => n.id === id);
    if (node) renderDetail(node, report);
  };
  svg.querySelectorAll('.node').forEach((g) => {
    g.addEventListener('click', () => select(g.dataset.id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(g.dataset.id); } });
  });
  // expose for crosswalk cross-selection
  state.selectNode = select;
}

function findingsForControl(report, framework, id) {
  const tag = `${framework} ${id}`;
  return (report.findings || []).filter((f) => Array.isArray(f.frameworks) && f.frameworks.includes(tag));
}

function renderDetail(node, report) {
  const d = node.data || {};
  const box = $('rvDetail');
  if (d.kind === 'subject') {
    const s = report.summary || {};
    box.innerHTML = `<h4>${esc(report.subject ? report.subject.name : 'Agent fleet')}</h4>
      <div class="cid">${esc(report.report_id || '')}</div>
      <p style="font-size:13px;margin:var(--s3) 0 0">${esc(s.total_findings ?? 0)} findings across ${esc((report.frameworks || []).length)} frameworks. Readiness ${esc(s.readiness_pct == null ? 'n/a' : s.readiness_pct + '%')}, ${esc(s.blocking_count ?? 0)} deal-blocking. Click any leaf node to inspect a single control.</p>`;
    return;
  }
  if (d.kind === 'framework') {
    const fw = d.fw;
    box.innerHTML = `<h4>${esc(fw.framework)}</h4>
      <div class="cid">${esc(fw.controls_touched)} controls touched · ${esc(fw.findings)} findings · worst ${esc(fw.worst_severity)}</div>
      <ul class="findlist">${(fw.controls || []).map((c) => `<li style="border-left-color:${SEV_HEX[c.max_severity] || SEV_HEX.none}"><b class="mono">${esc(c.id)}</b> ${esc(c.label)} <span class="muted">(${esc(c.findings)})</span></li>`).join('')}</ul>`;
    return;
  }
  if (d.kind === 'asr') {
    const c = d.c;
    box.innerHTML = `<h4>${esc(c.id)} · ${esc(c.name)}</h4>
      <div class="cid">status ${esc(c.status)} · ${esc(c.findings)} findings</div>
      <p style="font-size:13px;margin:var(--s3) 0 0" class="muted">This control was assessed by the deterministic trinity. A pass means no over-permission, shared credential, or audit-trail gap was observed for it.</p>`;
    return;
  }
  // control leaf
  const fw = d.fw, c = d.c;
  const finds = findingsForControl(report, fw.framework, c.id);
  box.innerHTML = `<h4>${esc(c.id)}</h4>
    <div class="cid">${esc(fw.framework)} · ${esc(c.label)}</div>
    <div style="margin-top:6px;font-size:13px"><span class="chip" style="background:${SEV_HEX[c.max_severity] || SEV_HEX.none}">${esc((c.max_severity || 'info').toUpperCase())}</span> ${esc(c.findings)} finding(s) map here</div>
    <ul class="findlist">${finds.length ? finds.map((f) => `<li style="border-left-color:${SEV_HEX[f.severity] || SEV_HEX.none}"><b>${esc(f.title)}</b>${f.asr ? ` <span class="muted mono">${esc(f.asr.id)}</span>` : ''}</li>`).join('') : '<li class="muted">No finding detail carried for this control in the envelope.</li>'}</ul>`;
}

// --- framework crosswalk -----------------------------------------------------
function renderCrosswalk(report) {
  const fws = report.frameworks || [];
  if (!fws.length) {
    $('rvCross').innerHTML = '<p class="muted" style="font-size:13.5px">No framework controls were implicated. A clean report maps to no findings.</p>';
    return;
  }
  $('rvCross').innerHTML = fws.map((fw, i) => `
    <div class="fwcard">
      <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${SEV_HEX[fw.worst_severity] || SEV_HEX.none}"></span>${esc(fw.framework)}</h4>
      ${(fw.controls || []).map((c, j) => `<div class="ctrl" data-fw="fw${i}c${j}" role="button" tabindex="0">
        <span class="dot" style="background:${SEV_HEX[c.max_severity] || SEV_HEX.none}"></span>
        <span class="id">${esc(c.id)}</span>
        <span>${esc(c.label)}</span>
        <span class="muted" style="margin-left:auto;font-family:var(--mono);font-size:12px">${esc(c.findings)}</span>
      </div>`).join('')}
    </div>`).join('');
  // cross-select the graph node when a crosswalk control is clicked.
  $('rvCross').querySelectorAll('.ctrl[data-fw]').forEach((el) => {
    const go = () => { if (state.selectNode) { state.selectNode(el.dataset.fw); $('rvGraph').scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// --- red-team battery --------------------------------------------------------
function renderProbes(report) {
  const rt = report.red_team && typeof report.red_team === 'object' ? report.red_team : null;
  const panel = $('rvProbesPanel');
  if (!rt) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const sum = rt.summary || {};
  const score = rt.score == null ? 'n/a' : rt.score + '/100';
  $('rvProbesTitle').textContent = `Red-team resistance: ${score}`;
  const head = `<p class="muted" style="font-size:13.5px;margin:0 0 var(--s3)">${esc(rt.domain || 'generic')} suite · ${esc(sum.resisted ?? 0)} resisted, ${esc(sum.exposed ?? 0)} exposed, ${esc(sum.untested ?? 0)} untested of ${esc(sum.probes_total ?? 0)} probes.</p>`;
  const probes = (rt.probes || []).map((p) => `
    <div class="probe s-${esc(p.status)}">
      <div class="probe__head">
        <span class="probe__title">${esc(p.title || p.id)}</span>
        <span class="probe__cat">${esc(p.category || '')} · ${esc((p.severity || '').toUpperCase())}</span>
        <span class="probe__st s-${esc(p.status)}">${esc((p.status || '').toUpperCase())}</span>
      </div>
      ${p.detail ? `<p class="probe__detail">${esc(p.detail)}</p>` : ''}
      <div class="probe__fw">${esc((p.frameworks || []).join(' · '))}</div>
    </div>`).join('');
  $('rvProbes').innerHTML = head + probes;
}

// ============================================================================
// DIFF: A against B.
// ============================================================================
function keyOf(f) { return (f.id || '') + '|' + (f.title || ''); }

function diffReports(a, b) {
  const sa = a.summary || {}, sb = b.summary || {};
  const fa = new Map((a.findings || []).map((f) => [keyOf(f), f]));
  const fb = new Map((b.findings || []).map((f) => [keyOf(f), f]));

  const resolved = [], added = [], regressed = [], improved = [], unchanged = [];
  for (const [k, f] of fa) {
    if (!fb.has(k)) resolved.push(f);
    else {
      const g = fb.get(k);
      const da = SEV_RANK[f.severity] ?? 0, db = SEV_RANK[g.severity] ?? 0;
      if (db > da) regressed.push({ from: f, to: g });
      else if (db < da) improved.push({ from: f, to: g });
      else unchanged.push(f);
    }
  }
  for (const [k, g] of fb) if (!fa.has(k)) added.push(g);

  // control status changes by id
  const ca = new Map((sa.controls || []).map((c) => [c.id, c]));
  const ctrlChanges = [];
  for (const c of (sb.controls || [])) {
    const prev = ca.get(c.id);
    if (prev && prev.status !== c.status) ctrlChanges.push({ id: c.id, name: c.name, from: prev.status, to: c.status });
  }

  const rta = a.red_team && a.red_team.score != null ? a.red_team.score : null;
  const rtb = b.red_team && b.red_team.score != null ? b.red_team.score : null;

  return {
    readiness: { a: sa.readiness_pct, b: sb.readiness_pct },
    redteam: { a: rta, b: rtb },
    blocking: { a: sa.blocking_count ?? 0, b: sb.blocking_count ?? 0 },
    resolved, added, regressed, improved, unchanged, ctrlChanges,
  };
}

function deltaCard(label, av, bv, betterIsHigher, suffix) {
  const a = av == null ? null : av, b = bv == null ? null : bv;
  const d = (a == null || b == null) ? null : b - a;
  const arrow = d == null ? '' : (d > 0 ? '↑' : (d < 0 ? '↓' : ''));
  const good = d == null ? '' : ((d > 0) === !!betterIsHigher ? 'up' : (d === 0 ? '' : 'down'));
  const show = (v) => v == null ? 'n/a' : v + (suffix || '');
  return `<div class="rv__delta">
    <div class="big ${good}">${show(b)} ${arrow}</div>
    <div class="lab">${esc(label)} · was ${show(a)}${d != null ? ` (${d > 0 ? '+' : ''}${d}${suffix || ''})` : ''}</div>
  </div>`;
}

async function renderDiff() {
  let A, B;
  try { A = JSON.parse($('srcA').value); } catch (e) { setStatus($('statusA'), 'invalid JSON', 'bad'); return; }
  try { B = JSON.parse($('srcB').value); } catch (e) { setStatus($('statusB'), 'invalid JSON', 'bad'); return; }
  if (!isReport(A) || !isReport(B)) { setStatus($('statusB'), 'need two kolm reports', 'bad'); return; }

  // verify both so the diff header can state each report's integrity.
  const [va, vb] = await Promise.all([verifyAuditReport(A).catch((e) => ({ ok: false, reason: e.message })), verifyAuditReport(B).catch((e) => ({ ok: false, reason: e.message }))]);
  setStatus($('statusA'), va.ok ? 'verified' : 'not verified', va.ok ? 'ok' : 'bad');
  setStatus($('statusB'), vb.ok ? 'verified' : 'not verified', vb.ok ? 'ok' : 'bad');

  const d = diffReports(A, B);
  $('rvDiffSub').textContent = `${A.subject ? A.subject.name : 'A'} (${A.report_id || ''}) vs ${B.subject ? B.subject.name : 'B'} (${B.report_id || ''})`;

  const stats = `<div class="rv__diffstats">
    ${deltaCard('Readiness', d.readiness.a, d.readiness.b, true, '%')}
    ${deltaCard('Red-team resistance', d.redteam.a, d.redteam.b, true, '')}
    ${deltaCard('Deal-blocking findings', d.blocking.a, d.blocking.b, false, '')}
  </div>`;

  const li = (cls, txt) => `<li class="${cls}">${txt}</li>`;
  const sevTag = (f) => `<span class="muted mono">${esc((f.severity || '').toUpperCase())}</span>`;
  const goodCol = `
    <div>
      <h4 style="margin:0 0 8px">Resolved &amp; improved <span class="muted">(${d.resolved.length + d.improved.length})</span></h4>
      <ul class="rv__difflist">
        ${d.resolved.map((f) => li('good', `Resolved: <b>${esc(f.title)}</b> ${sevTag(f)}`)).join('')}
        ${d.improved.map((x) => li('good', `Improved: <b>${esc(x.to.title)}</b> ${esc((x.from.severity || '').toUpperCase())} → ${esc((x.to.severity || '').toUpperCase())}`)).join('')}
        ${(d.resolved.length + d.improved.length) ? '' : '<li class="muted">No findings resolved or improved.</li>'}
      </ul>
    </div>`;
  const badCol = `
    <div>
      <h4 style="margin:0 0 8px">New &amp; regressed <span class="muted">(${d.added.length + d.regressed.length})</span></h4>
      <ul class="rv__difflist">
        ${d.added.map((f) => li('bad', `New: <b>${esc(f.title)}</b> ${sevTag(f)}`)).join('')}
        ${d.regressed.map((x) => li('bad', `Regressed: <b>${esc(x.to.title)}</b> ${esc((x.from.severity || '').toUpperCase())} → ${esc((x.to.severity || '').toUpperCase())}`)).join('')}
        ${(d.added.length + d.regressed.length) ? '' : '<li class="muted">No new or regressed findings.</li>'}
      </ul>
    </div>`;

  const ctrl = d.ctrlChanges.length ? `
    <div style="margin-top:var(--s5)">
      <h4 style="margin:0 0 8px">Control status changes</h4>
      <ul class="rv__difflist">
        ${d.ctrlChanges.map((c) => li(SEV_RANK_status(c.from, c.to), `<b class="mono">${esc(c.id)}</b> ${esc(c.name || '')}: ${esc(c.from)} → ${esc(c.to)}`)).join('')}
      </ul>
    </div>` : '';

  $('rvDiffBody').innerHTML = stats + `<div class="rv__diffcols">${goodCol}${badCol}</div>` + ctrl
    + `<p class="muted" style="font-size:12.5px;margin-top:var(--s4)">${d.unchanged.length} finding(s) unchanged. Integrity: A ${va.ok ? 'verified' : 'NOT verified'}, B ${vb.ok ? 'verified' : 'NOT verified'}. Both reports are verified independently in this browser; the diff is over their signed contents.</p>`;

  $('rvDiff').classList.remove('hidden');
  $('rvDiff').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// status change colour: pass<attention<blocking
const STATUS_RANK = { pass: 0, attention: 1, blocking: 2 };
function SEV_RANK_status(from, to) {
  const a = STATUS_RANK[from] ?? 0, b = STATUS_RANK[to] ?? 0;
  return b > a ? 'bad' : (b < a ? 'good' : 'warn');
}

// ============================================================================
// LOADERS + wiring.
// ============================================================================
async function loadText(text, which) {
  const ta = which === 'B' ? $('srcB') : $('srcA');
  ta.value = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  if (which === 'B') return; // B is rendered via the diff button
  let doc;
  try { doc = JSON.parse(ta.value); }
  catch (e) { setStatus($('statusA'), 'invalid JSON', 'bad'); return; }
  openReport(doc);
}

async function loadUrl(url, which) {
  const st = which === 'B' ? $('statusB') : $('statusA');
  if (!url) { setStatus(st, 'enter a URL', 'bad'); return; }
  setStatus(st, 'fetching...', null);
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    (which === 'B' ? $('srcB') : $('srcA')).value = txt;
    setStatus(st, 'loaded', 'ok');
    if (which !== 'B') { try { openReport(JSON.parse(txt)); } catch (e) { setStatus(st, 'invalid JSON', 'bad'); } }
  } catch (e) { setStatus(st, 'load failed: ' + e.message, 'bad'); }
}

function wire() {
  $('openBtn').addEventListener('click', () => { try { openReport(JSON.parse($('srcA').value)); } catch (e) { setStatus($('statusA'), 'invalid JSON', 'bad'); } });
  $('sampleBtn').addEventListener('click', () => loadUrl('/sample-audit-report.json', 'A'));
  $('sampleBBtn').addEventListener('click', () => loadUrl('/sample-audit-report.json', 'B'));
  $('urlBtn').addEventListener('click', () => loadUrl($('urlA').value.trim(), 'A'));
  $('urlBBtn').addEventListener('click', () => loadUrl($('urlB').value.trim(), 'B'));
  $('diffBtn').addEventListener('click', renderDiff);
  $('printBtn').addEventListener('click', () => window.print());
  $('clearBtn').addEventListener('click', () => { $('srcA').value = ''; setStatus($('statusA'), 'paste · load · drop', null); $('rvReport').classList.add('hidden'); });
  $('clearBBtn').addEventListener('click', () => { $('srcB').value = ''; setStatus($('statusB'), 'paste · load · drop', null); $('rvDiff').classList.add('hidden'); });

  const cmp = $('cmpToggle');
  cmp.addEventListener('click', () => {
    const on = $('paneB').classList.toggle('hidden') === false;
    $('rvLoad').classList.toggle('is-compare', on);
    cmp.setAttribute('aria-pressed', String(on));
    cmp.textContent = on ? 'Hide compare' : 'Compare two reports';
    if (!on) $('rvDiff').classList.add('hidden');
  });

  // drag-and-drop a .json file onto either pane.
  const rvLoad = $('rvLoad');
  ['dragenter', 'dragover'].forEach((ev) => rvLoad.addEventListener(ev, (e) => { e.preventDefault(); rvLoad.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => rvLoad.addEventListener(ev, (e) => { e.preventDefault(); if (ev !== 'drop' && rvLoad.contains(e.relatedTarget)) return; rvLoad.classList.remove('drag'); }));
  rvLoad.addEventListener('drop', async (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const which = $('paneB') && !$('paneB').classList.contains('hidden') && $('paneB').contains(e.target) ? 'B' : 'A';
    const txt = await file.text();
    if (which === 'B') { $('srcB').value = txt; setStatus($('statusB'), 'dropped: ' + file.name, 'ok'); }
    else { $('srcA').value = txt; setStatus($('statusA'), 'dropped: ' + file.name, 'ok'); try { openReport(JSON.parse(txt)); } catch (_) { setStatus($('statusA'), 'invalid JSON', 'bad'); } }
  });

  // ?src=<trust-url> deep link.
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) { $('urlA').value = src; loadUrl(src, 'A'); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
