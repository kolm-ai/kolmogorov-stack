// Wave 500 - production compile splits must satisfy the production holdout
// floor when enough reviewed rows exist. A pure probabilistic 80/20 hash split
// can produce 9 holdout rows from 100 examples, which makes verifier reject a
// production_ready artifact even though the corpus is large enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN } from '../src/seeds.js';

function snapEnv() {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_EVENT_STORE_PATH: process.env.KOLM_EVENT_STORE_PATH,
  };
}

function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('W500 - splitDataset enforces train and holdout floors when requested', async () => {
  const saved = snapEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w500-split-floor-'));
  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.KOLM_DATA_DIR = tmp;
    process.env.KOLM_STORE_DRIVER = 'jsonl';
    delete process.env.KOLM_EVENT_STORE_PATH;

    const eventStore = await import('../src/event-store.js');
    if (eventStore._resetForTests) eventStore._resetForTests();
    const { appendEvent } = eventStore;
    const { approveEvent, createDataset, splitDataset } = await import('../src/dataset-workbench.js');

    const namespace = 'w500_floor';
    const tenant = 'tenant_w500_floor';
    for (let i = 0; i < 100; i++) {
      const id = `evt_w500_${i}`;
      await appendEvent({
        event_id: id,
        tenant_id: tenant,
        namespace,
        prompt_redacted: `classify event ${i}`,
        response_redacted: i % 2 === 0 ? 'alpha' : 'beta',
        source_type: 'real',
        created_at: new Date(1_800_000_000_000 + i).toISOString(),
      });
      await approveEvent(id, { tenant_id: tenant, reviewer: 'w500' });
    }

    const ds = await createDataset(namespace, {
      tenant_id: tenant,
      approvedOnly: true,
      seed: 500,
      min_train: MIN_PRODUCTION_TRAIN,
      min_holdout: MIN_PRODUCTION_HOLDOUT,
    });
    assert.ok(ds.train_count >= MIN_PRODUCTION_TRAIN);
    assert.ok(ds.holdout_count >= MIN_PRODUCTION_HOLDOUT);

    for (let seed = 0; seed < 50; seed++) {
      const split = await splitDataset(ds.dataset_id, 0.8, {
        seed,
        min_train: MIN_PRODUCTION_TRAIN,
        min_holdout: MIN_PRODUCTION_HOLDOUT,
      });
      assert.ok(split.train_count >= MIN_PRODUCTION_TRAIN, `seed ${seed} train floor`);
      assert.ok(split.holdout_count >= MIN_PRODUCTION_HOLDOUT, `seed ${seed} holdout floor`);
      assert.equal(split.train_count + split.holdout_count, 100);
      const train = new Set(split.train_ids);
      for (const id of split.holdout_ids) assert.equal(train.has(id), false);
    }
  } finally {
    restoreEnv(saved);
  }
});
