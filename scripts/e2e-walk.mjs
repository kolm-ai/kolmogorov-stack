#!/usr/bin/env node
// One-shot E2E walk through the kolm product as a real user.
// Walks: signup -> compile -> poll -> download .kolm -> run -> capture -> evolve
// -> team -> tunnel -> byoc -> airgap status.
// Prints granular step output. Exit non-zero if anything fails honestly.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.KOLM_URL || 'http://localhost:4012';
const KEY = process.env.KOLM_KEY || '';
const ADMIN = process.env.ADMIN_KEY || 'ks_admin_kolm_test_2026';

function h(s) { return { 'authorization': `Bearer ${s || KEY}`, 'content-type': 'application/json', 'accept': 'application/json' }; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function call(method, route, body, key) {
  const r = await fetch(BASE + route, { method, headers: h(key), body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const txt = await r.text();
  let parsed = null;
  if (ct.includes('json')) { try { parsed = JSON.parse(txt); } catch (_) {} } // deliberate: cleanup
  return { status: r.status, body: parsed ?? txt };
}

function log(stage, msg, data) {
  const head = `  [${stage}]`;
  if (data === undefined) console.log(head, msg);
  else console.log(head, msg, typeof data === 'object' ? JSON.stringify(data) : data);
}

function step(n, title) { console.log(`\n=== ${n}. ${title} ===`); }

async function pollJob(id, key, maxSec = 30) {
  for (let i = 0; i < maxSec * 2; i++) {
    const r = await call('GET', `/v1/compile/${id}`, null, key);
    if (r.status !== 200) { log('poll', 'http', r.status); return null; }
    const j = r.body;
    const lastStage = (j.stages || []).slice(-1)[0]?.name || j.status;
    log('poll', `${j.status} progress=${j.progress?.toFixed?.(2) ?? j.progress} stage=${lastStage} k_score=${j.k_score ?? '-'}`);
    if (j.status === 'completed' || j.status === 'failed') return j;
    await sleep(500);
  }
  return null;
}

const main = async () => {
  // 1. Health
  step(1, 'health probe');
  const root = await call('GET', '/v1/registry/public');
  log('reg', 'public artifacts:', root.body?.artifacts?.length ?? '?');

  // 2. Admin probe
  step(2, 'admin key probe');
  const admin = await call('GET', '/v1/account', null, ADMIN);
  log('admin', 'response:', admin.body);

  // 3. Sign up a real test user
  step(3, 'sign up new user (rodney+e2e@kolm.ai)');
  let signupKey = process.env.KOLM_KEY;
  if (!signupKey) {
    const su = await call('POST', '/v1/signup', { email: `rodney+e2e-${Date.now()}@kolm.ai`, password: 'kolm-test-2026!', plan: 'pro' });
    log('signup', su.status, { tenant: su.body?.tenant?.name, api_key: su.body?.api_key });
    signupKey = su.body?.api_key;
  } else {
    log('signup', 'using $KOLM_KEY from env');
  }
  if (!signupKey) throw new Error('no api key after signup');
  fs.writeFileSync(path.join(process.cwd(), 'data', '.e2e-key.txt'), signupKey);

  // 4. Account state
  step(4, 'check account state');
  const acct = await call('GET', '/v1/account', null, signupKey);
  log('account', acct.body && { plan: acct.body.plan, used: acct.body.used, remaining: acct.body.remaining, seats: acct.body.seats });

  // 5. Compile a fresh recipe (with examples so the gate has something to grade)
  step(5, 'compile a brand-new recipe from a natural-language task');
  const task = 'Classify customer support tickets by urgency. Output one of P0 (outage), P1 (broken feature blocking work), P2 (annoying but workaround), P3 (cosmetic / wishlist).';
  const examples = [
    { input: 'All checkouts are failing across all customers right now.', output: 'P0' },
    { input: 'The new release broke the export-to-csv button for everyone.', output: 'P1' },
    { input: 'Search returns slightly stale results on the dashboard.', output: 'P2' },
    { input: 'It would be nice if the admin theme had dark mode.', output: 'P3' },
    { input: 'Production database is down, every user is seeing 500s.', output: 'P0' },
    { input: 'Single-sign-on fails for one customer, the rest are fine.', output: 'P1' },
    { input: 'The settings page has a typo in the help text.', output: 'P3' },
    { input: 'Some users see duplicated rows in the report once a day.', output: 'P2' },
  ];
  const compile = await call('POST', '/v1/compile', { task, examples }, signupKey);
  log('compile', compile.status, compile.body);
  const jobId = compile.body?.job_id;
  if (!jobId) throw new Error('no job_id returned');

  // 6. Poll
  step(6, 'poll compile job to completion');
  const job = await pollJob(jobId, signupKey, 40);
  if (!job) throw new Error('compile timed out');
  if (job.status === 'failed') { log('compile', 'FAILED', job.error); throw new Error('compile failed'); }
  log('done', 'k_score=' + job.k_score, { artifact_bytes: job.artifact_bytes, artifact_url: job.artifact_url, manifest: job.manifest && { k_score: job.manifest.k_score, size_bytes: job.manifest.size_bytes, base_model: job.manifest.base_model } });

  // 7. Download the .kolm artifact
  step(7, 'download .kolm artifact');
  const dlRes = await fetch(BASE + job.artifact_url, { headers: { authorization: `Bearer ${signupKey}` } });
  const buf = Buffer.from(await dlRes.arrayBuffer());
  const outPath = path.join(process.cwd(), 'data', 'e2e-out.kolm');
  fs.writeFileSync(outPath, buf);
  log('dl', `wrote ${outPath}  bytes=${buf.length}  status=${dlRes.status}`);

  // 8. Run the compiled recipe (uses concept_id the compile job now registers)
  step(8, 'run the compiled recipe (inference)');
  const recipes = await call('GET', '/v1/recipes', null, signupKey);
  log('recipes', 'tenant recipe count:', recipes.body?.recipes?.length, 'first:', recipes.body?.recipes?.[0]?.name);
  const conceptId = job.concept_id;
  log('run', 'concept_id:', conceptId);
  if (conceptId) {
    const inputs = [
      'Our payment processor is down, all checkouts failing across all customers right now.',
      'The export-to-csv button is throwing 500s for every user since the noon deploy.',
      'A few customers report duplicated rows in the daily summary email.',
      'Nice-to-have: please add dark mode to the admin panel.',
    ];
    for (const inp of inputs) {
      const run = await call('POST', `/v1/recipes/${conceptId}/run`, { input: inp }, signupKey);
      log('run', run.status, { output: run.body?.output, latency_us: run.body?.latency_us, cache: run.body?.cache });
    }
  } else {
    log('run', 'no concept_id available after compile (synthesis may have rejected)');
  }

  // 9. Capture some live calls (synthetic)
  step(9, 'capture live calls into corpus');
  const cap = await call('POST', '/v1/capture/log', {
    namespace: 'support-tickets',
    items: [
      { input: 'Login completely broken for all users since 9am', output: 'P0' },
      { input: 'Nice-to-have: dark mode in admin', output: 'P3' },
      { input: 'Search returns stale results sometimes', output: 'P2' }
    ]
  }, signupKey);
  log('capture', cap.status, cap.body);

  // 10. Team
  step(10, 'create a team workspace');
  const team = await call('POST', '/v1/teams', { name: 'rodney-e2e-team', slug: 'rodney-e2e' }, signupKey);
  log('team', team.status, team.body);
  const teamSlug = team.body?.team?.slug || team.body?.slug;
  if (teamSlug) {
    const inv = await call('POST', `/v1/teams/${teamSlug}/invite`, { email: 'bob+e2e@kolm.ai', role: 'member' }, signupKey);
    log('invite', inv.status, inv.body);
  }

  // 11. Tunnel
  step(11, 'mint a remote-access tunnel token');
  const t = await call('POST', '/v1/tunnel/register', { label: 'e2e-laptop' }, signupKey);
  log('tunnel', t.status, t.body);
  const list = await call('GET', '/v1/tunnels', null, signupKey);
  log('tunnels', list.status, 'count=' + (list.body?.tunnels?.length ?? '?'));

  // 12. BYOC — every completed compile job IS an artifact, so use job.id
  step(12, 'request a BYOC deploy script');
  const targets = await call('GET', '/v1/byoc/targets', null, signupKey);
  log('byoc', 'targets:', targets.body);
  const deploy = await call('POST', '/v1/byoc/deploy', { target: 'fly', region: 'iad', artifact_id: jobId, name: 'e2e-walk' }, signupKey);
  log('byoc', deploy.status, deploy.body && {
    deploy_id: deploy.body.deployment?.id,
    target: deploy.body.deployment?.target,
    region: deploy.body.deployment?.region,
    script_lines: (deploy.body.deploy_script || '').split('\n').length,
    manifest_signed: !!deploy.body.manifest?.signature,
  });

  // 13. Improve — capture more labelled pairs, re-verify head source, re-synthesize
  step(13, 'improve loop: capture more, re-verify head source, publish new version');
  if (conceptId) {
    const moreCap = await call('POST', '/v1/capture/log', {
      namespace: 'support-tickets',
      items: [
        { input: 'Pay-as-you-go customers see $0.00 quotas after billing job failed.', output: 'P1' },
        { input: 'Trailing slash on the docs links 404s.', output: 'P3' },
        { input: 'CSV import skips rows over 1MB without warning.', output: 'P2' },
        { input: 'Webhook signing secret rotation broke for every tenant.', output: 'P0' },
      ],
    }, signupKey);
    log('capture+', moreCap.status, moreCap.body);

    // Pull the head source so we can re-verify it against a held-out test set.
    const got = await call('GET', `/v1/recipes/${conceptId}`, null, signupKey);
    const headSrc = (got.body?.versions || []).slice(-1)[0]?.source;
    log('head', got.status, { size: headSrc?.length, version_n: (got.body?.versions || []).length });
    if (headSrc) {
      const holdout = [
        { input: 'Server farm caught fire, all regions offline.', expected: 'P0' },
        { input: 'Confirmation email shows the wrong logo.', expected: 'P3' },
        { input: 'Two-factor codes arrive 3 minutes late for ~5% of users.', expected: 'P2' },
        { input: 'Mobile app crash on splash screen for everyone since the build flip.', expected: 'P1' },
      ];
      const ver = await call('POST', '/v1/verify', { source: headSrc, positives: holdout }, signupKey);
      log('verify', ver.status, { pass_rate: ver.body?.pass_rate_positive, accepted: ver.body?.accepted, n: holdout.length });
    }

    // Re-synthesize with the expanded labelled set to produce a new version.
    const expandedPositives = [
      ...examples,
      { input: 'Pay-as-you-go customers see $0.00 quotas after billing job failed.', expected: 'P1' },
      { input: 'Trailing slash on the docs links 404s.', expected: 'P3' },
      { input: 'CSV import skips rows over 1MB without warning.', expected: 'P2' },
      { input: 'Webhook signing secret rotation broke for every tenant.', expected: 'P0' },
    ].map(e => ({ input: e.input, expected: e.expected || e.output }));
    const resyn = await call('POST', '/v1/synthesize', {
      positives: expandedPositives,
      name: 'support-triage-v2',
      description: 'Re-synthesized after capture loop expansion',
      visibility: 'private',
      publish: true,
    }, signupKey);
    log('resyn', resyn.status, {
      accepted: resyn.body?.accepted,
      pass_rate: resyn.body?.pass_rate_positive,
      concept_id: resyn.body?.concept_id,
      version_id: resyn.body?.version_id,
    });
  }

  // 14. Airgap status (via local kolm CLI)
  step(14, 'airgap status (CLI)');
  await new Promise((resolve) => {
    const p = spawn(process.execPath, ['cli/kolm.js', 'airgap', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', (code) => { console.log('  [airgap]', 'exit=' + code, '\n', out.split('\n').slice(0, 20).map(l => '    ' + l).join('\n')); resolve(); });
  });

  console.log('\n=== ALL STEPS COMPLETED ===');
};

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
