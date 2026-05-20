// W480 - the three modules previously marked roadmap on /research/methods-2026-q2
// ship as orchestration shells. The shell is real Node code; the heavy lifting
// (the actual gradient computation) lives in an external tenant-installed
// trainer the customer plugs in via $KOLM_ONPOLICY_TRAINER /
// $KOLM_PREFERENCE_TRAINER / $KOLM_SPECDECODE_TRAINER. When the trainer is
// absent the shell returns a no_trainer_installed envelope (NEVER silent
// success, NEVER an empty stub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const ONPOL_MOD = path.join(REPO, 'src', 'distill-onpolicy.js');
const PREF_MOD = path.join(REPO, 'src', 'distill-preference.js');
const SPEC_MOD = path.join(REPO, 'src', 'spec-decode.js');

test('1. all three module files exist on disk (no longer roadmap)', () => {
  assert.ok(fs.existsSync(ONPOL_MOD), `missing ${ONPOL_MOD}`);
  assert.ok(fs.existsSync(PREF_MOD), `missing ${PREF_MOD}`);
  assert.ok(fs.existsSync(SPEC_MOD), `missing ${SPEC_MOD}`);
});

test('2. distill-onpolicy.js doctor returns honest envelope when trainer absent', async () => {
  delete process.env.KOLM_ONPOLICY_TRAINER;
  const mod = await import('../src/distill-onpolicy.js?w480_1=' + Date.now());
  const out = mod.doctor();
  assert.strictEqual(out.kind, 'distill_onpolicy');
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.error, 'no_trainer_installed');
  assert.ok(out.install_hint && out.install_hint.includes('$KOLM_ONPOLICY_TRAINER'),
    'install_hint must name the env var');
});

