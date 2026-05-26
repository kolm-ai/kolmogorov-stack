#!/usr/bin/env node
// W888-N split-holdout — deterministic train/holdout split of seeds.jsonl.
//
// Splits data/assistant-corpus/seeds.jsonl into:
//   data/assistant-corpus/train-754.jsonl
//   data/assistant-corpus/holdout-200.jsonl
//
// Selection strategy (deterministic, repeatable):
//   1. Group seeds by bucket.
//   2. Per bucket, sort by sha256(seed.id) hex ascending — this gives a
//      stable, pseudo-random order keyed on the seed id, so the split does
//      not depend on file order.
//   3. Take the first ceil(bucket_count * HOLDOUT_FRACTION) seeds per bucket
//      into holdout, leaving the rest as train. HOLDOUT_FRACTION is sized so
//      the global holdout count lands at the per-spec target (200) when the
//      seeds file is the canonical 954 rows — for any other total we keep
//      the same fraction. Counts won't necessarily hit exactly 200 if the
//      input total drifts; the script logs the actual counts and the test
//      asserts the ±20% per-bucket stratification rather than a hard 200.
//
// Flags:
//   --seeds <path>   default data/assistant-corpus/seeds.jsonl
//   --out-train <p>  default data/assistant-corpus/train-754.jsonl
//   --out-hold <p>   default data/assistant-corpus/holdout-200.jsonl
//   --fraction <f>   default 200/954 ~= 0.2096
//   --json           emit a summary envelope to stdout
//   --help

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const SEEDS_DEFAULT = path.join(REPO, 'data', 'assistant-corpus', 'seeds.jsonl');
const TRAIN_DEFAULT = path.join(REPO, 'data', 'assistant-corpus', 'train-754.jsonl');
const HOLD_DEFAULT = path.join(REPO, 'data', 'assistant-corpus', 'holdout-200.jsonl');
const DEFAULT_FRACTION = 200 / 954;

function parseArgs(argv) {
  const out = {
    seeds: SEEDS_DEFAULT,
    outTrain: TRAIN_DEFAULT,
    outHold: HOLD_DEFAULT,
    fraction: DEFAULT_FRACTION,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--seeds') out.seeds = argv[++i];
    else if (a === '--out-train') out.outTrain = argv[++i];
    else if (a === '--out-hold') out.outHold = argv[++i];
    else if (a === '--fraction') out.fraction = Number(argv[++i]);
    else if (a === '--json') out.json = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    'split-holdout — deterministic train/holdout split for assistant seeds.\n' +
    '\n' +
    'usage: node scripts/corpus/split-holdout.cjs [flags]\n' +
    '\n' +
    'flags:\n' +
    '  --seeds <path>      input seeds.jsonl (default: data/assistant-corpus/seeds.jsonl)\n' +
    '  --out-train <path>  train output (default: data/assistant-corpus/train-754.jsonl)\n' +
    '  --out-hold <path>   holdout output (default: data/assistant-corpus/holdout-200.jsonl)\n' +
    '  --fraction <f>      holdout fraction (default: 200/954 ~= 0.2096)\n' +
    '  --json              emit summary envelope to stdout\n' +
    '  --help              show this help\n'
  );
}

function readJsonl(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function writeJsonl(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(p, body);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function split(rows, fraction) {
  // Group by bucket. Each bucket keeps the same fraction so the holdout is
  // stratified — every bucket present in seeds is present in holdout (rounded
  // up so small buckets still contribute at least 1).
  const byBucket = new Map();
  for (const r of rows) {
    const b = r.bucket || 'unknown';
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(r);
  }
  const train = [];
  const hold = [];
  const perBucket = {};
  for (const [bucket, group] of byBucket) {
    // Stable pseudo-random order on sha256(id).
    const sorted = group.slice().sort((a, b) => {
      const ha = sha256(String(a.id || ''));
      const hb = sha256(String(b.id || ''));
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    const want = Math.max(1, Math.ceil(group.length * fraction));
    // Cap holdout-per-bucket at group.length - 1 so train is never empty for
    // tiny buckets.
    const take = Math.min(want, Math.max(1, group.length - 1));
    perBucket[bucket] = { total: group.length, hold: take, train: group.length - take };
    for (let i = 0; i < sorted.length; i++) {
      if (i < take) hold.push(sorted[i]);
      else train.push(sorted[i]);
    }
  }
  return { train, hold, perBucket };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.seeds)) {
    process.stderr.write(`seeds file not found: ${args.seeds}\n`);
    process.exit(2);
  }
  const rows = readJsonl(args.seeds);
  if (rows.length === 0) {
    process.stderr.write(`seeds file is empty: ${args.seeds}\n`);
    process.exit(2);
  }
  const { train, hold, perBucket } = split(rows, args.fraction);
  writeJsonl(args.outTrain, train);
  writeJsonl(args.outHold, hold);
  const summary = {
    ok: true,
    seeds_in: rows.length,
    train_count: train.length,
    holdout_count: hold.length,
    fraction: args.fraction,
    per_bucket: perBucket,
    out_train: path.relative(REPO, args.outTrain).split(path.sep).join('/'),
    out_hold: path.relative(REPO, args.outHold).split(path.sep).join('/'),
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(
      `wrote ${train.length} train rows -> ${args.outTrain}\n` +
      `wrote ${hold.length} holdout rows -> ${args.outHold}\n` +
      `per-bucket: ${JSON.stringify(perBucket)}\n`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { split, readJsonl, writeJsonl, sha256 };
