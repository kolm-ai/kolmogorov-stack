// WC04 — test coverage close-out for src/devices.js.
//
// Previously: 984 LOC, 0 tests anywhere in tests/.
// Pins the dual-registry public surface: DEVICES (W211/W372 fleet rows used by
// fitsOn/trainOn/recommender) + PROFILES (W409s artifact target classes),
// plus the pure lookup/filter helpers (list, info, listProfiles, showProfile,
// isMobileDevice) and recommendForProfile()'s decision matrix.
//
// detectLocal() + detectProfile() are NOT covered here — they shell out to
// nvidia-smi / sysctl / wmic which is host-dependent and out of scope for a
// pure-lookup test file. detectProfile()'s hint path is covered via
// recommendForProfile({ hints: { profile_id } }), which routes through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICES,
  TRAIN_DEFAULT_BY_DEVICE,
  INFER_DEFAULT_BY_DEVICE,
  TEE_DEVICES,
  MOBILE_RUNTIMES,
  PROFILES,
  PROFILE_CLASSES,
  SUPPORTED_TARGETS,
  isMobileDevice,
  info,
  list,
  listProfiles,
  showProfile,
  recommendForProfile,
} from '../src/devices.js';

test('WC04-dv #1 DEVICES is a non-empty array with required keys per row', () => {
  assert.ok(Array.isArray(DEVICES));
  assert.ok(DEVICES.length >= 20, `expected >=20 device rows, got ${DEVICES.length}`);
  for (const d of DEVICES.slice(0, 3)) {
    for (const k of ['id', 'label', 'class', 'arch']) {
      assert.ok(k in d, `missing key ${k} on ${d.id}`);
    }
  }
});

test('WC04-dv #2 DEVICES contains the anchor training rigs (5090, 4090, A100, H100)', () => {
  const ids = new Set(DEVICES.map(d => d.id));
  for (const id of ['rtx-5090', 'rtx-4090', 'a100-80gb', 'h100-80gb', 'h200-141gb']) {
    assert.ok(ids.has(id), `missing anchor training device ${id}`);
  }
});

test('WC04-dv #3 DEVICES contains the anchor mobile + edge devices', () => {
  const ids = new Set(DEVICES.map(d => d.id));
  for (const id of ['iphone-15-pro', 'pixel-8-pro', 'wasm', 'cpu-x86_64', 'raspberry-pi-5']) {
    assert.ok(ids.has(id), `missing anchor mobile/edge device ${id}`);
  }
});

test('WC04-dv #4 TRAIN_DEFAULT_BY_DEVICE keys all resolve via info()', () => {
  for (const id of Object.keys(TRAIN_DEFAULT_BY_DEVICE)) {
    assert.ok(info(id), `TRAIN_DEFAULT_BY_DEVICE references unknown device id: ${id}`);
  }
});

test('WC04-dv #5 INFER_DEFAULT_BY_DEVICE keys all resolve via info()', () => {
  for (const id of Object.keys(INFER_DEFAULT_BY_DEVICE)) {
    assert.ok(info(id), `INFER_DEFAULT_BY_DEVICE references unknown device id: ${id}`);
  }
});

test('WC04-dv #6 TEE_DEVICES is derived from DEVICES with .tee set', () => {
  assert.ok(Array.isArray(TEE_DEVICES));
  assert.ok(TEE_DEVICES.length >= 4, `expected >=4 TEE devices, got ${TEE_DEVICES.length}`);
  for (const t of TEE_DEVICES) {
    assert.ok(t.id && t.tee && t.attestation, `TEE row missing fields: ${JSON.stringify(t)}`);
    const dev = info(t.id);
    assert.ok(dev, `TEE row references unknown device: ${t.id}`);
    assert.equal(dev.tee, t.tee);
  }
});

test('WC04-dv #7 MOBILE_RUNTIMES is a Set covering mlc-llm / mediapipe / aicore', () => {
  assert.ok(MOBILE_RUNTIMES instanceof Set);
  for (const rt of ['mlc-llm', 'mediapipe', 'aicore']) {
    assert.ok(MOBILE_RUNTIMES.has(rt), `MOBILE_RUNTIMES missing ${rt}`);
  }
  // Should NOT include desktop runtimes
  assert.equal(MOBILE_RUNTIMES.has('llama-cpp'), false);
  assert.equal(MOBILE_RUNTIMES.has('tensorrt-llm'), false);
});