test('3. distill-onpolicy.js trainOnPolicy honest deferral envelope', async () => {
  delete process.env.KOLM_ONPOLICY_TRAINER;
  const mod = await import('../src/distill-onpolicy.js?w480_2=' + Date.now());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w480-onpol-'));
  const pairs = path.join(tmp, 'pairs.jsonl');
  fs.writeFileSync(pairs, '{"prompt":"x","response":"y"}\n');
  const out = mod.trainOnPolicy({
    pairsPath: pairs,
    studentPath: tmp,
    namespace: 'w480-test',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.deferred, true);
  assert.strictEqual(out.error, 'no_trainer_installed');
});

test('4. distill-preference.js exports DPO/SimPO/ORPO/KTO objectives', async () => {
  const mod = await import('../src/distill-preference.js?w480_3=' + Date.now());
  assert.deepStrictEqual(mod.OBJECTIVES, ['dpo', 'simpo', 'orpo', 'kto']);
});

test('5. distill-preference.js doctor returns honest envelope when trainer absent', async () => {
  delete process.env.KOLM_PREFERENCE_TRAINER;
  const mod = await import('../src/distill-preference.js?w480_4=' + Date.now());
  const out = mod.doctor();
  assert.strictEqual(out.kind, 'distill_preference');
  assert.strictEqual(out.ready, false);
  assert.deepStrictEqual(out.objectives, ['dpo', 'simpo', 'orpo', 'kto']);
  assert.ok(out.install_hint.includes('$KOLM_PREFERENCE_TRAINER'));
});

test('6. distill-preference.js rejects unknown objective with structured error', async () => {
  delete process.env.KOLM_PREFERENCE_TRAINER;
  const mod = await import('../src/distill-preference.js?w480_5=' + Date.now());
  const out = mod.trainPreference({
    pairsPath: '/nonexistent',
    studentPath: '/x',
    objective: 'rlhf-fake',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'unknown_objective');
});

test('7. distill-preference.js trainPreference honest deferral envelope', async () => {
  delete process.env.KOLM_PREFERENCE_TRAINER;
  const mod = await import('../src/distill-preference.js?w480_6=' + Date.now());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w480-pref-'));
  const pairs = path.join(tmp, 'pairs.jsonl');
  fs.writeFileSync(pairs, '{"prompt":"x","chosen":"a","rejected":"b"}\n');
  const out = mod.trainPreference({
    pairsPath: pairs,
    studentPath: tmp,
    objective: 'dpo',
    namespace: 'w480-test',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.deferred, true);
  assert.strictEqual(out.error, 'no_trainer_installed');
  assert.strictEqual(out.objective, 'dpo');
});

test('8. spec-decode.js exports EAGLE family + Medusa as supported draft kinds', async () => {
  const mod = await import('../src/spec-decode.js?w480_7=' + Date.now());
  assert.deepStrictEqual(mod.DRAFT_KINDS, ['eagle', 'eagle2', 'eagle3', 'medusa']);
});

test('9. spec-decode.js doctor returns honest envelope when trainer absent', async () => {
  delete process.env.KOLM_SPECDECODE_TRAINER;
  const mod = await import('../src/spec-decode.js?w480_8=' + Date.now());
  const out = mod.doctor();
  assert.strictEqual(out.kind, 'spec_decode');
  assert.strictEqual(out.ready, false);
  assert.deepStrictEqual(out.draft_kinds, ['eagle', 'eagle2', 'eagle3', 'medusa']);
  assert.ok(out.install_hint.includes('$KOLM_SPECDECODE_TRAINER'));
});

test('10. spec-decode.js trainSpecDecode honest deferral envelope', async () => {
  delete process.env.KOLM_SPECDECODE_TRAINER;
  const mod = await import('../src/spec-decode.js?w480_9=' + Date.now());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w480-spec-'));
  const pairs = path.join(tmp, 'pairs.jsonl');
  fs.writeFileSync(pairs, '{"prompt":"x","response":"y"}\n');
  const out = mod.trainSpecDecode({
    pairsPath: pairs,
    basePath: tmp,
    draftKind: 'eagle3',
    namespace: 'w480-test',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.deferred, true);
  assert.strictEqual(out.error, 'no_trainer_installed');
  assert.strictEqual(out.draft_kind, 'eagle3');
});

test('11. all three modules accept $KOLM_*_TRAINER as JSON array of [interpreter, script]', async () => {
  // Smoke test: a JSON-array env var with a real, on-PATH interpreter resolves
  // to ready:true (the interpreter doesn't have to BE the trainer; the shell
  // just needs to find the first arg). On Windows, "node.exe" is reliably
  // present on $PATH for the kolm test runner; on POSIX, "node" is.
  const nodeBin = process.execPath;
  process.env.KOLM_ONPOLICY_TRAINER = JSON.stringify([nodeBin, '-e', 'process.exit(64)']);
  const mod = await import('../src/distill-onpolicy.js?w480_10=' + Date.now());
  const out = mod.doctor();
  assert.strictEqual(out.ready, true, `expected ready:true with env-array trainer; got ${JSON.stringify(out)}`);
  delete process.env.KOLM_ONPOLICY_TRAINER;
});

test('12. router exposes /v1/distill/onpolicy/doctor + /v1/distill/preference/doctor + /v1/spec-decode/doctor', () => {
  const router = fs.readFileSync(path.join(REPO, 'src', 'router.js'), 'utf8');
  assert.ok(router.includes("'/v1/distill/onpolicy/doctor'"), 'router missing /v1/distill/onpolicy/doctor');
  assert.ok(router.includes("'/v1/distill/preference/doctor'"), 'router missing /v1/distill/preference/doctor');
  assert.ok(router.includes("'/v1/spec-decode/doctor'"), 'router missing /v1/spec-decode/doctor');
  assert.ok(router.includes("'/v1/distill/onpolicy'"), 'router missing POST /v1/distill/onpolicy');
  assert.ok(router.includes("'/v1/distill/preference'"), 'router missing POST /v1/distill/preference');
  assert.ok(router.includes("'/v1/spec-decode'"), 'router missing POST /v1/spec-decode');
});

test('13. CLI dispatch wires distill onpolicy + distill preference + spec-decode top-level', () => {
  const cli = fs.readFileSync(path.join(REPO, 'cli', 'kolm.js'), 'utf8');
  assert.ok(cli.includes("'spec-decode': cmdSpecDecode") || cli.includes("case 'spec-decode'"),
    'cli/kolm.js must wire spec-decode top-level dispatch');
  assert.ok(cli.includes('cmdDistillOnPolicy'), 'cli/kolm.js must define cmdDistillOnPolicy');
  assert.ok(cli.includes('cmdDistillPreference'), 'cli/kolm.js must define cmdDistillPreference');
  assert.ok(cli.includes('cmdSpecDecode'), 'cli/kolm.js must define cmdSpecDecode');
});

test('14. methods-2026-q2.html marks all 7 modules as shipped (W480 flip from roadmap)', () => {
  const html = fs.readFileSync(path.join(REPO, 'public', 'research', 'methods-2026-q2.html'), 'utf8');
  const shipped = (html.match(/ships-card shipped/g) || []).length;
  assert.ok(shipped >= 7, `expected >=7 ships-card shipped after W480 flip; got ${shipped}`);
});

test('15. methods-2026-q2.html still surfaces verify-before-ship for genuinely deferred items', () => {
  const html = fs.readFileSync(path.join(REPO, 'public', 'research', 'methods-2026-q2.html'), 'utf8');
  assert.ok(html.includes('verify before ship'),
    'methods-2026-q2.html must keep verify-before-ship annotation on SpQR + Variational Speculative Decoding');
});

test('16. training.html roadmap pills flipped to shipped for the three W480 modules', () => {
  const html = fs.readFileSync(path.join(REPO, 'public', 'training.html'), 'utf8');
  // The three module names must each appear in the table; their status pills must read shipped.
  const modules = ['src/distill-onpolicy.js', 'src/distill-preference.js', 'src/spec-decode.js'];
  for (const m of modules) {
    const idx = html.indexOf(m);
    assert.ok(idx > 0, `training.html must reference ${m}`);
    // The status pill is rendered BEFORE the module name in the same <td>.
    // Look backwards 250 chars from the module name for the pill.
    const window = html.slice(Math.max(0, idx - 250), idx);
    assert.match(window, /<span class="status-pill shipped">shipped<\/span>/,
      `training.html: ${m} must show shipped pill (W480 flip from roadmap)`);
  }
});
