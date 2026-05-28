#!/usr/bin/env node
// scripts/t1-6-recipe-smoke.mjs
//
// T1.6 smoke test — exercises the recipe loader + the kolm distill --recipe verb
// without spawning the actual orchestrator. Covers:
//
//   1. loadRecipe('trinity-2000')      -> ok:true, hash + orchestrator resolved
//   2. listRecipes()                   -> contains trinity-2000, marked valid
//   3. loadRecipe('does-not-exist')    -> ok:false, error='recipe_not_found',
//                                          lists available recipes
//   4. loadRecipe of a malformed file  -> ok:false, error='recipe_invalid',
//                                          issues array describes each failure
//   5. CLI --list-recipes              -> exits 0, output includes trinity-2000
//   6. CLI --recipe trinity-2000 --dry-run -> exits 0, banner has hash + path
//   7. CLI --recipe trinity-2000 --describe -> same as --dry-run
//   8. CLI --recipe nonexistent       -> exits non-zero, error contains 'recipe_not_found'

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRecipe, listRecipes } from '../src/distill-recipe-loader.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(_here, '..');
const KOLM = path.join(REPO, 'cli', 'kolm.js');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') {
  if (cond) ok(label); else bad(label, detail || 'condition false');
}

console.log('T1.6 — recipe loader + CLI verb smoke');

// --- 1. load the canonical recipe -------------------------------------------
const t1 = loadRecipe('trinity-2000');
assert(t1.ok === true, '1: loadRecipe(trinity-2000) ok=true', `got ok=${t1.ok} err=${t1.error || ''}`);
assert(typeof t1.hash === 'string' && t1.hash.startsWith('sha256:'), '1: hash is sha256: prefix', `got ${t1.hash}`);
assert(t1.orchestrator && fs.existsSync(t1.orchestrator), '1: orchestrator resolved + exists', `got ${t1.orchestrator}`);
assert(t1.recipe?.seeds?.target === 2000, '1: seeds.target=2000', `got ${t1.recipe?.seeds?.target}`);
assert(Array.isArray(t1.recipe?.teachers) && t1.recipe.teachers.length === 3, '1: 3 teachers', `got ${t1.recipe?.teachers?.length}`);
assert(t1.recipe?.train?.method === 'qlora', '1: train.method=qlora', `got ${t1.recipe?.train?.method}`);

// --- 2. listRecipes -----------------------------------------------------------
const catalog = listRecipes();
const trinityEntry = catalog.find((r) => r.name === 'trinity-2000');
assert(trinityEntry !== undefined, '2: listRecipes includes trinity-2000');
assert(trinityEntry?.valid === true, '2: trinity-2000 marked valid');
assert(trinityEntry?.target_pairs === 2000, '2: catalog target_pairs=2000');

// --- 3. missing recipe -------------------------------------------------------
const t3 = loadRecipe('does-not-exist-' + Math.random().toString(36).slice(2));
assert(t3.ok === false, '3: missing recipe ok=false');
assert(t3.error === 'recipe_not_found', '3: error=recipe_not_found', `got ${t3.error}`);
assert(Array.isArray(t3.available_recipes) && t3.available_recipes.includes('trinity-2000'),
  '3: available_recipes lists trinity-2000');

// --- 4. malformed recipe -----------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t1-6-'));
const badRecipePath = path.join(tmpDir, 'bad-recipe.json');
fs.writeFileSync(badRecipePath, JSON.stringify({
  // intentionally broken: missing name/version, teachers empty, train missing
  description: 'bad recipe for testing',
  seeds: { target: -1 },         // target must be > 0
  teachers: [],                  // must be non-empty
  scrub: 'not-an-object',        // must be object
  train: { method: 'invalid' },  // bad method, missing required fields
}, null, 2));
const t4 = loadRecipe(badRecipePath);
assert(t4.ok === false, '4: malformed recipe ok=false');
assert(t4.error === 'recipe_invalid', '4: error=recipe_invalid', `got ${t4.error}`);
assert(Array.isArray(t4.issues) && t4.issues.length >= 5,
  '4: at least 5 issues reported', `got ${t4.issues?.length}`);
const issuesJoined = (t4.issues || []).join(' | ');
assert(/seeds\.target/.test(issuesJoined), '4: issues mention seeds.target', issuesJoined.slice(0, 200));
assert(/teachers must be a non-empty array/.test(issuesJoined), '4: issues mention empty teachers');
assert(/train\.method/.test(issuesJoined), '4: issues mention train.method');

// --- 5. CLI --list-recipes ---------------------------------------------------
const r5 = spawnSync(process.execPath, [KOLM, 'distill', '--list-recipes'], { encoding: 'utf8' });
assert(r5.status === 0, '5: CLI --list-recipes exit 0', `status=${r5.status} stderr=${r5.stderr?.slice(0, 200)}`);
assert(/trinity-2000/.test(r5.stdout || ''), '5: CLI --list-recipes output names trinity-2000');
assert(/\[ok\]/.test(r5.stdout || ''), '5: CLI marks trinity-2000 as [ok]');

// --- 6. CLI --recipe trinity-2000 --dry-run ----------------------------------
const r6 = spawnSync(process.execPath, [KOLM, 'distill', '--recipe', 'trinity-2000', '--dry-run'], { encoding: 'utf8' });
assert(r6.status === 0, '6: CLI --recipe trinity-2000 --dry-run exit 0', `status=${r6.status} stderr=${r6.stderr?.slice(0, 200)}`);
assert(/hash:\s+sha256:/.test(r6.stdout || ''), '6: dry-run banner shows hash');
assert(/target_pairs:\s+2000/.test(r6.stdout || ''), '6: dry-run banner shows target_pairs');
assert(/teachers:\s+3/.test(r6.stdout || ''), '6: dry-run banner shows teacher count');

// --- 7. CLI --recipe trinity-2000 --describe ---------------------------------
const r7 = spawnSync(process.execPath, [KOLM, 'distill', '--recipe', 'trinity-2000', '--describe', '--json'], { encoding: 'utf8' });
assert(r7.status === 0, '7: CLI --describe exit 0', `status=${r7.status} stderr=${r7.stderr?.slice(0, 200)}`);
// stdout has the banner + the JSON envelope. Pull the JSON object out.
const jsonStart = (r7.stdout || '').indexOf('{');
let envelope = null;
try { envelope = JSON.parse((r7.stdout || '').slice(jsonStart)); } catch { /* leave null */ }
assert(envelope?.ok === true, '7: --describe --json envelope ok=true');
assert(envelope?.recipe?.name === 'trinity-2000-v2', '7: envelope recipe.name', `got ${envelope?.recipe?.name}`);

// --- 8. CLI --recipe nonexistent --------------------------------------------
const r8 = spawnSync(process.execPath, [KOLM, 'distill', '--recipe', 'does-not-exist-zzz'], { encoding: 'utf8' });
assert(r8.status !== 0, '8: CLI nonexistent recipe exits non-zero', `status=${r8.status}`);
assert(/recipe_not_found/.test(r8.stderr || ''), '8: stderr mentions recipe_not_found', r8.stderr?.slice(0, 200));

// cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
