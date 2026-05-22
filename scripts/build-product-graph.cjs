#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildProductGraph, stableStringify } = require('./product-graph-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'product-graph.json');
const args = process.argv.slice(2);

async function main() {
  const graph = await buildProductGraph(ROOT);
  const body = stableStringify(graph);
  if (args.includes('--check')) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('product-graph: public/product-graph.json is out of date');
      process.exit(1);
    }
    console.log(`product-graph: ok journeys=${graph.counts.journeys} route_surfaces=${graph.counts.route_surfaces} requirements=${graph.counts.readiness_requirements}`);
    return;
  }
  fs.writeFileSync(OUT, body);
  console.log(`product-graph: wrote ${path.relative(ROOT, OUT).replace(/\\/g, '/')} journeys=${graph.counts.journeys} route_surfaces=${graph.counts.route_surfaces} requirements=${graph.counts.readiness_requirements}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
