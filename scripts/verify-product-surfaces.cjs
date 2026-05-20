#!/usr/bin/env node
// Product-surface contract gate.
//
// This is not a unit test. It is the source-of-truth guard that prevents the
// codebase from accumulating undocumented product promises or orphan route
// families. If a route group exists, exactly one product surface must own it,
// name the competitor context, name the code/docs, and define local/prod gates.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'docs', 'product-surfaces.json');
const API_ROUTES_PATH = path.join(ROOT, 'public', 'docs', 'api-routes.json');
const LOCAL_SURFACE_SMOKE = 'scripts/local-surface-smoke.cjs';

const ALLOWED_STATUSES = new Set([
  'certified',
  'needs-prod-smoke',
  'needs-upgrade',
  'blocked-prod-auth',
  'blocked-local-and-prod',
  'blocked',
]);
const ALLOWED_SMOKE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_SMOKE_AUTH = new Set(['none', 'optional', 'required']);
const ALLOWED_SMOKE_MODES = new Set(['safe', 'deep']);

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function repoExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function wildcardExists(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized.includes('*')) return repoExists(normalized);
  const dir = path.dirname(normalized);
  const base = path.basename(normalized);
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) return false;
  const rx = new RegExp('^' + base.split('*').map(escapeRegex).join('.*') + '$');
  return fs.readdirSync(absDir).some((name) => rx.test(name));
}

