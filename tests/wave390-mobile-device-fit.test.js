// Wave 390 - mobile device-profile recommender fit
//
// Bug: `kolm models recommend --use mobile --device iphone-15-pro` picked
// Qwen 0.5B instead of Gemma 3n E2B, because fitsOn() keyed mobile-headroom
// off `device.class === 'mobile'` but every real mobile profile in W211 has
// `class: 'inference'`. Gemma 3n E2B's 2.5GB at q4 + 2.0GB desktop KV
// headroom = 4.5GB exceeded the 4GB vram_gb on iphone-15-pro, so the score
// dropped below the 0.5B Qwen baseline.
//
// Fix:
//   - Tag mobile profiles with `mobile_profile: true` + `effective_ram_gb`
//     (post-OS-overhead working set) + bump iPhone 15 Pro vram_gb 4 -> 6.
//   - Add isMobileDevice() that consults mobile_profile, runtime (mlc-llm /
//     mediapipe / aicore), and the legacy class === 'mobile' fallback.
//   - fitsOn() and recommend() use isMobileDevice() instead of a class
//     match. fitsOn() also gates on effective_ram_gb (when present) rather
//     than the headline vram_gb, so the recommender models the realistic
//     LLM working set rather than the marketing RAM number.
//   - recommend() returns device_fit_explanation + summary lines so the CLI
//     and JSON callers can show "memory_required_gb / device_effective_gb /
//     picked / fit_ok".
//
// Behavior assertions:
//   1. recommend({use:'mobile', target_device: iphone-15-pro}) picks Gemma 3n.
//   2. recommend({use:'mobile', target_device: pixel-8-pro}) picks Gemma 3n.
//   3. The output carries a reasoning line containing "fits because" + a
//      memory_required figure.
//   4. The unspecified-device path (no target_device) still picks Gemma 3n.
//   5. isMobileDevice() returns true for iphone-15-pro / pixel-8-pro /
//      iphone-16-pro / pixel-9-pro-tpu / galaxy-s24-ultra / android-snapdragon
//      and false for rtx-4090 / a100-80gb.
//   6. fitsOn(gemma-3n-E2B, iphone-15-pro) === true (used to be false).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOBILE_IDS = [
  'iphone-15-pro',
  'iphone-16-pro',
  'pixel-8-pro',
  'pixel-9-pro-tpu',
  'galaxy-s24-ultra',
  'android-snapdragon-8-gen3',
];

test('W390 #1 - iphone-15-pro picks Gemma 3n', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('iphone-15-pro');
  assert.ok(dev, 'iphone-15-pro device profile must exist');
  const r = M.recommend({ use: 'mobile', target_device: dev });
  assert.ok(
    r.pick === 'google/gemma-3n-E2B-it' || r.pick === 'google/gemma-3n-E4B-it',
    `expected a Gemma 3n pick for iphone-15-pro, got ${r.pick}`,
  );
  assert.equal(r.device_fit, true, 'device_fit must be true for the picked model');
});

test('W390 #2 - pixel-8-pro picks Gemma 3n', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('pixel-8-pro');
  assert.ok(dev, 'pixel-8-pro device profile must exist');
  const r = M.recommend({ use: 'mobile', target_device: dev });
  assert.ok(
    r.pick === 'google/gemma-3n-E2B-it' || r.pick === 'google/gemma-3n-E4B-it',
    `expected a Gemma 3n pick for pixel-8-pro, got ${r.pick}`,
  );
});

test('W390 #3 - output carries a reasoning line with fits-because + memory_required', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('iphone-15-pro');
  const r = M.recommend({ use: 'mobile', target_device: dev });
  assert.equal(typeof r.device_fit_explanation, 'string', 'must emit device_fit_explanation');
  assert.match(r.device_fit_explanation, /fits because/i, 'reason must contain "fits because"');
  assert.equal(typeof r.summary, 'string', 'must emit summary line');
  assert.match(r.summary, /memory_required_gb/, 'summary must mention memory_required_gb');
  assert.match(r.summary, /picked:/, 'summary must mention picked');
  assert.ok(r.fit && typeof r.fit.memory_required_gb === 'number',
    'fit object must carry numeric memory_required_gb');
});

test('W390 #4 - unspecified-device path still picks Gemma 3n', async () => {
  const M = await import('../src/models.js');
  const r = M.recommend({ use: 'mobile' });
  assert.ok(
    r.pick === 'google/gemma-3n-E2B-it' || r.pick === 'google/gemma-3n-E4B-it',
    `expected a Gemma 3n pick with no device, got ${r.pick}`,
  );
});

test('W390 #5 - isMobileDevice classifies known mobile profiles', async () => {
  const D = await import('../src/devices.js');
  assert.equal(typeof D.isMobileDevice, 'function', 'isMobileDevice must be exported');
  for (const id of MOBILE_IDS) {
    const dev = D.info(id);
    assert.ok(dev, `device profile ${id} must exist`);
    assert.equal(D.isMobileDevice(dev), true, `${id} must be mobile`);
  }
  // Negative cases: training/server devices.
  for (const id of ['rtx-4090', 'a100-80gb', 'h100-80gb']) {
    const dev = D.info(id);
    assert.ok(dev, `device profile ${id} must exist`);
    assert.equal(D.isMobileDevice(dev), false, `${id} must not be mobile`);
  }
});

test('W390 #6 - fitsOn(gemma-3n-E2B, iphone-15-pro) is true (regression)', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('iphone-15-pro');
  assert.equal(M.fitsOn('google/gemma-3n-E2B-it', dev), true,
    'Gemma 3n E2B must fit on iphone-15-pro under the mobile KV-headroom rule');
});

test('W390 #7 - explainFit reports mobile-path headroom + effective budget', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('iphone-15-pro');
  const ex = M.explainFit('google/gemma-3n-E2B-it', dev);
  assert.equal(ex.ok, true, 'must report ok:true');
  assert.equal(ex.mobile_path, true, 'must report mobile_path:true');
  assert.ok(ex.headroom_gb <= 0.5, `mobile headroom must be <= 0.5, got ${ex.headroom_gb}`);
  assert.ok(typeof ex.device_effective_gb === 'number', 'must surface device_effective_gb');
});

test('W390 #8 - --device without --use still picks Gemma 3n on a phone', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('iphone-15-pro');
  // No `use` flag passed: default is 'default'. The mobile bias should kick
  // in via targetIsMobile detection, not the use string.
  const r = M.recommend({ target_device: dev });
  assert.ok(
    r.pick === 'google/gemma-3n-E2B-it' || r.pick === 'google/gemma-3n-E4B-it',
    `expected a Gemma 3n pick with iphone-15-pro device alone, got ${r.pick}`,
  );
});

test('W390 #9 - desktop devices unaffected (RTX 4090 still picks server tier)', async () => {
  const M = await import('../src/models.js');
  const D = await import('../src/devices.js');
  const dev = D.info('rtx-4090');
  const r = M.recommend({ target_device: dev });
  // RTX 4090 has 24GB; Gemma 3n is NOT the right desktop default.
  assert.notEqual(r.pick, 'google/gemma-3n-E2B-it',
    'RTX 4090 must NOT silently default to Gemma 3n mobile pick');
  assert.notEqual(r.pick, 'google/gemma-3n-E4B-it',
    'RTX 4090 must NOT silently default to Gemma 3n mobile pick');
});
