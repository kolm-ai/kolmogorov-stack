#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  USER_CONTROL_DIMENSIONS,
  accountSectionsBySurface,
  apiRoutesBySurface,
  listProductExperience,
  tuiViews,
  validateProductExperience,
} from '../src/product-experience.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const JOURNEYS_PATH = path.join(ROOT, 'docs', 'product-journeys.json');
const args = process.argv.slice(2);
const wantJson = args.includes('--json');

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function existsRel(p) {
  return fs.existsSync(path.join(ROOT, p));
}

function accountPathExists(urlPath) {
  const clean = String(urlPath).replace(/^https?:\/\/[^/]+/, '').replace(/[#?].*$/, '').replace(/^\/+/, '');
  const candidates = [
    path.join(ROOT, 'public', clean + '.html'),
    path.join(ROOT, 'public', clean, 'index.html'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function routeExists(route, routerText) {
  const parts = String(route).trim().split(/\s+/);
  const maybePath = parts.length > 1 ? parts[1] : parts[0];
  const routePath = maybePath.replace(/:[A-Za-z0-9_]+/g, ':');
  const literal = maybePath.replace(/:[A-Za-z0-9_]+/g, '');
  return routerText.includes(maybePath)
    || routerText.includes(routePath)
    || (literal.length > 4 && routerText.includes(literal));
}

function fail(out, msg) {
  out.ok = false;
  out.failures.push(msg);
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(JOURNEYS_PATH, 'utf8'));
} catch (e) {
  const out = { ok: false, failures: [`cannot parse ${rel(JOURNEYS_PATH)}: ${e.message}`] };
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}

const routerText = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
const out = {
  ok: true,
  failures: [],
  counts: {
    product_surfaces: 0,
    journeys: 0,
    account_links: 0,
    cli_commands: 0,
    tui_views: 0,
    api_routes: 0,
    customization_dimensions: USER_CONTROL_DIMENSIONS.length,
    research_references: 0,
  },
};

const contract = validateProductExperience();
if (!contract.ok) fail(out, 'product-experience contract failed: ' + contract.missing.join(', '));

const surfaces = listProductExperience();
const surfaceIds = new Set(surfaces.map((s) => s.id));
const journeySurfaceIds = new Set();
const accountMap = accountSectionsBySurface();
const apiMap = apiRoutesBySurface();
const viewIds = new Set(tuiViews().map((v) => v.id));
const dimensionIds = new Set(USER_CONTROL_DIMENSIONS.map((d) => d.id));

out.counts.product_surfaces = surfaces.length;
out.counts.account_links = contract.counts.account_links;
out.counts.cli_commands = contract.counts.cli_commands;
out.counts.tui_views = contract.counts.tui_views;
out.counts.api_routes = contract.counts.api_routes;
out.counts.research_references = Array.isArray(doc.research_references) ? doc.research_references.length : 0;

if (doc.schema !== 'kolm-product-journeys-1') fail(out, 'unexpected journey schema');
if (!Array.isArray(doc.global_ux_requirements) || doc.global_ux_requirements.length < 5) fail(out, 'global UX requirements must name the account/CLI/TUI/API/customization contract');
if (!Array.isArray(doc.research_references) || doc.research_references.length < 8) fail(out, 'research references must cover gateway, distill, telemetry, edge, and enterprise sources');
if (!Array.isArray(doc.journeys) || doc.journeys.length < 10) fail(out, 'at least 10 product journeys required');
out.counts.journeys = Array.isArray(doc.journeys) ? doc.journeys.length : 0;

for (const surface of surfaces) {
  for (const p of surface.evidence_paths || []) {
    if (!existsRel(p)) fail(out, `${surface.id}: missing evidence path ${p}`);
  }
  for (const urlPath of surface.account || []) {
    if (!accountPathExists(urlPath)) fail(out, `${surface.id}: missing account/public page for ${urlPath}`);
  }
  for (const view of surface.tui || []) {
    if (!viewIds.has(view)) fail(out, `${surface.id}: unknown TUI view ${view}`);
  }
  for (const route of surface.api || []) {
    if (!routeExists(route, routerText)) fail(out, `${surface.id}: route not found in router.js: ${route}`);
  }
  for (const dim of surface.customization || []) {
    if (!dimensionIds.has(dim)) fail(out, `${surface.id}: unknown customization dimension ${dim}`);
  }
}

for (const journey of doc.journeys || []) {
  if (!journey.id || !/^[a-z0-9-]+$/.test(journey.id)) fail(out, `bad journey id ${journey.id}`);
  if (!surfaceIds.has(journey.surface)) fail(out, `${journey.id}: unknown surface ${journey.surface}`);
  journeySurfaceIds.add(journey.surface);
  if (!journey.user_story || journey.user_story.length < 40) fail(out, `${journey.id}: user_story too thin`);
  for (const field of ['happy_path', 'proof_commands', 'cloud_or_customization', 'evidence_paths']) {
    if (!Array.isArray(journey[field]) || journey[field].length === 0) fail(out, `${journey.id}: missing ${field}`);
  }
  for (const dim of journey.cloud_or_customization || []) {
    if (!dimensionIds.has(dim)) fail(out, `${journey.id}: unknown customization dimension ${dim}`);
  }
  for (const p of journey.evidence_paths || []) {
    if (!existsRel(p)) fail(out, `${journey.id}: missing evidence path ${p}`);
  }
  const surfaceAccount = accountMap[journey.surface] || [];
  const surfaceApi = apiMap[journey.surface] || [];
  if (surfaceAccount.length === 0) fail(out, `${journey.id}: no account paths in product contract`);
  if (surfaceApi.length === 0) fail(out, `${journey.id}: no API paths in product contract`);
}

for (const surfaceId of surfaceIds) {
  if (!journeySurfaceIds.has(surfaceId)) fail(out, `surface missing journey: ${surfaceId}`);
}

for (const required of ['model-provider', 'compute-target', 'storage-plane', 'privacy-mode', 'deployment-mode', 'governance-mode', 'proof-mode']) {
  const used = surfaces.some((s) => (s.customization || []).includes(required))
    && (doc.journeys || []).some((j) => (j.cloud_or_customization || []).includes(required));
  if (!used) fail(out, `customization dimension not surfaced to users: ${required}`);
}

if (wantJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`product journeys: ok=${out.ok} surfaces=${out.counts.product_surfaces} journeys=${out.counts.journeys} account_links=${out.counts.account_links} cli=${out.counts.cli_commands} tui=${out.counts.tui_views} api=${out.counts.api_routes}`);
  for (const failure of out.failures) console.error(' - ' + failure);
}

if (!out.ok) process.exit(1);
