// report-viewer.js - a 100%-browser, dependency-free viewer for a kolm Agent
// Security-Review evidence report.
//
// It LOADS a signed report (from ?src=<trust-url>, a paste, a URL field, or a
// dropped .json file), VERIFIES its Ed25519 signature offline by reusing the
// published verifier (/kolm-audit-verify.js - no crypto is reimplemented here),
// resolves the signing key against kolm's issuer keyring INCLUDING revocation
// (tier 3: a cryptographically valid signature from a revoked key is VOID),
// and then RENDERS the signed document the way the reviewer reads it:
//
//   - a verification masthead (VERIFIED / SIGNATURE INTACT / VOID / UNVERIFIED)
//     with issuer, key fingerprint, transparency-log leaf, signed-at, as-of age,
//     tier, and evidence tier,
//   - the evidence-tier banner (A/B/C, or "not graded" for a legacy envelope),
//   - subject, scope (boxed, verbatim, BEFORE findings), the eight-control
//     posture grid (grey by default - color is earned by evidence),
//   - findings grouped by control, the injection battery, what was not tested,
//   - the signature block with offline-verify commands, and
//   - a visual diff between two reports (improved / regressed / resolved / new).
//
// Everything runs in this browser. There is no kolm server in the trust path.
// The page is a lens; the JSON is the source.

import {
  verifyAuditReport,
  issuerProvenance,
  isFingerprintRevoked,
  AUDIT_REPORT_SCHEMA,
} from '/kolm-audit-verify.js';

// kolm's published issuer keyring, INLINED as the offline anchor (view-source it).
// We also merge /keys/kolm-issuers.json when the network is reachable (which is
// also how an already-published revocation reaches this page), but the inlined
// copy is what an offline reviewer resolves against. Mirrors verify.html.
const KOLM_ISSUERS = {
  schema: 'kolm-issuer-keyring-1',
  revocations: [],
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
    if (Array.isArray(fresh.revocations)) KOLM_ISSUERS.revocations = fresh.revocations;
  } catch (_) { /* offline: keep the inlined anchor */ }
}
const keyringReady = refreshKeyring();

// Best-effort LIVE issuer-key status (revocation is the one fact an offline
// page cannot know by itself). Unreachable is a calm condition, never an error:
// the keyring anchor still decides recognition; only an explicit 'revoked'
// answer changes the verdict.
async function liveKeyStatus(fp) {
  if (!fp) return { reachable: false };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('/v1/audit/issuer-key/' + encodeURIComponent(fp) + '/status', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { reachable: false };
    const j = await r.json();
    if (!j || typeof j !== 'object') return { reachable: false };
    return { reachable: true, status: j.status || null, valid: j.valid !== false, revoked_at: j.revoked_at || null, reason: j.reason || null };
  } catch (_) { return { reachable: false }; }
}

// --- small DOM + format helpers ---------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nCount = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's');
const isReport = (o) => !!(o && typeof o === 'object' && o.schema === AUDIT_REPORT_SCHEMA);

const SEV_HEX = { critical: '#8C3A2E', high: '#C2603A', medium: '#B5852A', low: '#565C57', info: '#11875A', none: '#8A908B' };
const SEV_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('is-ok', 'is-bad');
  if (kind) el.classList.add(kind === 'ok' ? 'is-ok' : 'is-bad');
}

function shortHash(h, n) { const s = String(h == null ? '' : h); return s.length > (n || 16) ? s.slice(0, n || 16) : s; }

function ageDays(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000;
}

// Verification state for the currently loaded reports, so the diff can show it.
const state = { A: null, B: null };

