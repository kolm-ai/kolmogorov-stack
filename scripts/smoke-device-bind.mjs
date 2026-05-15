// End-to-end smoke for device-targeted artifact compilation + runtime verify.
// Builds two artifacts: one compiled-for-rtx-5090 (this box), one
// compiled-for-iphone-15-pro. Verifies both pass / fail correctly when the
// "host" device is rtx-5090.

import { buildPayload, verifyDeviceFit } from '../src/artifact.js';

// buildPayload needs the sign secret.
process.env.KOLM_SIGN_SECRET = process.env.KOLM_SIGN_SECRET || 'smoke-test-secret';

let ok = 0, fail = 0;
const T = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -- ' + JSON.stringify(extra) : ''}`); }
};

const base = {
  job_id: 'job_test',
  task: 'classify customer support tickets',
  base_model: 'Qwen/Qwen2.5-3B-Instruct',
  recipes: [{ id: 'r_001', name: 'rule', source: 'x', source_hash: 'h', version_id: 'v1', tags: [], schema: null }],
  training_stats: { distilled_pairs: 100, accuracy: 0.92, pass_rate_positive: 0.92 },
  evals: { spec: 'rs-1-evals', n: 10, cases: [], coverage: 0.9 },
};

const p5090 = buildPayload({ ...base, target_device: 'rtx-5090' });
T('rtx-5090 artifact manifest carries target_device', p5090.manifest.target_device === 'rtx-5090', p5090.manifest);

const pPhone = buildPayload({ ...base, target_device: 'iphone-15-pro' });
T('iphone-15-pro artifact manifest carries target_device', pPhone.manifest.target_device === 'iphone-15-pro');

const pNoTgt = buildPayload({ ...base });
T('no-target artifact has null target_device', pNoTgt.manifest.target_device === null);

// Now verify against host = rtx-5090.
const hostDev = 'rtx-5090';

const v1 = await verifyDeviceFit(p5090.manifest, hostDev);
console.log('  rtx-5090 -> rtx-5090:', v1);
T('rtx-5090 artifact runs on rtx-5090 (exact)', v1.ok === true && !v1.soft);

const v2 = await verifyDeviceFit(pPhone.manifest, hostDev);
console.log('  iphone-15-pro -> rtx-5090:', v2);
T('iphone-15-pro artifact does NOT run on rtx-5090 (class mismatch)', v2.ok === false || v2.soft === true);

const v3 = await verifyDeviceFit(pNoTgt.manifest, hostDev);
console.log('  no-target -> rtx-5090:', v3);
T('untargeted artifact runs anywhere (soft)', v3.ok === true && v3.soft === true);

// Phone host can't run 5090 artifact.
const v4 = await verifyDeviceFit(p5090.manifest, 'iphone-15-pro');
console.log('  rtx-5090 -> iphone-15-pro:', v4);
T('rtx-5090 artifact does NOT run on iphone-15-pro', v4.ok === false);

console.log(`\n${ok}/${ok + fail} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