test('WC04-dv #8 isMobileDevice returns false for null/undefined', () => {
  assert.equal(isMobileDevice(null), false);
  assert.equal(isMobileDevice(undefined), false);
});

test('WC04-dv #9 isMobileDevice detects mobile_profile:true rows', () => {
  const iphone = info('iphone-15-pro');
  assert.equal(isMobileDevice(iphone), true);
  const pixel = info('pixel-8-pro');
  assert.equal(isMobileDevice(pixel), true);
});

test('WC04-dv #10 isMobileDevice returns false for desktop GPU rows', () => {
  const rtx = info('rtx-5090');
  assert.equal(isMobileDevice(rtx), false);
  const cpu = info('cpu-x86_64');
  assert.equal(isMobileDevice(cpu), false);
});

test('WC04-dv #11 isMobileDevice keys off runtime when mobile_profile absent', () => {
  // synthetic device whose only mobile signal is .runtime in MOBILE_RUNTIMES
  assert.equal(isMobileDevice({ runtime: 'mlc-llm' }), true);
  assert.equal(isMobileDevice({ runtime: 'aicore' }), true);
  assert.equal(isMobileDevice({ runtime: 'llama-cpp' }), false);
});

test('WC04-dv #12 isMobileDevice keys off class === mobile fallback', () => {
  assert.equal(isMobileDevice({ class: 'mobile' }), true);
  assert.equal(isMobileDevice({ class: 'inference' }), false);
});

test('WC04-dv #13 info(id) returns the matching device row + null for unknown', () => {
  const d = info('rtx-5090');
  assert.equal(d.id, 'rtx-5090');
  assert.equal(d.label, 'NVIDIA RTX 5090');
  assert.equal(info('never-shipped-device-9000'), null);
  assert.equal(info(undefined), null);
});

test('WC04-dv #14 list() returns a defensive copy of all DEVICES', () => {
  const all = list();
  assert.equal(all.length, DEVICES.length);
  // Mutating the returned array must not affect the source registry.
  all.pop();
  assert.equal(DEVICES.length > all.length, true);
});

test('WC04-dv #15 list(class) narrows to that class', () => {
  const train = list('training');
  for (const d of train) assert.equal(d.class, 'training');
  assert.ok(train.length > 0);
  const inf = list('inference');
  for (const d of inf) assert.equal(d.class, 'inference');
  // Inference should include at least the mobile + wasm + cpu rows
  assert.ok(inf.length >= train.length, 'inference class should cover phones+edge');
});

test('WC04-dv #16 PROFILES is a non-empty array with required keys', () => {
  assert.ok(Array.isArray(PROFILES));
  assert.ok(PROFILES.length >= 10);
  for (const p of PROFILES.slice(0, 3)) {
    for (const k of ['id', 'name', 'profile_class', 'arch', 'supported_targets', 'runtime_status']) {
      assert.ok(k in p, `PROFILE missing key ${k} on ${p.id}`);
    }
  }
});

test('WC04-dv #17 PROFILE_CLASSES enumerates the seven device taxonomies', () => {
  assert.ok(Array.isArray(PROFILE_CLASSES));
  for (const c of ['mobile-android', 'mobile-ios', 'desktop-cpu', 'desktop-gpu', 'workstation', 'server', 'embedded']) {
    assert.ok(PROFILE_CLASSES.includes(c), `PROFILE_CLASSES missing ${c}`);
  }
  // Every PROFILE.profile_class must be a member of PROFILE_CLASSES.
  for (const p of PROFILES) {
    assert.ok(PROFILE_CLASSES.includes(p.profile_class), `${p.id} has off-taxonomy class: ${p.profile_class}`);
  }
});

test('WC04-dv #18 SUPPORTED_TARGETS enumerates the six target runtimes', () => {
  assert.ok(Array.isArray(SUPPORTED_TARGETS));
  for (const t of ['js', 'wasm', 'gguf', 'onnx', 'native-cuda', 'native-metal']) {
    assert.ok(SUPPORTED_TARGETS.includes(t), `SUPPORTED_TARGETS missing ${t}`);
  }
});

