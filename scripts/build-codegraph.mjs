#!/usr/bin/env node
import path from 'node:path';
import { buildCodeGraph, auditCodeGraph, writeCodeGraph } from '../src/repo-codegraph.js';

const args = process.argv.slice(2);
const root = process.cwd();
const graph = buildCodeGraph({ root });
const audit = auditCodeGraph(graph);
const outFlag = args.indexOf('--out');
if (outFlag >= 0) {
  const out = args[outFlag + 1] || '.kolm/codegraph.json';
  writeCodeGraph(graph, path.resolve(root, out));
}
if (args.includes('--json')) {
  console.log(JSON.stringify({ ok: audit.ok, audit, graph: args.includes('--full') ? graph : undefined }, null, 2));
} else {
  console.log(`codegraph: ok=${audit.ok} files=${graph.counts.files} routes=${graph.counts.routes} symbols=${graph.counts.symbols} scripts=${graph.counts.scripts}`);
  if (!audit.ok) console.log('missing: ' + audit.missing.join(', '));
}
if (args.includes('--check') && !audit.ok) process.exit(1);
