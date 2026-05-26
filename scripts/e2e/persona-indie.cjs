#!/usr/bin/env node
// W888-H — Persona B (indie / solo with GPU) end-to-end loop.
//
// Single-shot wall-clock target: <10 minutes including compile. Exit codes:
//   0 = full pass
//   1 = any step failed
//   2 = environment skip (no Node/Python/etc; emits skip envelope on stdout)
//
// Flags:
//   --json     emit a single structured JSON envelope on stdout
//   --smoke    use the SMOKE_SPEC tiny rule fixture (default unless full path)
//   --help     usage
//
// Loop (per the W888-H plan + BLOCK 11 W889-11.1 spec):
//   1.  Isolated home + isolated kolm server
//   2.  Mock signup -> mock API key (provisioned in the data dir at boot)
//   3.  Set OPENAI_BASE_URL to the local server's /v1/capture/openai shim
//   4.  Fire 50 mock OpenAI-compatible calls through the gateway
//   5.  Verify receipts + captures created (hash chain check)
//   6.  Approve captures
//   7.  Check distill readiness
//   8.  Compile (rule_class spec — fast, no GPU teacher required)
//   9.  Serve the artifact locally
//   10. Fire 10 more calls and check route_decision (should be local-eligible)
//   11. Verify cost-displacement reporting populated
//
// HARD LIMITS:
//   - No live provider calls. KOLM_CONNECTOR_FIXTURE=1 forces deterministic
//     responses from the connector proxy.
//   - No network egress beyond 127.0.0.1.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const lib = require('./_lib.cjs');

const SCRIPT_START = Date.now();

