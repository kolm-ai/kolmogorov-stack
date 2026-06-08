export const meta = {
  name: 'kolm-copy-audit',
  description: 'Adversarial copy+aesthetic critique of all 28 kolm.ai pages, then independent adjudication of every proposed edit',
  phases: [
    { title: 'Critique', detail: 'one editor per page proposes only material edits' },
    { title: 'Adjudicate', detail: 'independent QA votes accept/reject per edit against constraints' },
  ],
};

const FORBIDDEN = [
  'pip install kolm', '.kolm bundle', '3B INT4', 'Arweave', 'On-chain', 'Air-gap mode',
  'WASM runtime', 'kolm WASM', 'EU AI Act compliant', 'Type I evidence available now',
  'SOC 2 Type II evidence', 'Your data never moves', 'data never moves', 'inside your VPC',
  'BAA boundary', 'PHI never leaves', 'HIPAA-ready', 'Mobile SDK', 'AIUC-1',
];
const FORBID = FORBIDDEN.map((s) => `"${s}"`).join(', ');

const SCOPE = '"We assess, and we say so" / "absence is not proof" / "Injection is tested and reported, not warranted" / "not warranted" / "assessed controls only" / "covers the canonical bytes"';

const POS = `POSITIONING (the entire site sells exactly this): kolm gives an AI-native startup a fast, fixed-fee security-review readiness audit that ends in a cryptographically signed (Ed25519) evidence report the startup hands to an enterprise buyer's security team, who verifies it offline against a public key, no kolm server in the trust path. It turns a deal stalled in security review back into a closed deal. Voice: mono-forward (single family Spline Sans Mono), calm, exact, technically credible, zero hype, short sentences. Aesthetic law: green present = verified, green absent = void; one filled-green action per viewport. GOLD-STANDARD VOICE lives in public/index.html and public/how-it-works.html. Match that register exactly.`;

const CONSTRAINTS = `HARD CONSTRAINTS (a violation is always an edit):
- NO em or en dashes ( ${'—'} ${'–'} ). Use a period, comma, parentheses, or restructure.
- NEVER the word "honest" or "honesty".
- Contact email is dev@kolm.ai ONLY. The string "rodneyyesep" must never appear anywhere.
- NO generic-AI hype kickers ("Unlock the power of", "In today's world", "Imagine", "Revolutionary", "cutting-edge", "seamless", "game-changing").
- FORBIDDEN substrings, must not appear: ${FORBID}.
- PRESERVE EVERY factual + security claim and the EXACT scope wording. Never weaken, strengthen, or invent a claim. Never assert a certification the company does not hold (no SOC2/ISO "certified"). Never name a researcher, "Halborn", a blockchain in the critical path, or call our framework "AIUC-1". These load-bearing scope phrases must survive verbatim if present: ${SCOPE}.
- Only ever touch human-visible COPY. Never edit a <script> body, JSON-LD, data-* attribute, class name, href, svg, or any structural/verifier wiring.`;

const ROOT_NOTE = 'Read the file with the Read tool (path relative to repo root). Read public/index.html and public/how-it-works.html first if you have not, to calibrate voice.';

const CRIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['page', 'verdict', 'edits', 'aesthetic_notes', 'overall'],
  properties: {
    page: { type: 'string' },
    verdict: { type: 'string', enum: ['clean', 'edits'] },
    edits: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['anchor', 'replacement', 'category', 'severity', 'preserves_claims', 'rationale'],
        properties: {
          anchor: { type: 'string', description: 'EXACT verbatim substring from the file, unique, <=200 chars' },
          replacement: { type: 'string', description: 'full replacement for the anchor, obeys every constraint' },
          category: { type: 'string', enum: ['wordiness', 'structure', 'aesthetic', 'constraint', 'consistency'] },
          severity: { type: 'string', enum: ['high', 'med', 'low'] },
          preserves_claims: { type: 'boolean' },
          rationale: { type: 'string' },
        },
      },
    },
    aesthetic_notes: { type: 'string', description: 'layout/spacing/rhythm issues needing CSS/markup (not copy), or empty' },
    overall: { type: 'string' },
  },
};

const ADJ_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['anchor', 'accept', 'reason', 'fixed_replacement'],
        properties: {
          anchor: { type: 'string' },
          accept: { type: 'boolean' },
          reason: { type: 'string' },
          fixed_replacement: { type: ['string', 'null'], description: 'corrected replacement if idea good but flawed, else null' },
        },
      },
    },
  },
};

// tier: 'full' = copy+aesthetic+structure; 'legal' = constraint-violations only, do not restyle prose.
const PAGES = [
  ['public/index.html', 'full'],
  ['public/how-it-works.html', 'full'],
  ['public/platform.html', 'full'],
  ['public/checks.html', 'full'],
  ['public/report.html', 'full'],
  ['public/verify.html', 'full'],
  ['public/pricing.html', 'full'],
  ['public/trust.html', 'full'],
  ['public/security.html', 'full'],
  ['public/security/threat-model.html', 'full'],
  ['public/enterprise.html', 'full'],
  ['public/solutions/ai-vendors.html', 'full'],
  ['public/solutions/enterprise-buyers.html', 'full'],
  ['public/research.html', 'full'],
  ['public/docs.html', 'full'],
  ['public/contact.html', 'full'],
  ['public/status.html', 'full'],
  ['public/transparency-log.html', 'full'],
  ['public/changelog.html', 'full'],
  ['public/careers.html', 'full'],
  ['public/404.html', 'full'],
  ['public/privacy.html', 'legal'],
  ['public/terms.html', 'legal'],
  ['public/dpa.html', 'legal'],
  ['public/baa.html', 'legal'],
  ['public/sla.html', 'legal'],
  ['public/subprocessors.html', 'legal'],
  ['public/acceptable-use.html', 'legal'],
];

