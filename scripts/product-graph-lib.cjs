'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function countStatuses(readinessDoc) {
  const counts = {};
  for (const group of readinessDoc.surfaces || []) {
    for (const req of group.requirements || []) {
      counts[req.status] = (counts[req.status] || 0) + 1;
    }
  }
  return counts;
}

function requirementIndex(readinessDoc, kernel) {
  const out = {};
  for (const group of readinessDoc.surfaces || []) {
    for (const req of group.requirements || []) {
      out[req.id] = {
        id: req.id,
        group_id: group.id,
        priority: req.priority,
        title: req.title,
        status: req.status,
        claim_scope: kernel.readinessClaimScope(req.status),
        evidence_paths: (req.evidence_paths || []).slice(),
      };
    }
  }
  return out;
}

function surfaceRequirementIds(surface, reqById) {
  const refs = new Set();
  const haystack = [
    ...(surface.code_paths || []),
    ...(surface.doc_paths || []),
    ...(surface.route_groups || []),
    surface.id,
    surface.name,
    surface.promise,
  ].join(' ').toLowerCase();
  for (const req of Object.values(reqById)) {
    const reqText = [req.id, req.group_id, req.title, ...(req.evidence_paths || [])].join(' ').toLowerCase();
    if (req.evidence_paths.some((p) => haystack.includes(String(p).toLowerCase())) ||
        reqText.includes(surface.id) ||
        haystack.includes(req.group_id)) {
      refs.add(req.id);
    }
  }
  return Array.from(refs).sort();
}

async function importEsm(root, rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

async function buildProductGraph(root) {
  const surfacesDoc = readJson(path.join(root, 'docs', 'product-surfaces.json'));
  const journeysDoc = readJson(path.join(root, 'docs', 'product-journeys.json'));
  const readinessDoc = readJson(path.join(root, 'docs', 'product-sota-readiness.json'));
  const apiRoutes = readJson(path.join(root, 'public', 'docs', 'api-routes.json'));
  const experience = await importEsm(root, 'src/product-experience.js');
  const kernel = await importEsm(root, 'src/product-kernel.js');
  const reqById = requirementIndex(readinessDoc, kernel);
  const routeCounts = new Map((apiRoutes.groups || []).map((g) => [g.key, (g.routes || []).length]));
  const experienceRows = experience.listProductExperience();
  const experienceById = new Map(experienceRows.map((row) => [row.id, row]));

  const routeSurfaces = (surfacesDoc.surfaces || []).map((surface) => {
    const route_groups = (surface.route_groups || []).map((group) => ({
      id: group,
      routes: routeCounts.get(group) || 0,
    }));
    const status = surface.status || 'implemented';
    return {
      id: surface.id,
      name: surface.name,
      promise: surface.promise,
      status,
      claim_scope: kernel.readinessClaimScope(status),
      route_groups,
      routes: route_groups.reduce((sum, row) => sum + row.routes, 0),
      primary_paths: (surface.primary_paths || []).slice(),
      code_paths: (surface.code_paths || []).slice(),
      doc_paths: (surface.doc_paths || []).slice(),
      competitor_refs: (surface.competitor_refs || []).slice(),
      readiness_requirement_ids: surfaceRequirementIds(surface, reqById),
      production_smoke: (surface.production_smoke || []).map((probe) => ({
        id: probe.id,
        method: probe.method,
        path: probe.path,
        auth: probe.auth,
        mode: probe.mode,
        expect: (probe.expect || []).slice(),
        checks: (probe.checks || []).slice(),
      })),
    };
  });

  const journeys = (journeysDoc.journeys || []).map((journey) => {
    const exp = experienceById.get(journey.id) || experienceById.get(journey.surface) || null;
    return {
      id: journey.id,
      surface: journey.surface,
      name: exp ? exp.name : journey.id,
      stage: exp ? exp.stage : null,
      user_story: journey.user_story,
      happy_path: (journey.happy_path || []).slice(),
      proof_commands: (journey.proof_commands || []).slice(),
      customization_dimensions: (journey.cloud_or_customization || []).slice(),
      account: exp ? exp.account.slice() : [],
      cli: exp ? exp.cli.slice() : [],
      tui: exp ? exp.tui.slice() : [],
      api: exp ? exp.api.slice() : [],
      status_fields: exp ? exp.status_fields.slice() : [],
      evidence_paths: (journey.evidence_paths || []).slice(),
      ux_contract: exp ? exp.ux_contract.slice() : [],
      next_actions: exp ? [
        { kind: 'account', label: exp.primary_action, value: exp.account[0] || '/', href: exp.account[0] || '/', priority: 'P0' },
        { kind: 'command', label: exp.empty_state_action, value: exp.cli[0] || 'kolm status', priority: 'P1' },
      ] : [],
    };
  });

  const readinessGroups = (readinessDoc.surfaces || []).map((group) => ({
    id: group.id,
    requirements: (group.requirements || []).map((req) => reqById[req.id]),
  }));

  const graph = {
    schema: kernel.PRODUCT_GRAPH_SCHEMA,
    kernel_version: kernel.PRODUCT_KERNEL_VERSION,
    source_docs: {
      product_surfaces: 'docs/product-surfaces.json',
      product_journeys: 'docs/product-journeys.json',
      product_sota_readiness: 'docs/product-sota-readiness.json',
      product_experience: 'src/product-experience.js',
    },
    definition: {
      category: surfacesDoc.category_definition || 'Kolm is the verifiable AI compiler and artifact contract layer.',
      spine: 'evidence -> dataset -> eval -> build decision -> artifact -> runtime -> receipt -> governance export',
    },
    counts: {
      route_surfaces: routeSurfaces.length,
      journeys: journeys.length,
      readiness_groups: readinessGroups.length,
      readiness_requirements: Object.keys(reqById).length,
      route_groups: routeCounts.size,
      routes: Array.from(routeCounts.values()).reduce((sum, n) => sum + n, 0),
      account_links: experienceRows.reduce((sum, row) => sum + (row.account || []).length, 0),
      cli_commands: experienceRows.reduce((sum, row) => sum + (row.cli || []).length, 0),
      tui_views: experience.tuiViews().length,
      api_routes: experienceRows.reduce((sum, row) => sum + (row.api || []).length, 0),
      customization_dimensions: experience.USER_CONTROL_DIMENSIONS.length,
    },
    readiness_counts: countStatuses(readinessDoc),
    dimensions: experience.USER_CONTROL_DIMENSIONS.map((row) => ({
      id: row.id,
      label: row.label,
      options: (row.options || []).slice(),
      required_affordance: row.required_affordance,
    })),
    kernel: kernel.kernelCatalog(),
    route_surfaces: routeSurfaces,
    journeys,
    readiness_groups: readinessGroups,
    references: {
      surface_research: surfacesDoc.research_references || [],
      journey_research: journeysDoc.research_references || [],
    },
  };

  return graph;
}

module.exports = {
  buildProductGraph,
  stableStringify,
};