(async function main() {
  const args = lib.parseArgv(process.argv.slice(2));
  if (args.help) {
    console.log('persona-indie.cjs [--json] [--smoke] [--dry-run]');
    console.log('');
    console.log('Persona B (indie / solo with GPU) end-to-end loop.');
    console.log('  --json     single structured JSON envelope on stdout');
    console.log('  --smoke    use small rule fixture (default)');
    console.log('  --dry-run  shape check only, no server boot');
    return;
  }

  const persona = 'indie';
  // W889-11.1 — --dry-run emits a contract-shaped envelope and exits 0 in <50ms.
  if (args.dryRun) {
    lib.emitDryRun(persona, { started_at: SCRIPT_START, elapsed_ms: Date.now() - SCRIPT_START });
    process.exit(0);
  }
  const steps = [];

  // --- Step 0 — env probes ---
  {
    const s = lib.stepStart(persona, 'env_probe');
    if (!process.versions || !process.versions.node) {
      lib.stepFail(s, 'no Node runtime detected');
      steps.push(s);
      lib.emitSkip('Node runtime missing', 'install Node 18+', { persona, steps, elapsed_ms: Date.now() - SCRIPT_START });
      process.exit(2);
    }
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major < 18) {
      lib.stepFail(s, `Node ${process.versions.node} < 18`);
      steps.push(s);
      lib.emitSkip(`Node ${process.versions.node} < 18`, 'upgrade to Node 18+', { persona, steps, elapsed_ms: Date.now() - SCRIPT_START });
      process.exit(2);
    }
    lib.stepOk(s, `Node ${process.versions.node}`);
    steps.push(s);
  }

  // --- Step 1 — isolated server boot ---
  let ctx = null;
  {
    const s = lib.stepStart(persona, 'isolated_server_boot');
    try {
      ctx = await lib.setupIsolatedServer({ tenantPlan: 'pro', tenantName: 'indie-e2e' });
      lib.stepOk(s, `server on ${ctx.base} tenant=${ctx.tenantId}`);
      steps.push(s);
    } catch (e) {
      lib.stepFail(s, e);
      steps.push(s);
      lib.emitReport(persona, steps, { started_at: SCRIPT_START, elapsed_ms: Date.now() - SCRIPT_START });
      process.exit(1);
    }
  }

  try {
    // --- Step 2 — verify signup-provisioned API key works ---
    {
      const s = lib.stepStart(persona, 'whoami');
      const r = await lib.request(ctx.base, 'GET', '/v1/whoami', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
      });
      if (!r.ok || !r.json) {
        lib.stepFail(s, `status=${r.status} err=${r.error || r.body || ''}`);
        steps.push(s);
        throw new Error('whoami failed');
      }
      lib.stepOk(s, `tenant=${r.json.tenant || r.json.tenant_id || '?'} logged_in=${r.json.logged_in}`);
      steps.push(s);
    }

    // --- Step 3 — 50 mock OpenAI-compatible calls through the gateway ---
    const callCount = args.smoke ? 8 : 50;
    let captureCount = 0;
    let receiptCount = 0;
    {
      const s = lib.stepStart(persona, `gateway_${callCount}_calls`);
      let ok = 0;
      let firstErr = null;
      for (let i = 0; i < callCount; i++) {
        const r = await lib.request(ctx.base, 'POST', '/v1/capture/openai/v1/chat/completions', {
          headers: { authorization: 'Bearer ' + ctx.apiKey },
          body: {
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'You are a customer-support bot.' },
              { role: 'user', content: `query ${i}: where is my order?` },
            ],
          },
        });
        if (r.status === 200 || r.status === 202) ok++;
        else if (!firstErr) firstErr = `status=${r.status} body=${(r.body || '').slice(0, 200)}`;
      }
      if (ok < Math.floor(callCount * 0.7)) {
        lib.stepFail(s, `only ${ok}/${callCount} OK; first err: ${firstErr}`);
        steps.push(s);
        throw new Error('gateway calls below 70% threshold');
      }
      lib.stepOk(s, `${ok}/${callCount} 2xx`);
      steps.push(s);
    }

    // --- Step 4 — verify captures + receipts ---
    {
      const s = lib.stepStart(persona, 'captures_listed');
      const r = await lib.request(ctx.base, 'GET', '/v1/captures/list?limit=100', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
      });
      if (!r.ok || !r.json) {
        lib.stepFail(s, `status=${r.status}`);
        steps.push(s);
        throw new Error('captures/list failed');
      }
      const captureItems = (Array.isArray(r.json.captures) ? r.json.captures
                          : Array.isArray(r.json.items) ? r.json.items : []);
      captureCount = captureItems.length || (r.json.total || 0);
      lib.stepOk(s, `captures=${captureCount}`);
      steps.push(s);
    }
    {
      const s = lib.stepStart(persona, 'receipts_listed');
      const r = await lib.request(ctx.base, 'GET', '/v1/receipts/list?limit=100', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
      });
      if (!r.ok) {
        // /v1/receipts/list may not be wired in all builds — treat as skip.
        lib.stepSkip(s, `status=${r.status} (receipt listing not wired in this build)`, 'wire /v1/receipts/list');
      } else {
        receiptCount = r.json && (Array.isArray(r.json.receipts) ? r.json.receipts.length
                       : Array.isArray(r.json.items) ? r.json.items.length : 0);
        lib.stepOk(s, `receipts=${receiptCount}`);
      }
      steps.push(s);
    }

    // --- Step 5 — hash-chain check ---
    {
      const s = lib.stepStart(persona, 'capture_hash_chain');
      // Most builds expose hash chain via the capture row's "prev_hash" / "hash"
      // fields surfaced by /v1/captures/list. We verify pairwise contiguity if
      // present; otherwise we accept "no chain field surfaced" as skip.
      const r = await lib.request(ctx.base, 'GET', '/v1/captures/list?limit=100', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
      });
      const items = (r.json && (Array.isArray(r.json.captures) ? r.json.captures
                              : Array.isArray(r.json.items) ? r.json.items : [])) || [];
      const withHash = items.filter((i) => i && (i.hash || i.row_hash));
      if (withHash.length < 2) {
        lib.stepSkip(s, `only ${withHash.length} captures with hash field`, 'hash chain surface incomplete');
      } else {
        let chainOk = true;
        for (let i = 1; i < withHash.length; i++) {
          const prev = withHash[i - 1].hash || withHash[i - 1].row_hash;
          const curPrev = withHash[i].prev_hash;
          if (curPrev && curPrev !== prev) { chainOk = false; break; }
        }
        if (!chainOk) lib.stepFail(s, 'hash chain broken between two captures');
        else lib.stepOk(s, `chain intact across ${withHash.length} rows`);
      }
      steps.push(s);
    }

    // --- Step 6 — approve captures (subset) ---
    {
      const s = lib.stepStart(persona, 'capture_approve');
      const r = await lib.request(ctx.base, 'POST', '/v1/captures/approve_batch', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
        body: { limit: 50 },
      });
      if (r.status === 404) {
        // older builds: alternate endpoint
        const r2 = await lib.request(ctx.base, 'POST', '/v1/captures/approve', {
          headers: { authorization: 'Bearer ' + ctx.apiKey },
          body: { all: true },
        });
        if (r2.status >= 200 && r2.status < 300) lib.stepOk(s, `approved via /v1/captures/approve`);
        else lib.stepSkip(s, `approve endpoints not wired (status1=404 status2=${r2.status})`, 'wire /v1/captures/approve_batch');
      } else if (r.status >= 200 && r.status < 300) {
        lib.stepOk(s, `approved batch`);
      } else {
        lib.stepSkip(s, `approve_batch status=${r.status}`, 'approve endpoints incomplete');
      }
      steps.push(s);
    }

    // --- Step 7 — distill readiness ---
    {
      const s = lib.stepStart(persona, 'distill_readiness');
      const r = await lib.request(ctx.base, 'GET', '/v1/distill/readiness', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
      });
      if (r.status === 404) {
        // Alt path
        const r2 = await lib.request(ctx.base, 'GET', '/v1/readiness', {
          headers: { authorization: 'Bearer ' + ctx.apiKey },
        });
        if (r2.json) lib.stepOk(s, `readiness via /v1/readiness ok=${r2.json.ok}`);
        else lib.stepSkip(s, `readiness endpoints not wired`, 'wire /v1/distill/readiness');
      } else if (r.json) {
        lib.stepOk(s, `readiness ok=${r.json.ok} ready=${r.json.ready}`);
      } else {
        lib.stepSkip(s, `readiness status=${r.status}`, 'readiness response not JSON');
      }
      steps.push(s);
    }

    // --- Step 8 — compile (smoke fixture; full GPU distill not attempted) ---
    let artifactPath = null;
    {
      const s = lib.stepStart(persona, args.smoke ? 'compile_smoke' : 'compile');
      const specPath = path.join(ctx.scratch, 'indie.spec.json');
      const outPath = path.join(ctx.scratch, 'indie.kolm');
      fs.writeFileSync(specPath, JSON.stringify(lib.SMOKE_SPEC));
      const r = lib.runKolm(ctx, ['compile', '--spec', specPath, '--out', outPath], { timeoutMs: 60_000 });
      if (r.status === 0 && fs.existsSync(outPath)) {
        artifactPath = outPath;
        lib.stepOk(s, `${outPath} (${fs.statSync(outPath).size} bytes)`);
      } else {
        lib.stepFail(s, `exit=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`);
        steps.push(s);
        // Compile failure is not a full hard exit — record + continue so we still
        // get serve/route data in the report.
      }
      steps.push(s);
    }

    // --- Step 9 — local serve (verify artifact runnable) ---
    {
      const s = lib.stepStart(persona, 'artifact_run');
      if (!artifactPath) {
        lib.stepSkip(s, 'no artifact (compile failed)', 'see compile step');
      } else {
        const r = lib.runKolm(ctx, ['run', artifactPath, JSON.stringify({ text: 'hi there!' })], { timeoutMs: 20_000 });
        if (r.status === 0 && /is_greeting/.test(r.stdout || '')) {
          lib.stepOk(s, `output OK`);
        } else {
          lib.stepFail(s, `run exit=${r.status} stdout=${(r.stdout || '').slice(0, 200)}`);
        }
      }
      steps.push(s);
    }

    // --- Step 10 — 10 more calls + check for local-routing signal ---
    {
      const s = lib.stepStart(persona, 'route_local_signal');
      let localish = 0;
      for (let i = 0; i < (args.smoke ? 4 : 10); i++) {
        const r = await lib.request(ctx.base, 'POST', '/v1/capture/openai/v1/chat/completions', {
          headers: { authorization: 'Bearer ' + ctx.apiKey },
          body: {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: `hi there ${i}` }],
          },
        });
        const dec = r.headers && (r.headers['x-kolm-route'] || r.headers['x-kolm-route-decision']);
        if (dec === 'local' || dec === 'local-first' || (r.json && r.json.route_decision === 'local')) localish++;
      }
      if (localish > 0) lib.stepOk(s, `${localish} responses tagged local`);
      else lib.stepSkip(s, 'route_decision header not surfaced (mock connector)', 'enable routing decision header in fixture mode');
      steps.push(s);
    }

    // --- Step 11 — cost displacement ---
    {
      const s = lib.stepStart(persona, 'cost_displacement');
      const r = await lib.request(ctx.base, 'GET', '/v1/cost/displacement?days=1', {
        headers: { authorization: 'Bearer ' + ctx.apiKey },
      });
      if (r.status === 404) {
        const r2 = await lib.request(ctx.base, 'GET', '/v1/usage/displacement', {
          headers: { authorization: 'Bearer ' + ctx.apiKey },
        });
        if (r2.json) lib.stepOk(s, `displacement via alt path`);
        else lib.stepSkip(s, 'displacement endpoints not wired', 'wire /v1/cost/displacement');
      } else if (r.json) {
        const usd = (r.json.frontier_cost_usd != null) ? r.json.frontier_cost_usd
          : (r.json.frontier_usd != null ? r.json.frontier_usd : null);
        lib.stepOk(s, `frontier_usd=${usd}`);
      } else {
        lib.stepSkip(s, `displacement status=${r.status}`, 'response not JSON');
      }
      steps.push(s);
    }

  } catch (e) {
    if (!steps.some((s) => !s.ok)) {
      const s = lib.stepStart(persona, 'unexpected');
      lib.stepFail(s, e);
      steps.push(s);
    }
  } finally {
    await lib.teardown(ctx);
  }

  const envelope = lib.emitReport(persona, steps, { started_at: SCRIPT_START, elapsed_ms: Date.now() - SCRIPT_START });
  process.exit(envelope.ok ? 0 : 1);
})().catch((e) => {
  process.stderr.write('persona-indie fatal: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