function critPrompt([file, tier]) {
  const legal = tier === 'legal'
    ? `\nTHIS IS A LEGAL PAGE. Do NOT rewrite legal prose for style or length. Propose an edit ONLY for a hard-constraint violation (dash, forbidden substring, "honest(y)", wrong email) or a broken/off-positioning marketing line in the header or footer. Legal substance stays verbatim.\n`
    : '';
  return `You are a ruthless senior brand + copy editor and product designer doing a launch gate on ONE page of kolm.ai.

${POS}

YOUR PAGE: ${file}  (tier: ${tier})
${ROOT_NOTE}

Judge the page on: (1) wordiness, is anything longer than it needs to be; (2) structure, does section order and hierarchy serve a CTO buyer clearing a security review; (3) aesthetic, spacing/rhythm/hierarchy issues visible in the markup; (4) constraint violations; (5) consistency with the gold-standard voice.
${legal}
${CONSTRAINTS}

These pages are already strong. Propose an edit ONLY if it is a clear, material improvement (cuts real wordiness, fixes a structural or aesthetic defect, fixes a constraint violation, or removes voice drift). Prefer ZERO edits over marginal churn. Judge your own proposals more harshly than the page: if you would not bet the launch on an edit being better, drop it. A clean page returns verdict "clean" and an empty edits array.

For every edit: anchor = an EXACT substring copied verbatim from the file, with enough surrounding text to be UNIQUE in the file (<=200 chars). replacement = the full replacement for that exact anchor; it must obey every constraint and preserve every claim/scope phrase in the anchor. Set preserves_claims=true only if that holds. Put non-copy layout/spacing observations in aesthetic_notes (do not encode them as edits).

Return the structured object.`;
}

function adjPrompt(file, edits) {
  return `You are an adversarial QA reviewer gating edits before they ship to a launch-critical site. A copy editor proposed edits to ${file}. Read ${file} in full with the Read tool first, then vote on EACH edit independently.

REJECT an edit if ANY of these is true:
- the anchor is not found verbatim in the file, or it appears more than once (not unique).
- the replacement introduces an em/en dash ( ${'—'} ${'–'} ), the word "honest(y)", "rodneyyesep", a forbidden substring (${FORBID}), or a hype kicker.
- the replacement drops, weakens, strengthens, or invents any factual/security claim or scope phrase that is in the anchor. Load-bearing phrases: ${SCOPE}.
- the replacement asserts an unheld certification, names a researcher/"Halborn"/a blockchain in the critical path, or calls the framework "AIUC-1".
- the replacement is lateral churn (not a clear improvement) or shifts meaning.
- the replacement breaks HTML (tags/attributes unbalanced vs the anchor) or touches non-copy wiring (script/JSON-LD/data-*/class/href).
Otherwise ACCEPT. If the idea is sound but the replacement has a fixable flaw, set fixed_replacement to a corrected, fully compliant version; otherwise fixed_replacement = null.

PROPOSED EDITS (JSON):
${JSON.stringify(edits, null, 1)}

Return { verdicts: [...] } with exactly one verdict per proposed edit, echoing each anchor back verbatim.`;
}

phase('Critique');
const out = await pipeline(
  PAGES,
  (p) => agent(critPrompt(p), { label: `crit:${p[0].replace('public/', '')}`, phase: 'Critique', schema: CRIT_SCHEMA, agentType: 'Explore' }),
  (crit, p) => {
    if (!crit || !crit.edits || crit.edits.length === 0) {
      return { page: p[0], tier: p[1], critique: crit, adjudication: { verdicts: [] } };
    }
    return agent(adjPrompt(p[0], crit.edits), { label: `adj:${p[0].replace('public/', '')}`, phase: 'Adjudicate', schema: ADJ_SCHEMA, agentType: 'Explore' })
      .then((adj) => ({ page: p[0], tier: p[1], critique: crit, adjudication: adj || { verdicts: [] } }));
  },
);

const clean = out.filter(Boolean);
let proposed = 0, accepted = 0;
const report = [];
for (const r of clean) {
  const edits = r.critique?.edits || [];
  proposed += edits.length;
  const vmap = new Map((r.adjudication?.verdicts || []).map((v) => [v.anchor, v]));
  const acceptedEdits = [];
  for (const e of edits) {
    const v = vmap.get(e.anchor);
    if (v && v.accept) {
      accepted++;
      acceptedEdits.push({ anchor: e.anchor, replacement: v.fixed_replacement || e.replacement, category: e.category, severity: e.severity, rationale: e.rationale });
    }
  }
  report.push({
    page: r.page, tier: r.tier,
    verdict: r.critique?.verdict, overall: r.critique?.overall,
    aesthetic_notes: r.critique?.aesthetic_notes || '',
    proposed: edits.length, accepted: acceptedEdits.length,
    acceptedEdits,
    rejected: edits.filter((e) => { const v = vmap.get(e.anchor); return !(v && v.accept); }).map((e) => ({ anchor: e.anchor.slice(0, 80), category: e.category, reason: (vmap.get(e.anchor)?.reason || 'no verdict') })),
  });
}

log(`copy-audit: ${clean.length} pages, ${proposed} proposed, ${accepted} accepted after adjudication`);
return { summary: { pages: clean.length, proposed, accepted }, report };
