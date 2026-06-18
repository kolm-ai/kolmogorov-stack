#!/usr/bin/env node
// Run public-agent-benchmark-shaped JSONL rows through the W955 adapter.
//
// This script does not vendor or fetch public suites. It executes a caller's
// local JSONL extract and records whether rows were marked public_data=true.

import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_BENCHMARK_ADAPTER_VERSION,
  loadBenchmarkJsonl,
  runAgentBenchmarkAdapter,
} from '../src/agent-benchmark-adapter.js';

function parseArgs(argv) {
  const out = { _: [] };
  const take = (name) => { out[name] = argv[++i]; };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tasks' || a === '--rows' || a === '--jsonl') take('tasks');
    else if (a === '--endpoint') take('endpoint');
    else if (a === '--consent-token') take('consentToken');
    else if (a === '--consent-statement') take('consentStatement');
    else if (a === '--model') take('model');
    else if (a === '--timeout-ms') take('timeoutMs');
    else if (a === '--out') take('out');
    else if (a === '--summary') out.summary = true;
    else out._.push(a);
  }
  return out;
}

function usage() {
  console.error('usage: node scripts/agent-benchmark-adapter.mjs --tasks <tasks.jsonl> --endpoint <url> --consent-token <t> --consent-statement "<statement naming endpoint>" [--model m] [--timeout-ms 15000] [--summary] [--out run.json]');
  console.error(`spec: ${AGENT_BENCHMARK_ADAPTER_VERSION}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tasks || !args.endpoint || !args.consentToken || !args.consentStatement) usage();
  const file = path.resolve(args.tasks);
  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}`);
    process.exit(2);
  }
  const rows = loadBenchmarkJsonl(file);
  let run;
  try {
    run = await runAgentBenchmarkAdapter({
      rows,
      endpoint: args.endpoint,
      model: args.model,
      timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
      consent: {
        token: args.consentToken,
        statement: args.consentStatement,
        asserted_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error(`agent benchmark adapter refused: ${e.message}${e.code ? ` [${e.code}]` : ''}`);
    process.exitCode = 2;
    return;
  }
  if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(run, null, 2) + '\n');
  if (args.summary) {
    console.log(JSON.stringify({
      spec_version: run.spec_version,
      suites: run.summary.suites,
      public_suites: run.summary.public_suites,
      tasks_run: run.summary.tasks_run,
      attack_success_rate: run.summary.attack_success_rate,
      benign_utility_rate: run.summary.benign_utility_rate,
      fixture_only: run.summary.fixture_only,
      task_digest: run.task_digest,
    }, null, 2));
  } else {
    console.log(JSON.stringify(run, null, 2));
  }
  process.exitCode = run.summary.exposed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(`agent-benchmark-adapter failed: ${e && e.message ? e.message : e}`);
  process.exitCode = 2;
});