function escapeRegex(s) {
  return String(s).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function fail(failures, code, detail, extra = {}) {
  failures.push({ code, detail, ...extra });
}

function main() {
  const wantJson = process.argv.includes('--json');
  const catalog = loadJson(CATALOG_PATH);
  const api = loadJson(API_ROUTES_PATH);
  const failures = [];
  const warnings = [];

  if (catalog.schema !== 'kolm-product-surface-catalog-1') {
    fail(failures, 'bad_schema', 'docs/product-surfaces.json has an unknown schema');
  }
  if (!Array.isArray(catalog.research_references) || catalog.research_references.length < 10) {
    fail(failures, 'weak_research_register', 'expected at least 10 research references');
  }
  if (!catalog.human_spec_path || !repoExists(catalog.human_spec_path)) {
    fail(failures, 'missing_human_spec', 'catalog.human_spec_path must point at an existing product surface spec document');
  }
  if (!repoExists(LOCAL_SURFACE_SMOKE)) {
    fail(failures, 'missing_local_surface_smoke', `${LOCAL_SURFACE_SMOKE} must exist`);
  }
  if (!Array.isArray(catalog.surfaces) || catalog.surfaces.length === 0) {
    fail(failures, 'no_surfaces', 'expected at least one product surface');
  }

  const refs = new Set();
  for (const ref of catalog.research_references || []) {
    if (!ref.id) fail(failures, 'reference_missing_id', 'research reference is missing id', { ref });
    if (refs.has(ref.id)) fail(failures, 'duplicate_reference', `duplicate research reference id ${ref.id}`);
    refs.add(ref.id);
    if (!/^https?:\/\//.test(String(ref.url || ''))) {
      fail(failures, 'reference_missing_url', `research reference ${ref.id || '(missing)'} has no http(s) url`);
    }
    if (!ref.state_of_art_signal) {
      fail(failures, 'reference_missing_signal', `research reference ${ref.id || '(missing)'} has no state_of_art_signal`);
    }
  }

  const apiGroups = new Map((api.groups || []).map((g) => [g.key, (g.routes || []).length]));
  const surfaceIds = new Set();
  const groupOwners = new Map();
  const surfaceSummaries = [];

  for (const surface of catalog.surfaces || []) {
    if (!surface.id) fail(failures, 'surface_missing_id', 'surface is missing id', { surface });
    if (surfaceIds.has(surface.id)) fail(failures, 'duplicate_surface', `duplicate surface id ${surface.id}`);
    surfaceIds.add(surface.id);

    for (const field of ['name', 'promise', 'status']) {
      if (!surface[field]) fail(failures, 'surface_missing_field', `${surface.id || '(missing)'} missing ${field}`);
    }
    if (!ALLOWED_STATUSES.has(surface.status)) {
      fail(failures, 'surface_bad_status', `${surface.id} has unsupported status ${surface.status}`);
    }
    for (const field of ['route_groups', 'primary_paths', 'code_paths', 'doc_paths', 'competitor_refs', 'optimal_spec', 'production_smoke']) {
      if (!Array.isArray(surface[field]) || surface[field].length === 0) {
        fail(failures, 'surface_empty_array', `${surface.id} has empty ${field}`);
      }
    }
    if (!surface.certification || typeof surface.certification !== 'object') {
      fail(failures, 'surface_missing_certification', `${surface.id} missing certification`);
    } else {
      for (const field of ['local_gates', 'prod_gates']) {
        if (!Array.isArray(surface.certification[field]) || surface.certification[field].length === 0) {
          fail(failures, 'surface_missing_cert_field', `${surface.id} certification.${field} is empty`);
        }
      }
      if (!Array.isArray(surface.certification.blockers)) {
        fail(failures, 'surface_missing_cert_field', `${surface.id} certification.blockers must be an array`);
      }
      if (surface.status !== 'certified' && surface.certification.blockers.length === 0) {
        fail(failures, 'surface_missing_cert_field', `${surface.id} non-certified surfaces must name at least one blocker`);
      }
      if (!Array.isArray(surface.certification.local_gates) ||
          !surface.certification.local_gates.some((gate) => String(gate).includes(LOCAL_SURFACE_SMOKE))) {
        fail(failures, 'surface_missing_local_smoke_gate', `${surface.id} certification.local_gates must include ${LOCAL_SURFACE_SMOKE}`);
      }
      if (!surface.certification.slo) {
        fail(failures, 'surface_missing_slo', `${surface.id} certification.slo is missing`);
      }
    }
    if ((surface.optimal_spec || []).length < 3) {
      fail(failures, 'surface_weak_spec', `${surface.id} needs at least 3 optimal_spec bullets`);
    }
    let hasSafeSmoke = false;
    let hasAuthSmoke = false;
    const smokeIds = new Set();
    for (const probe of surface.production_smoke || []) {
      if (!probe || typeof probe !== 'object') {
        fail(failures, 'surface_bad_smoke_probe', `${surface.id} has a non-object production_smoke probe`);
        continue;
      }
      if (!probe.id) {
        fail(failures, 'surface_smoke_missing_id', `${surface.id} has a production_smoke probe without id`);
      } else if (smokeIds.has(probe.id)) {
        fail(failures, 'surface_smoke_duplicate_id', `${surface.id} has duplicate production_smoke id ${probe.id}`);
      } else {
        smokeIds.add(probe.id);
      }
      const method = String(probe.method || '').toUpperCase();
      if (!ALLOWED_SMOKE_METHODS.has(method)) {
        fail(failures, 'surface_smoke_bad_method', `${surface.id}/${probe.id || '(missing)'} has unsupported method ${probe.method}`);
      }
      if (!String(probe.path || '').startsWith('/')) {
        fail(failures, 'surface_smoke_bad_path', `${surface.id}/${probe.id || '(missing)'} path must start with /`);
      }
      if (!ALLOWED_SMOKE_AUTH.has(probe.auth)) {
        fail(failures, 'surface_smoke_bad_auth', `${surface.id}/${probe.id || '(missing)'} auth must be none, optional, or required`);
      }
      if (!ALLOWED_SMOKE_MODES.has(probe.mode)) {
        fail(failures, 'surface_smoke_bad_mode', `${surface.id}/${probe.id || '(missing)'} mode must be safe or deep`);
      }
      if (!Array.isArray(probe.expect) || probe.expect.length === 0 || probe.expect.some((n) => !Number.isInteger(n))) {
        fail(failures, 'surface_smoke_bad_expect', `${surface.id}/${probe.id || '(missing)'} expect must be a non-empty integer status array`);
      }
      if (!Array.isArray(probe.checks) || probe.checks.length === 0) {
        fail(failures, 'surface_smoke_missing_checks', `${surface.id}/${probe.id || '(missing)'} checks must be non-empty`);
      }
      if (probe.mode === 'safe') hasSafeSmoke = true;
      if (probe.auth === 'required') hasAuthSmoke = true;
    }
    if (!hasSafeSmoke) {
      fail(failures, 'surface_missing_safe_smoke', `${surface.id} must include at least one safe production smoke probe`);
    }
    if (surface.id !== 'public-docs-sdk' && !hasAuthSmoke) {
      fail(failures, 'surface_missing_auth_smoke', `${surface.id} must include at least one required-auth production smoke probe`);
    }

    let routes = 0;
    for (const group of surface.route_groups || []) {
      if (!apiGroups.has(group)) {
        fail(failures, 'unknown_route_group', `${surface.id} owns route group ${group}, but api-routes.json does not contain it`);
        continue;
      }
      routes += apiGroups.get(group);
      if (groupOwners.has(group)) {
        fail(failures, 'duplicate_route_group_owner', `${group} is owned by both ${groupOwners.get(group)} and ${surface.id}`);
      }
      groupOwners.set(group, surface.id);
    }

    for (const refId of surface.competitor_refs || []) {
      if (!refs.has(refId)) fail(failures, 'unknown_competitor_ref', `${surface.id} references unknown competitor/research ref ${refId}`);
    }
    for (const docPath of surface.doc_paths || []) {
      if (!repoExists(docPath)) fail(failures, 'missing_doc_path', `${surface.id} doc path does not exist: ${docPath}`);
    }
    for (const codePath of surface.code_paths || []) {
      if (!wildcardExists(codePath)) fail(failures, 'missing_code_path', `${surface.id} code path does not exist: ${codePath}`);
    }

    surfaceSummaries.push({
      id: surface.id,
      status: surface.status,
      route_groups: (surface.route_groups || []).length,
      routes,
      competitor_refs: (surface.competitor_refs || []).length,
      blockers: surface.certification && surface.certification.blockers ? surface.certification.blockers.length : 0,
      smoke_probes: (surface.production_smoke || []).length,
      deep_smoke_probes: (surface.production_smoke || []).filter((p) => p.mode === 'deep').length,
    });
  }

  const missingGroups = [];
  for (const group of apiGroups.keys()) {
    if (!groupOwners.has(group)) missingGroups.push(group);
  }
  if (missingGroups.length) {
    fail(failures, 'unowned_route_groups', `${missingGroups.length} route group(s) have no product surface owner`, { groups: missingGroups });
  }

  const totalCatalogRoutes = surfaceSummaries.reduce((sum, s) => sum + s.routes, 0);
  const totalApiRoutes = Array.from(apiGroups.values()).reduce((sum, n) => sum + n, 0);
  if (totalCatalogRoutes !== totalApiRoutes) {
    fail(failures, 'route_count_mismatch', `catalog maps ${totalCatalogRoutes} routes, api-routes has ${totalApiRoutes}`);
  }
  if ((catalog.surfaces || []).some((s) => s.status && s.status.startsWith('blocked'))) {
    warnings.push({
      code: 'blocked_surfaces_present',
      detail: 'Some product surfaces are explicitly blocked. This is truthful, but not final-state certification.',
    });
  }

  const result = {
    ok: failures.length === 0,
    catalog: path.relative(ROOT, CATALOG_PATH).replace(/\\/g, '/'),
    api_routes: path.relative(ROOT, API_ROUTES_PATH).replace(/\\/g, '/'),
    human_spec: catalog.human_spec_path || null,
    updated_at: catalog.updated_at,
    surfaces: surfaceSummaries.length,
    research_references: refs.size,
    route_groups: apiGroups.size,
    routes: totalApiRoutes,
    mapped_routes: totalCatalogRoutes,
    failures,
    warnings,
    surface_summaries: surfaceSummaries,
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    process.stdout.write(
      `product-surfaces: ok surfaces=${result.surfaces} route_groups=${result.route_groups} routes=${result.routes} research_refs=${result.research_references}` +
      (warnings.length ? ` warnings=${warnings.length}` : '') +
      '\n'
    );
    for (const s of surfaceSummaries) {
      process.stdout.write(`  ${s.id}: ${s.routes} routes / ${s.route_groups} groups / ${s.smoke_probes} prod probes / status=${s.status}\n`);
    }
    if (warnings.length) {
      for (const w of warnings) process.stdout.write(`  warn ${w.code}: ${w.detail}\n`);
    }
  } else {
    process.stderr.write(`product-surfaces: FAIL (${failures.length} failure(s))\n`);
    for (const f of failures) process.stderr.write(`  ${f.code}: ${f.detail}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

main();