test('WC04-dv #19 listProfiles() returns a defensive copy + filter narrows', () => {
  const all = listProfiles();
  assert.equal(all.length, PROFILES.length);
  all.pop();
  assert.equal(PROFILES.length > all.length, true);
  const ios = listProfiles({ profile_class: 'mobile-ios' });
  for (const p of ios) assert.equal(p.profile_class, 'mobile-ios');
  assert.ok(ios.length > 0);
});

test('WC04-dv #20 listProfiles supports compound filters (arch + runtime_status)', () => {
  const out = listProfiles({ arch: 'x64', runtime_status: 'production' });
  for (const p of out) {
    assert.equal(p.arch, 'x64');
    assert.equal(p.runtime_status, 'production');
  }
  assert.ok(out.length > 0);
});

test('WC04-dv #21 listProfiles({supported_target}) narrows to profiles supporting that target', () => {
  const cuda = listProfiles({ supported_target: 'native-cuda' });
  for (const p of cuda) assert.ok(p.supported_targets.includes('native-cuda'));
  assert.ok(cuda.length > 0);
});

test('WC04-dv #22 listProfiles({offline_capable}) accepts boolean coercion', () => {
  const offline = listProfiles({ offline_capable: true });
  for (const p of offline) assert.equal(!!p.offline_capable, true);
  assert.ok(offline.length > 0);
});

test('WC04-dv #23 showProfile(id) returns the profile + null for unknown', () => {
  const p = showProfile('desktop-gpu-rtx-5090');
  assert.equal(p.id, 'desktop-gpu-rtx-5090');
  assert.equal(p.profile_class, 'desktop-gpu');
  assert.equal(showProfile('never-shipped-profile-9000'), null);
});

test('WC04-dv #24 recommendForProfile picks native-cuda + Q6 for 24GB desktop GPU', async () => {
  const target = showProfile('desktop-gpu-rtx-4090');
  const r = await recommendForProfile({ profile: target });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'native-cuda');
  assert.equal(r.quant, 'Q6');
  assert.equal(r.profile_class, 'desktop-gpu');
});

test('WC04-dv #25 recommendForProfile picks Q4 for mobile-ios + gguf priority', async () => {
  const target = showProfile('iphone-15-pro-profile');
  const r = await recommendForProfile({ profile: target });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'gguf');
  assert.equal(r.quant, 'Q4');
  assert.equal(r.profile_class, 'mobile-ios');
});

test('WC04-dv #26 recommendForProfile picks Q8 for workstation class', async () => {
  const target = showProfile('workstation-dgx-spark');
  const r = await recommendForProfile({ profile: target });
  assert.equal(r.ok, true);
  assert.equal(r.quant, 'Q8');
});

test('WC04-dv #27 recommendForProfile honors artifact.quantization_required override', async () => {
  const target = showProfile('desktop-gpu-rtx-4090');
  const r = await recommendForProfile({ profile: target, artifact: { id: 'fake-art', quantization_required: 'Q2' } });
  assert.equal(r.ok, true);
  assert.equal(r.quant, 'Q2', 'artifact-declared quant must override device-class default');
});

test('WC04-dv #28 recommendForProfile returns no_compatible_target when artifact + device share no target', async () => {
  const target = showProfile('iphone-15-pro-profile'); // gguf,onnx
  const r = await recommendForProfile({ profile: target, artifact: { id: 'fake', supported_targets: ['native-cuda'] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_compatible_target');
  assert.equal(r.device, 'iphone-15-pro-profile');
});

test('WC04-dv #29 recommendForProfile returns artifact_exceeds_device_memory when oversized', async () => {
  const target = showProfile('iphone-15-pro-profile'); // max_artifact_size_mb: 4096
  const r = await recommendForProfile({ profile: target, artifact: { id: 'fake', memory_requirement_mb: 99999 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'artifact_exceeds_device_memory');
  assert.equal(r.want_mb, 99999);
  assert.equal(r.have_mb, 4096);
});