// ============================================================================
// VERIFY + RENDER report A.
// ============================================================================
async function openReport(report) {
  if (!isReport(report)) {
    setStatus($('statusA'), 'not a kolm report', 'bad');
    return;
  }
  setStatus($('statusA'), 'verifying...', null);
  await keyringReady;

  const sig = report.signature_ed25519 && typeof report.signature_ed25519 === 'object' ? report.signature_ed25519 : null;

  // Tier 1+3 in one pass: signature integrity, and refuse a revoked issuer key.
  let verify;
  try { verify = await verifyAuditReport(report, { issuerKeyring: KOLM_ISSUERS }); }
  catch (e) { verify = { ok: false, reason: 'verifier error: ' + e.message, checks: [] }; }

  // Tier 2: is the embedded key one of kolm's published issuer keys?
  const prov = issuerProvenance(report, KOLM_ISSUERS);

  // Tier 3, live half: ask the public status endpoint (calm when unreachable).
  const fp = verify.key_fingerprint || (sig && sig.key_fingerprint) || null;
  const live = await liveKeyStatus(fp);
  const revokedLive = live.reachable && live.status === 'revoked';
  const revokedOffline = verify.reason === 'issuer_key_revoked'
    || (fp && sig && isFingerprintRevoked(fp, sig.public_key, { issuerKeyring: KOLM_ISSUERS }));

  // The four masthead states.
  //   UNVERIFIED        no signature block - there is nothing to check.
  //   VOID              canonical bytes do not match the signature, OR the
  //                     issuer key is revoked (valid math, withdrawn key).
  //   VERIFIED          signature valid + issuer resolved in kolm's keyring
  //                     (and not revoked).
  //   SIGNATURE INTACT  signature valid, but the issuer cannot be resolved
  //                     (unknown key, or status unavailable). Calm, not red.
  let verdict;
  if (!sig) verdict = 'unverified';
  else if (revokedOffline || revokedLive) verdict = 'void-revoked';
  else if (!verify.ok) verdict = 'void';
  else if (prov.recognized) verdict = 'verified';
  else verdict = 'intact';

  state.A = { report, verify, prov, verdict, live };

  renderDoc(report, { verify, prov, verdict, live, fp });
  $('rvJson').textContent = JSON.stringify(report, null, 2);

  $('rvReport').classList.remove('hidden');
  const stText = verdict === 'verified' ? 'verified · kolm issuer'
    : verdict === 'intact' ? 'signature intact'
    : verdict === 'unverified' ? 'unverified (no signature)'
    : 'VOID';
  setStatus($('statusA'), stText, (verdict === 'verified' || verdict === 'intact') ? 'ok' : 'bad');
  $('rvReport').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ============================================================================
// THE DOCUMENT. One renderer per register; absent fields collapse cleanly.
// ============================================================================
function renderDoc(report, v) {
  const parts = [
    renderMasthead(report, v),
    renderSubject(report),
    renderScope(report),
    renderPosture(report),
    renderFindings(report),
    renderProbes(report),
    renderNotTested(report),
    renderSignature(report, v),
  ];
  $('rvDoc').innerHTML = parts.filter(Boolean).join('');
  // findings start open for the worst severity group so the print artifact and
  // the first read both lead with what matters.
  const first = $('rvDoc').querySelector('details.finding');
  if (first) first.open = true;
}

// --- masthead ----------------------------------------------------------------
function renderMasthead(report, v) {
  const sig = report.signature_ed25519 || {};
  const lc = report.log_checkpoint && typeof report.log_checkpoint === 'object' ? report.log_checkpoint : null;

  let cls = 'is-unverified', word = 'UNVERIFIED', sub = 'no signature block to check';
  if (v.verdict === 'verified') {
    cls = 'is-verified'; word = 'VERIFIED';
    sub = 'signature valid · ' + (v.prov.label || 'kolm issuer') + (v.live.reachable ? ' · key live' : '');
  } else if (v.verdict === 'intact') {
    cls = 'is-intact'; word = 'SIGNATURE INTACT';
    sub = v.live.reachable ? 'signature valid · key not in kolm\'s published keyring' : 'signature valid · issuer status unavailable';
  } else if (v.verdict === 'void-revoked') {
    cls = 'is-void'; word = 'VOID';
    sub = 'issuer key revoked' + (v.live.revoked_at ? ' ' + v.live.revoked_at.slice(0, 10) : '') + (v.live.reason ? ' (' + v.live.reason + ')' : '');
  } else if (v.verdict === 'void') {
    cls = 'is-void'; word = 'VOID';
    sub = v.verify.reason || 'signed bytes do not match the signature';
  }

  // as-of age: stale is a state, not a footnote.
  const age = ageDays(report.generated_at);
  let ageChip = '';
  if (age != null) {
    if (age > 90) ageChip = ' <span class="chipx stale">STALE</span>';
    else if (age > 30) ageChip = ' <span class="chipx aging">AGING</span>';
    else ageChip = ' <span class="chipx current">CURRENT</span>';
  }
  const ageNote = age == null ? '' : (age > 90
    ? '<div class="v" style="font-size:11.5px;color:var(--void)">over 90 days old; treat as a historical record</div>'
    : (age > 30 ? '<div class="v" style="font-size:11.5px;color:var(--ink-3)">30-90 days old; consider a re-audit</div>' : ''));

  const tierCell = report.tier === 'scan'
    ? 'Scan (free, watermarked preview)'
    : report.tier === 'report' ? 'Signed Readiness Report' : (report.tier || 'not stated');

  const et = report.evidence_tier && typeof report.evidence_tier === 'object' ? report.evidence_tier : null;
  const etCell = et && et.grade ? 'Tier ' + esc(String(et.grade).toUpperCase()) : 'not graded';

  const issuerCell = v.prov.recognized
    ? esc(v.prov.label || v.prov.kid || 'kolm') + ' (' + esc(v.prov.status || 'issuer') + ')'
    : (sig.public_key ? 'key not in kolm\'s published keyring' : 'none');

  const tlogCell = lc
    ? '<div class="v mono">leaf ' + esc(shortHash(lc.leaf_hash, 16)) + ' · seq ' + esc(lc.seq) + ' of ' + esc(lc.tree_size) + '</div>'
    : '<div class="v">not logged</div>';

  return `
  <header class="mast">
    <div class="mast__grid">
      <div class="mast__stamp ${cls}">
        <span class="state">${esc(word)}</span>
        <span class="sub">${esc(sub)}</span>
      </div>
      <div class="mast__meta">
        <div><div class="k">Issuer</div><div class="v">${issuerCell}</div><div class="v mono">${esc(sig.key_fingerprint || v.fp || 'n/a')}</div></div>
        <div><div class="k">Transparency log</div>${tlogCell}</div>
        <div><div class="k">Signed at</div><div class="v mono">${esc(sig.signed_at || 'n/a')}</div></div>
        <div><div class="k">As of</div><div class="v mono">${esc((report.generated_at || 'n/a').slice(0, 10))}${ageChip}</div>${ageNote}</div>
        <div><div class="k">Tier</div><div class="v">${esc(tierCell)}</div></div>
        <div><div class="k">Evidence tier</div><div class="v">${etCell}</div></div>
      </div>
    </div>
    ${renderEvidenceTierBanner(report)}
    ${report.watermark === true || report.tier === 'scan' ? `
    <div class="wmnote"><b>UNPAID PREVIEW</b> · This is the free Scan: the complete findings, with a watermark inside the signed bytes. The paid report is the same audit re-signed without the watermark. The paywall is the signature, never the findings.</div>` : ''}
  </header>`;
}

function renderEvidenceTierBanner(report) {
  const et = report.evidence_tier && typeof report.evidence_tier === 'object' ? report.evidence_tier : null;
  if (!et || !et.grade) {
    return '<div class="etier tNone">Evidence tier: <b>not graded</b> (issued before tiered evidence). The findings stand on the logs supplied; how those logs were captured was not graded in this envelope.</div>';
  }
  const g = String(et.grade).toUpperCase();
  const lines = {
    A: 'captured by the kolm gateway at runtime - kolm observed the traffic itself.',
    B: 'vendor logs, hash chain verified - the supplied export carried an integrity chain that checks out.',
    C: 'vendor logs as provided - the findings stand on the export as supplied, with no independent capture.',
  };
  const cls = g === 'A' ? 'tA' : g === 'B' ? 'tB' : 'tC';
  const basis = Array.isArray(et.basis) && et.basis.length
    ? '<span class="basis">basis: ' + et.basis.map(esc).join(' · ') + '</span>' : '';
  return `<div class="etier ${cls}"><b>TIER ${esc(g)}</b> evidence: ${esc(lines[g] || et.method || 'method not stated')}${basis}</div>`;
}

// --- 01 subject ---------------------------------------------------------------
function renderSubject(report) {
  const s = report.subject && typeof report.subject === 'object' ? report.subject : {};
  const p = report.passport && typeof report.passport === 'object' ? report.passport : {};
  const ed = report.evidence_digest && typeof report.evidence_digest === 'object' ? report.evidence_digest : null;

  const cells = [];
  cells.push(`<div><div class="k">Subject</div><div class="v">${esc(s.name || 'Agent fleet')}</div></div>`);
  if (s.source) cells.push(`<div><div class="k">Log source</div><div class="v mono">${esc(s.source)}</div></div>`);
  if (s.records != null || s.events != null) cells.push(`<div><div class="k">Observed</div><div class="v">${esc(s.records ?? '?')} records · ${esc(s.events ?? '?')} events</div></div>`);
  if (s.retention) cells.push(`<div><div class="k">Retention</div><div class="v">${esc(s.retention)}</div></div>`);
  if (ed && ed.value) cells.push(`<div><div class="k">Input evidence digest</div><div class="v mono">${esc(ed.alg || 'sha256')}:${esc(shortHash(ed.value, 24))}...</div><div class="v" style="font-size:11.5px;color:var(--ink-3)">binds this report to the exact logs analyzed</div></div>`);
  if (report.report_id) cells.push(`<div><div class="k">Report</div><div class="v mono">${esc(report.report_id)} · ${esc(report.report_version || '')}</div></div>`);

  // per-agent tool scopes
  const agents = Array.isArray(p.agents) ? p.agents : [];
  const agentRows = agents.map((a) => `
    <div style="margin-top:var(--s4)">
      <div class="k">Agent · ${esc(a.agent || '?')} <span class="mono" style="text-transform:none;letter-spacing:0">(key ${esc(a.key_id || '?')})</span></div>
      <div class="pillrow">${(Array.isArray(a.scopes) ? a.scopes : []).map((sc) => `<span class="pill">${esc(sc)}</span>`).join('')}</div>
    </div>`).join('');

  // models + vendor surface
  const models = Array.isArray(p.models) ? p.models : [];
  const modelTable = models.length ? `
    <div style="margin-top:var(--s5)">
      <div class="k" style="margin-bottom:6px">Models and vendor egress surface</div>
      <table>
        <thead><tr><th>Model</th><th>Provider</th><th>Pinned snapshot</th></tr></thead>
        <tbody>${models.map((m) => `<tr><td class="mono">${esc(m.slug || '?')}</td><td>${esc(m.provider || '?')}</td><td>${m.pinned ? 'yes' : '<span style="color:var(--attn-text)">no (floating alias)</span>'}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : '';
  const mcp = Array.isArray(p.mcp_surface)
    ? `<p class="v" style="margin:var(--s3) 0 0;color:var(--ink-3)">MCP surface: ${p.mcp_surface.length ? p.mcp_surface.map(esc).join(', ') : 'none declared in the observed window'}.</p>` : '';

  // delegation edges
  const dg = p.delegation_graph && typeof p.delegation_graph === 'object' ? p.delegation_graph : null;
  const edges = dg && Array.isArray(dg.edges) && dg.edges.length ? `
    <p class="v" style="margin:var(--s3) 0 0;color:var(--ink-3)">Delegation observed: ${dg.edges.map((e2) => esc(e2.from || '?') + ' -&gt; ' + esc(e2.to || '?') + ' (' + esc(e2.via || 'unknown') + ', ' + esc(e2.classification || 'unclassified') + ')').join('; ')}.</p>` : '';

  return `
  <section id="rvSubject">
    <h2 class="reg"><span class="n">01</span>Subject under review</h2>
    <div class="subj">${cells.join('')}</div>
    ${agentRows}${modelTable}${mcp}${edges}
  </section>`;
}

// --- 02 scope: boxed, verbatim, BEFORE findings -------------------------------
const SCOPE_LINE = 'Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted.';

function renderScope(report) {
  const caveats = Array.isArray(report.caveats) ? report.caveats
    : Array.isArray(report.limitations) ? report.limitations : [];
  const inData = caveats.find((c) => typeof c === 'string' && c.indexOf('Scope is contractual') === 0);
  const rest = caveats.filter((c) => c !== inData);
  return `
  <section id="rvScope">
    <h2 class="reg"><span class="n">02</span>Scope and limitations</h2>
    <div class="scopebox">
      <div class="k">Scope</div>
      <p class="scopeline">${esc(inData || SCOPE_LINE)}</p>
      ${rest.length ? `<ul>${rest.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </div>
  </section>`;
}

// --- 03 posture: eight controls, three states, grey by default ----------------
const ASR_FALLBACK = [
  ['ASR-1', 'Least privilege'], ['ASR-2', 'Audit trail'], ['ASR-3', 'Data egress'], ['ASR-4', 'Injection'],
  ['ASR-5', 'Provenance'], ['ASR-6', 'Evidence'], ['ASR-7', 'Memory and retrieval integrity'], ['ASR-8', 'Multi-agent delegation'],
];

function renderPosture(report) {
  const sum = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const byId = new Map((sum.controls || []).map((c) => [c.id, c]));
  const naById = new Map((sum.not_assessed || []).map((n) => [n.id, n]));
  const names = new Map(ASR_FALLBACK);
  for (const c of (report.asr_checklist || [])) if (c && c.id) names.set(c.id, c.name || names.get(c.id));
  for (const c of (sum.controls || [])) if (c && c.id) names.set(c.id, c.name || names.get(c.id));

  const ids = ASR_FALLBACK.map(([id]) => id);
  for (const c of (sum.controls || [])) if (c && c.id && !ids.includes(c.id)) ids.push(c.id);

  const tiles = ids.map((id) => {
    const c = byId.get(id);
    const na = naById.get(id);
    let cls = '', st = 'INSUFFICIENT EVIDENCE', why = '';
    if (c && c.status === 'pass') {
      cls = ' pass'; st = 'PASS';
      why = 'evidence supports this control in the observed window.';
    } else if (c && c.status === 'attention') {
      cls = ' attn'; st = 'FINDINGS · ATTENTION';
      why = nCount(c.findings || 0, 'finding') + ((c.findings || 0) === 1 ? ' maps' : ' map') + ' here; none is deal-blocking on its own.';
    } else if (c && c.status === 'blocking') {
      cls = ' block'; st = 'FINDINGS · BLOCKING';
      why = (c.findings || 0) === 1 ? '1 finding maps here, and it is deal-blocking.' : nCount(c.findings || 0, 'finding') + ' map here, at least one deal-blocking.';
    } else if (c && c.status === 'untested') {
      st = 'INSUFFICIENT EVIDENCE';
      why = 'untested in this run' + (c.findings ? '; ' + nCount(c.findings, 'informational note') + ' recorded' : '') + '. Grey is not a pass.';
    } else if (na) {
      st = 'NOT ASSESSED';
      const r = String(na.reason || '');
      why = r.length > 150 ? r.slice(0, 147) + '...' : (r || 'not assessed in this run.');
    } else {
      why = 'no signal either way in this envelope. Grey is not a pass.';
    }
    return `
    <div class="tile${cls}">
      <span class="tid">${esc(id)}</span>
      <span class="tnm">${esc(names.get(id) || id)}</span>
      <span class="twhy">${esc(why)}</span>
      <span class="tst">${esc(st)}</span>
    </div>`;
  }).join('');

  // severity strip
  const bs = sum.by_severity && typeof sum.by_severity === 'object' ? sum.by_severity : {};
  const strip = SEV_ORDER.filter((sv) => (bs[sv] || 0) > 0)
    .map((sv) => `<span><i class="dot" style="background:${SEV_HEX[sv]}"></i>${esc(bs[sv])} ${esc(sv)}</span>`).join('');
  const sevstrip = strip ? `<div class="sevstrip">${strip}<span style="margin-left:auto">${esc(sum.total_findings ?? 0)} findings total · ${esc(sum.blocking_count ?? 0)} deal-blocking</span></div>` : '';

  // the rollups, demoted to one labeled line. A rollup, not a grade.
  const rt = report.red_team && typeof report.red_team === 'object' ? report.red_team : null;
  const bits = [];
  if (sum.readiness_pct != null) bits.push('Readiness rollup: ' + sum.readiness_pct + '% of assessed controls pass - a rollup, not a grade.');
  if (rt && rt.score != null) bits.push('Injection-resistance rollup: ' + rt.score + '/100 across ' + ((rt.summary && rt.summary.tested) ?? '?') + ' tested probes - a rollup, not a grade.');
  const rollup = bits.length ? `<p class="rollup">${esc(bits.join(' '))}</p>` : '';

  return `
  <section id="rvPosture">
    <h2 class="reg"><span class="n">03</span>Posture: the eight controls</h2>
    <div class="grid8">${tiles}</div>
    ${sevstrip}
    ${rollup}
    <p class="legend">Grey by default: a tile earns color only when evidence supports it. Green = evidence supports a pass. Earth tones = findings map to the control. Grey = insufficient evidence, never a pass.</p>
  </section>`;
}

// --- 04 findings, grouped by control ------------------------------------------
function remediationFor(report, f) {
  const rems = Array.isArray(report.remediation) ? report.remediation : [];
  return rems.find((r) => r && r.finding_id === f.id && r.title === f.title)
    || rems.find((r) => r && r.finding_id === f.id) || null;
}

function renderFinding(report, f) {
  const sev = String(f.severity || 'info').toLowerCase();
  const ev = Array.isArray(f.evidence) && f.evidence.length
    ? f.evidence.join('\n')
    : 'no event hashes carried for this finding';
  const chips = (Array.isArray(f.frameworks) ? f.frameworks : []).map((fw) => `<span class="chip">${esc(fw)}</span>`).join('');
  const rem = remediationFor(report, f);
  return `
  <details class="finding">
    <summary>
      <span class="fsev" style="background:${SEV_HEX[sev] || SEV_HEX.none}">${esc(sev.toUpperCase())}</span>
      <span class="ftitle">${esc(f.title || f.id || 'finding')}</span>
      <span class="fid">${esc(f.id || '')}</span>
    </summary>
    <div class="fbody">
      ${f.detail ? `<div><h3>Claim</h3><p>${esc(f.detail)}</p></div>` : ''}
      <div><h3>Evidence (event hashes in the signed envelope)</h3><div class="evid">${esc(ev)}</div></div>
      ${chips ? `<div><h3>Maps to (a map, not a certification)</h3><div class="chips">${chips}</div></div>` : ''}
      ${rem ? `<div><h3>Remediation</h3><div class="remed"><div class="who">${esc(rem.priority || '')} · ${esc((rem.severity || '').toUpperCase())}</div>${esc(rem.action || '')}</div></div>` : ''}
    </div>
  </details>`;
}

function renderFindings(report) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (!findings.length) {
    return `
  <section id="rvFindings">
    <h2 class="reg"><span class="n">04</span>Findings</h2>
    <p class="v" style="color:var(--ink-3)">No findings in this envelope. Read that against the scope above: the absence of a finding is not proof the underlying risk is absent.</p>
  </section>`;
  }
  // group by ASR control, worst severity first inside each group.
  const groups = new Map();
  for (const f of findings) {
    const key = f.asr && f.asr.id ? f.asr.id : 'other';
    if (!groups.has(key)) groups.set(key, { name: f.asr && f.asr.name ? f.asr.name : 'Other', items: [] });
    groups.get(key).items.push(f);
  }
  const order = ASR_FALLBACK.map(([id]) => id).filter((id) => groups.has(id));
  for (const k of groups.keys()) if (!order.includes(k)) order.push(k);

  const html = order.map((k) => {
    const g = groups.get(k);
    g.items.sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
    return `<p class="fgroup">${esc(k)} · ${esc(g.name)} · ${nCount(g.items.length, 'finding')}</p>` + g.items.map((f) => renderFinding(report, f)).join('');
  }).join('');

  return `
  <section id="rvFindings">
    <h2 class="reg"><span class="n">04</span>Findings, grouped by control</h2>
    ${html}
  </section>`;
}

// --- 05 injection battery ------------------------------------------------------
function renderProbes(report) {
  const rt = report.red_team && typeof report.red_team === 'object' ? report.red_team : null;
  if (!rt || !Array.isArray(rt.probes) || !rt.probes.length) return '';
  const sum = rt.summary || {};
  const head = `<p class="v" style="color:var(--ink-3);margin:0 0 var(--s4)">${esc(rt.domain || 'generic')} suite · ${esc(sum.resisted ?? 0)} resisted, ${esc(sum.exposed ?? 0)} exposed, ${esc(sum.untested ?? 0)} untested of ${esc(sum.probes_total ?? 0)} probes. Injection is tested and reported, not warranted; untested probes are marked, not scored.</p>`;
  const probes = rt.probes.map((p) => `
  <details class="probe">
    <summary>
      <span class="ftitle" style="min-width:200px">${esc(p.title || p.id)}</span>
      <span class="fid">${esc(p.category || '')} · ${esc((p.severity || '').toUpperCase())}</span>
      <span class="pst s-${esc(p.status)}">${esc((p.status || '').toUpperCase())}</span>
    </summary>
    <div class="pbody">
      ${p.detail ? `<p style="margin:6px 0 0">${esc(p.detail)}</p>` : ''}
      ${Array.isArray(p.evidence) && p.evidence.length ? `<div class="evid" style="margin-top:8px">${esc(p.evidence.join('\n'))}</div>` : ''}
      ${Array.isArray(p.frameworks) && p.frameworks.length ? `<div class="chips" style="margin-top:8px">${p.frameworks.map((fw) => `<span class="chip">${esc(fw)}</span>`).join('')}</div>` : ''}
    </div>
  </details>`).join('');
  return `
  <section id="rvProbes">
    <h2 class="reg"><span class="n">05</span>Injection battery - tested and reported, not warranted</h2>
    ${head}${probes}
  </section>`;
}

// --- 06 what was not tested ----------------------------------------------------
function renderNotTested(report) {
  const sum = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const items = [];
  for (const n of (sum.not_assessed || [])) {
    items.push(`<li><b class="mono">${esc(n.id)}</b> not assessed in this run. ${esc(n.reason || '')}</li>`);
  }
  for (const c of (sum.controls || [])) {
    if (c && c.status === 'untested') items.push(`<li><b class="mono">${esc(c.id)}</b> ${esc(c.name || '')}: untested - the observed window carried no signal either way. Grey, not a pass.</li>`);
  }
  const rt = report.red_team && typeof report.red_team === 'object' ? report.red_team : null;
  const untestedProbes = rt && Array.isArray(rt.probes) ? rt.probes.filter((p) => p.status === 'untested') : [];
  if (untestedProbes.length) {
    items.push(`<li><b class="mono">${nCount(untestedProbes.length, 'probe')}</b> in the injection battery reported untested: ${untestedProbes.map((p) => esc(p.title || p.id)).join('; ')}. Untested is marked, not scored.</li>`);
  }
  if (!items.length) return '';
  return `
  <section id="rvNotTested">
    <h2 class="reg"><span class="n">06</span>What was not tested</h2>
    <ul class="nottested">${items.join('')}</ul>
  </section>`;
}

// --- 07 signature + offline verification ----------------------------------------
function renderSignature(report, v) {
  const sig = report.signature_ed25519 || {};
  const lc = report.log_checkpoint && typeof report.log_checkpoint === 'object' ? report.log_checkpoint : null;
  const issuer = v.prov.recognized
    ? (v.prov.label || v.prov.kid || 'kolm') + ' (' + (v.prov.status || 'issuer') + ')'
    : (sig.public_key ? 'key not in kolm\'s published keyring' : 'none');

  const rows = [
    ['verdict', v.verdict === 'verified' ? 'VERIFIED - signature valid, issuer resolved, key not revoked'
      : v.verdict === 'intact' ? 'SIGNATURE INTACT - signature valid; issuer not resolved'
      : v.verdict === 'unverified' ? 'UNVERIFIED - no signature block in this document'
      : v.verdict === 'void-revoked' ? 'VOID - issuer key revoked'
      : 'VOID - ' + (v.verify.reason || 'signature does not verify')],
    ['issuer', issuer],
    ['key fingerprint', sig.key_fingerprint || v.fp || 'n/a'],
    ['algorithm', (sig.alg || '?') + ' (' + (sig.spec || '?') + ')'],
    ['signed at', sig.signed_at || 'n/a'],
  ];
  if (lc) rows.push(['tlog leaf', shortHash(lc.leaf_hash, 24) + '... seq ' + (lc.seq ?? '?') + ' of tree ' + (lc.tree_size ?? '?')]);
  const pad = (k) => (k + '              ').slice(0, 16);
  const block = rows.map(([k, val]) => pad(k) + val).join('\n');

  return `
  <section class="sigfoot" id="rvSig">
    <h2 class="reg"><span class="n">07</span>Signature and offline verification</h2>
    <div class="sigblock">${esc(block)}</div>
    <p class="v" style="margin:var(--s4) 0 0;color:var(--ink-2)">
      The signature covers the canonical JSON of this document: keys sorted, no whitespace, with the
      <span class="mono">signature_ed25519</span>, <span class="mono">timestamp_evidence</span>,
      <span class="mono">log_checkpoint</span> and <span class="mono">co_signatures</span> fields detached
      before signing. That is kolm's documented canonical form (see <a href="/spec">the spec</a>), not RFC 8785 JCS.
      Change one byte anywhere else and the verdict above reads VOID.
    </p>
    <div class="vcmd">
      <h3>Verify in a browser</h3>
      <pre>Drop this JSON on https://kolm.ai/verify - or read the verifier first: https://kolm.ai/kolm-audit-verify.js</pre>
      <h3>Verify in Node (20+, no dependencies)</h3>
      <pre>const { verifyAuditReport } = await import('https://kolm.ai/kolm-audit-verify.js');
const result = await verifyAuditReport(report);  // { ok, key_fingerprint, checks }</pre>
      <h3>Verify in Python (kolm SDK)</h3>
      <pre>from kolm import verify_report
result = verify_report(report)  # result.ok, result.tier1_signature, result.tier2_issuer</pre>
      <p>Every command runs offline against the same bytes. No kolm server is in the trust path: the page is a lens, the JSON is the source. Spec: <a href="/spec">kolm.ai/spec</a> · standalone verifier page: <a href="/verify">kolm.ai/verify</a>.</p>
    </div>
  </section>`;
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
  // values come from untrusted pasted/fetched JSON and land in innerHTML:
  // only finite numbers may render; anything else reads as n/a.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v
    : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) ? +v : null;
  const a = num(av), b = num(bv);
  const d = (a == null || b == null) ? null : b - a;
  const good = d == null ? '' : ((d > 0) === !!betterIsHigher ? 'up' : (d === 0 ? '' : 'down'));
  const show = (val) => val == null ? 'n/a' : val + (suffix || '');
  return `<div class="rv__delta">
    <div class="big ${good}">${show(b)}${d != null && d !== 0 ? ' (' + (d > 0 ? '+' : '') + d + (suffix || '') + ')' : ''}</div>
    <div class="lab">${esc(label)} · was ${show(a)} · a rollup, not a grade</div>
  </div>`;
}

async function renderDiff() {
  let A, B;
  try { A = JSON.parse($('srcA').value); } catch (e) { setStatus($('statusA'), 'invalid JSON', 'bad'); return; }
  try { B = JSON.parse($('srcB').value); } catch (e) { setStatus($('statusB'), 'invalid JSON', 'bad'); return; }
  if (!isReport(A) || !isReport(B)) { setStatus($('statusB'), 'need two kolm reports', 'bad'); return; }

  // verify both so the diff header can state each report's integrity.
  await keyringReady;
  const opts = { issuerKeyring: KOLM_ISSUERS };
  const [va, vb] = await Promise.all([
    verifyAuditReport(A, opts).catch((e) => ({ ok: false, reason: e.message })),
    verifyAuditReport(B, opts).catch((e) => ({ ok: false, reason: e.message })),
  ]);
  setStatus($('statusA'), va.ok ? 'verified' : 'not verified', va.ok ? 'ok' : 'bad');
  setStatus($('statusB'), vb.ok ? 'verified' : 'not verified', vb.ok ? 'ok' : 'bad');

  const d = diffReports(A, B);
  $('rvDiffSub').textContent = `${A.subject ? A.subject.name : 'A'} (${A.report_id || ''}) vs ${B.subject ? B.subject.name : 'B'} (${B.report_id || ''})`;

  const stats = `<div class="rv__diffstats">
    ${deltaCard('Readiness rollup', d.readiness.a, d.readiness.b, true, '%')}
    ${deltaCard('Injection-resistance rollup', d.redteam.a, d.redteam.b, true, '')}
    ${deltaCard('Deal-blocking findings', d.blocking.a, d.blocking.b, false, '')}
  </div>`;

  const li = (cls, txt) => `<li class="${cls}">${txt}</li>`;
  const sevTag = (f) => `<span class="muted mono">${esc((f.severity || '').toUpperCase())}</span>`;
  const goodCol = `
    <div>
      <h3 style="margin:0 0 8px;font-size:14px">Resolved &amp; improved <span class="muted">(${d.resolved.length + d.improved.length})</span></h3>
      <ul class="rv__difflist">
        ${d.resolved.map((f) => li('good', `Resolved: <b>${esc(f.title)}</b> ${sevTag(f)}`)).join('')}
        ${d.improved.map((x) => li('good', `Improved: <b>${esc(x.to.title)}</b> ${esc((x.from.severity || '').toUpperCase())} -&gt; ${esc((x.to.severity || '').toUpperCase())}`)).join('')}
        ${(d.resolved.length + d.improved.length) ? '' : '<li class="muted">No findings resolved or improved.</li>'}
      </ul>
    </div>`;
  const badCol = `
    <div>
      <h3 style="margin:0 0 8px;font-size:14px">New &amp; regressed <span class="muted">(${d.added.length + d.regressed.length})</span></h3>
      <ul class="rv__difflist">
        ${d.added.map((f) => li('bad', `New: <b>${esc(f.title)}</b> ${sevTag(f)}`)).join('')}
        ${d.regressed.map((x) => li('bad', `Regressed: <b>${esc(x.to.title)}</b> ${esc((x.from.severity || '').toUpperCase())} -&gt; ${esc((x.to.severity || '').toUpperCase())}`)).join('')}
        ${(d.added.length + d.regressed.length) ? '' : '<li class="muted">No new or regressed findings.</li>'}
      </ul>
    </div>`;

  const ctrl = d.ctrlChanges.length ? `
    <div style="margin-top:var(--s5)">
      <h3 style="margin:0 0 8px;font-size:14px">Control status changes</h3>
      <ul class="rv__difflist">
        ${d.ctrlChanges.map((c) => li(statusDeltaClass(c.from, c.to), `<b class="mono">${esc(c.id)}</b> ${esc(c.name || '')}: ${esc(c.from)} -&gt; ${esc(c.to)}`)).join('')}
      </ul>
    </div>` : '';

  $('rvDiffBody').innerHTML = stats + `<div class="rv__diffcols">${goodCol}${badCol}</div>` + ctrl
    + `<p class="muted" style="font-size:12.5px;margin-top:var(--s4)">${nCount(d.unchanged.length, 'finding')} unchanged. Integrity: A ${va.ok ? 'verified' : 'NOT verified'}, B ${vb.ok ? 'verified' : 'NOT verified'}. Both reports are verified independently in this browser; the diff is over their signed contents.</p>`;

  $('rvDiff').classList.remove('hidden');
  $('rvDiff').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// status change colour: pass<attention<blocking
const STATUS_RANK = { pass: 0, attention: 1, blocking: 2 };
function statusDeltaClass(from, to) {
  const a = STATUS_RANK[from] ?? 0, b = STATUS_RANK[to] ?? 0;
  return b > a ? 'bad' : (b < a ? 'good' : 'warn');
}

// ============================================================================
// LOADERS + wiring. Every entry point: paste, ?src=, URL field, file drop, sample.
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
  // Busy state on the pane's load buttons: a slow fetch should not look idle,
  // and a double click should not race two loads into the same textarea.
  const busy = (which === 'B' ? ['sampleBBtn', 'urlBBtn'] : ['sampleBtn', 'urlBtn'])
    .map((id) => $(id)).filter(Boolean);
  busy.forEach((b) => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
  setStatus(st, 'fetching...', null);
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    (which === 'B' ? $('srcB') : $('srcA')).value = txt;
    setStatus(st, 'loaded', 'ok');
    // Make the loaded state shareable: reflect a successful pane-A URL load
    // in ?src= so the address bar is a deep link to what is on screen.
    if (which !== 'B' && /^https?:\/\//i.test(url)) {
      try { const u = new URL(location.href); u.searchParams.set('src', url); history.replaceState(null, '', u); } catch (_) {}
    }
    if (which !== 'B') { try { openReport(JSON.parse(txt)); } catch (e) { setStatus(st, 'invalid JSON', 'bad'); } }
  } catch (e) { setStatus(st, 'load failed: ' + e.message + '. Check the URL and that it allows cross-origin reads, then try again.', 'bad'); }
  finally { busy.forEach((b) => { b.disabled = false; b.removeAttribute('aria-busy'); }); }
}

function wire() {
  $('openBtn').addEventListener('click', () => { try { openReport(JSON.parse($('srcA').value)); } catch (e) { setStatus($('statusA'), 'invalid JSON', 'bad'); } });
  $('sampleBtn').addEventListener('click', () => loadUrl('/sample-audit-report.json', 'A'));
  $('sampleBBtn').addEventListener('click', () => loadUrl('/sample-audit-report.json', 'B'));
  $('urlBtn').addEventListener('click', () => loadUrl($('urlA').value.trim(), 'A'));
  $('urlBBtn').addEventListener('click', () => loadUrl($('urlB').value.trim(), 'B'));
  // Enter in a URL field loads it; nobody should have to reach for the button.
  $('urlA').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadUrl($('urlA').value.trim(), 'A'); } });
  $('urlB').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadUrl($('urlB').value.trim(), 'B'); } });
  $('diffBtn').addEventListener('click', renderDiff);
  $('printBtn').addEventListener('click', () => window.print());

  // Clear stashes what it wiped so one press of Restore brings it back
  // (one-shot; a fresh Clear refreshes the stash).
  const stash = { A: null, B: null };
  function wireClear(which, clearId, restoreId, srcId, statusId, hideId) {
    const restore = $(restoreId);
    $(clearId).addEventListener('click', () => {
      const cur = $(srcId).value;
      if (cur.trim()) { stash[which] = cur; if (restore) restore.hidden = false; }
      $(srcId).value = '';
      setStatus($(statusId), 'paste · load · drop', null);
      $(hideId).classList.add('hidden');
    });
    if (restore) restore.addEventListener('click', () => {
      if (stash[which] == null) return;
      $(srcId).value = stash[which];
      stash[which] = null;
      restore.hidden = true;
      setStatus($(statusId), 'previous input restored', 'ok');
    });
  }
  wireClear('A', 'clearBtn', 'restoreBtn', 'srcA', 'statusA', 'rvReport');
  wireClear('B', 'clearBBtn', 'restoreBBtn', 'srcB', 'statusB', 'rvDiff');

  // raw-JSON toggle: the page is a lens; this shows the source.
  const jb = $('jsonBtn');
  jb.addEventListener('click', () => {
    const on = $('rvJson').classList.toggle('show');
    jb.setAttribute('aria-pressed', String(on));
    jb.textContent = on ? 'Hide JSON' : 'View as JSON';
  });

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
