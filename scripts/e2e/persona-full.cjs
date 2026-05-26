#!/usr/bin/env node
// W889-11.1 — Persona "full" driver alias.
//
// The MCD (KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md Part J Block 11) names
// FOUR personas: full, indie, enterprise, no-gpu. W888-H landed indie /
// enterprise / no-gpu as named drivers plus a `full-loop.cjs` that implements
// the BLOCK 11 cross-surface loop. This file exists to give the "full" persona
// a name that matches the {indie,enterprise,no-gpu,full} naming convention,
// so test invariant #3 (`scripts/e2e/persona-{full,indie,enterprise,no-gpu}.cjs`
// all present) is satisfied. It is a passthrough: it re-spawns full-loop.cjs
// with the same argv, then exits with the child's status.
//
// Exit codes match full-loop.cjs (0 pass / 1 fail / 2 env-skip).

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET = path.join(__dirname, 'full-loop.cjs');
const r = spawnSync(process.execPath, [TARGET, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  timeout: 30 * 60 * 1000,
});
process.exit(r.status == null ? 1 : r.status);
