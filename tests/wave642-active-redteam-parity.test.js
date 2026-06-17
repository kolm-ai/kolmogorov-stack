// W642 - active red-team probe parity.
//
// Pins the closure of the agent-security-eval gap where active evidence could
// upgrade only 5 of the 12 passive core probes. The active battery now mirrors
// the passive generic core suite exactly and bumps its corpus/spec version.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_PROBE_IDS,
  ACTIVE_PROBES,
  ACTIVE_RED_TEAM_SPEC_VERSION,
  buildActiveProbePlan,
} from '../src/active-redteam.js';
import { runRedTeam } from '../src/red-team.js';

test('W642 active probe ids exactly mirror the passive generic core suite', () => {
  const passiveCoreIds = runRedTeam([]).probes.map((p) => p.id);
  assert.equal(ACTIVE_RED_TEAM_SPEC_VERSION, 'asr-active-redteam/0.2');
  assert.equal(ACTIVE_PROBE_IDS.length, 12);
  assert.deepEqual([...ACTIVE_PROBE_IDS], passiveCoreIds);
});

test('W642 each active probe has a frozen prompt-category mapping and generated plan row', () => {
  const plan = buildActiveProbePlan();
  assert.deepEqual(plan.map((p) => p.id), [...ACTIVE_PROBE_IDS]);
  for (const probe of ACTIVE_PROBES) {
    assert.ok(Object.isFrozen(probe), `${probe.id} descriptor is frozen`);
    assert.ok(Object.isFrozen(probe.categories), `${probe.id} categories are frozen`);
    assert.ok(probe.categories.length >= 1, `${probe.id} has an active prompt source`);
    const row = plan.find((p) => p.id === probe.id);
    assert.ok(row && row.prompts.length >= 1, `${probe.id} has generated prompts`);
  }
});
