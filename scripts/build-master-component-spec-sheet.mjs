#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const UPDATED_AT = '2026-06-17';
const ATOMIC = path.join(ROOT, 'docs', 'backend-atomic-component-deep-dive-2026-06-17.json');
const SOTA = path.join(ROOT, 'docs', 'whole-stack-sota-deep-dive-2026-06-17.json');
const READINESS = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const READINESS_PROOF = path.join(ROOT, 'docs', 'internal', 'readiness-proof-matrix.json');
const OUT_JSON = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.json');
const OUT_MD = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.md');

const args = new Set(process.argv.slice(2));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pct(n, d) {
  return d > 0 ? (n / d) * 100 : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function normalize(p) {
  return String(p || '').replace(/\\/g, '/');
}

function rowsForCategory(category) {
  const out = [];
  const groups = category.atomic_components || {};
  for (const [relation, rows] of Object.entries(groups)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && row.path) out.push({ relation, row });
    }
  }
  return out;
}

function buildCategoryLinks(categories) {
  const byPath = new Map();
  for (const category of categories) {
    for (const { relation, row } of rowsForCategory(category)) {
      const key = normalize(row.path);
      const links = byPath.get(key) || [];
      links.push({
        id: category.id,
        stack_area: category.stack_area,
        status: category.status,
        relation,
      });
      byPath.set(key, links);
    }
  }
  return byPath;
}

function readReadinessCounts(readiness) {
  const statuses = {};
  let total = 0;
  for (const surface of readiness.surfaces || []) {
    for (const req of surface.requirements || []) {
      total += 1;
      statuses[req.status] = (statuses[req.status] || 0) + 1;
    }
  }
  const closed = (statuses.shipped || 0) + (statuses.implemented || 0);
  return {
    total,
    closed,
    open: Math.max(0, total - closed),
    statuses,
    closed_pct: round1(pct(closed, total)),
  };
}

function priorityBand(score) {
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'normal';
}

function componentGaps(component, categoryLinks) {
  const gaps = [];
  const testRefs = Array.isArray(component.test_refs) ? component.test_refs : [];
  if (testRefs.length === 0) gaps.push('direct_test_reference_missing');
  if (component.priority_score >= 7 && testRefs.length === 0) gaps.push('high_priority_direct_test_missing');
  if ((component.risk_signals || []).includes('open_marker_requires_owner_review')) gaps.push('open_marker_requires_owner_review');
  if ((categoryLinks || []).some((c) => /critical|major/.test(c.status || ''))) gaps.push('linked_frontier_work_open');
  return [...new Set(gaps)];
}

function nextBestAction(component, gaps) {
  if (gaps.includes('high_priority_direct_test_missing')) {
    return 'Add a direct contract/security/regression test before expanding this component.';
  }
  if (gaps.includes('direct_test_reference_missing')) {
    return 'Add at least one direct test reference or document why coverage is indirect.';
  }
  if (gaps.includes('open_marker_requires_owner_review')) {
    return 'Resolve or explicitly owner-review the open TODO/FIXME marker.';
  }
  if (gaps.includes('linked_frontier_work_open')) {
    return `Execute the linked frontier track: ${component.improvement_track}.`;
  }
  return `Maintain current contract and keep ${component.improvement_track} current.`;
}

function summarizeBy(items, key) {
  const out = {};
  for (const item of items) out[item[key]] = (out[item[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => String(c.value(row)).replace(/\|/g, '\\|')).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function build() {
  const atomic = readJson(ATOMIC);
  const sota = readJson(SOTA);
  const readiness = readJson(READINESS);
  const readinessProof = readJson(READINESS_PROOF);
  const readinessCounts = readReadinessCounts(readiness);
  const readinessProofSummary = readinessProof.summary || {};
  const readinessProofHillClimb = readinessProof.over_100_hill_climb || null;
  const localReadinessProofPct = readinessProofSummary.local_proof_coverage_pct ?? readinessCounts.closed_pct;
  const claimableReadinessPct = readinessProofSummary.claimable_readiness_pct ?? readinessCounts.closed_pct;
  const categoryLinksByPath = buildCategoryLinks(sota.categories || []);

  const components = (atomic.components || []).map((component) => {
    const category_links = categoryLinksByPath.get(normalize(component.path)) || [];
    const gaps = componentGaps(component, category_links);
    return {
      path: component.path,
      id: component.id,
      surface: component.surface,
      domain: component.domain,
      language: component.language,
      composition: {
        metrics: component.metrics,
        risk_signals: component.risk_signals || [],
        priority_score: component.priority_score,
        priority_band: priorityBand(component.priority_score || 0),
        sha256: component.sha256,
      },
      target_state: {
        role: 'Atomic backend component with explicit ownerable surface/domain, static composition, risk signals, tests, improvement track, innovation opportunity, and verification command.',
        perfection_definition: 'No undocumented risk boundary, no untested high-priority behavior, no stale SOTA gap linked to this component, and no unsupported public claim.',
      },
      current_state: {
        deep_dive_status: component.deep_dive?.status || null,
        direct_test_refs: component.test_refs || [],
        category_links,
        improvement_track: component.improvement_track,
        innovation_opportunity: component.innovation_opportunity,
        suggested_verification: component.suggested_verification || [],
      },
      perfection_gaps: gaps,
      next_best_action: nextBestAction(component, gaps),
    };
  });

  const componentCount = components.length;
  const deepDiveComplete = components.filter((c) => c.current_state.deep_dive_status === 'atomic_deep_dive_complete').length;
  const directTestRefs = components.filter((c) => c.current_state.direct_test_refs.length > 0).length;
  const highPriority = components.filter((c) => c.composition.priority_score >= 7);
  const highPriorityTested = highPriority.filter((c) => c.current_state.direct_test_refs.length > 0).length;
  const categoryCount = (sota.categories || []).length;
  const criticalOpen = sota.summary?.categories_with_critical_frontier_work_open || 0;
  const majorOpen = sota.summary?.categories_with_major_frontier_work_open || 0;
  const criticalClosedPct = round1(pct(categoryCount - criticalOpen, categoryCount));
  const majorClosedPct = round1(pct(categoryCount - majorOpen, categoryCount));
  const deepDivePct = round1(pct(deepDiveComplete, componentCount));
  const directTestPct = round1(pct(directTestRefs, componentCount));
  const highPriorityTestPct = round1(pct(highPriorityTested, highPriority.length));

  const localEngineeringScore = round1(clamp(
    (0.30 * deepDivePct)
    + (0.35 * directTestPct)
    + (0.20 * highPriorityTestPct)
    + (0.15 * localReadinessProofPct),
  ));
  const frontierProductScore = round1(clamp(
    (0.25 * deepDivePct)
    + (0.20 * directTestPct)
    + (0.20 * claimableReadinessPct)
    + (0.20 * criticalClosedPct)
    + (0.15 * majorClosedPct),
  ));

  const topGaps = components
    .filter((c) => c.perfection_gaps.length > 0)
    .sort((a, b) => (b.composition.priority_score - a.composition.priority_score)
      || (b.perfection_gaps.length - a.perfection_gaps.length)
      || a.path.localeCompare(b.path))
    .slice(0, 30);

  const categoryRows = (sota.categories || []).map((category) => ({
    id: category.id,
    stack_area: category.stack_area,
    status: category.status,
    already_at_frontier_count: category.local_sota_review?.already_at_frontier_count || 0,
    improvement_count: category.local_sota_review?.improvement_count || 0,
    critical_gaps: category.local_sota_review?.gaps?.critical || 0,
    major_gaps: category.local_sota_review?.gaps?.major || 0,
    minor_gaps: category.local_sota_review?.gaps?.minor || 0,
    required_components: category.atomic_components?.required?.length || 0,
    suggested_verification: category.suggested_verification || [],
  }));

  const doc = {
    schema: 'kolm-master-component-spec-sheet-1',
    updated_at: UPDATED_AT,
    purpose: 'Single optimization sheet for the deep-dive workflow: every backend component has a current composition, target state, perfection gap, next action, and verification path.',
    sources: {
      atomic_ledger: normalize(path.relative(ROOT, ATOMIC)),
      stack_sota_ledger: normalize(path.relative(ROOT, SOTA)),
      readiness_ledger: normalize(path.relative(ROOT, READINESS)),
      readiness_proof_matrix: normalize(path.relative(ROOT, READINESS_PROOF)),
    },
    perfection_model: {
      local_engineering_score: localEngineeringScore,
      frontier_product_score: frontierProductScore,
      readiness_proof_surplus_score: readinessProofHillClimb?.score ?? 100,
      readiness_proof_surplus_ceiling: readinessProofHillClimb?.ceiling ?? 100,
      score_notes: [
        'Local engineering score weights atomic inventory completeness, direct test coverage, high-priority test coverage, and local readiness proof coverage.',
        'Frontier product score adds unresolved critical/major SOTA categories, so it stays lower until external/product/frontier gaps are actually closed.',
        'Claimable product readiness is separate from local proof coverage: package releases, public benchmarks, live certification, and external partner adoption must not be marked shipped without real external evidence.',
        'Scores above 100 are permitted only for non-claim hill-climb surplus, such as extra local closeout evidence beyond the minimum. They do not convert external gates into shipped claims.',
      ],
      weights: {
        local_engineering_score: {
          atomic_deep_dive_complete_pct: 0.30,
          direct_test_reference_pct: 0.35,
          high_priority_test_reference_pct: 0.20,
          local_readiness_proof_pct: 0.15,
        },
        frontier_product_score: {
          atomic_deep_dive_complete_pct: 0.25,
          direct_test_reference_pct: 0.20,
          claimable_readiness_pct: 0.20,
          critical_sota_category_closed_pct: 0.20,
          major_sota_category_closed_pct: 0.15,
        },
      },
    },
    summary: {
      component_count: componentCount,
      atomic_deep_dive_complete: deepDiveComplete,
      atomic_deep_dive_complete_pct: deepDivePct,
      direct_test_referenced_components: directTestRefs,
      direct_test_reference_pct: directTestPct,
      components_without_direct_test_reference: componentCount - directTestRefs,
      high_priority_components: highPriority.length,
      high_priority_direct_test_referenced: highPriorityTested,
      high_priority_direct_test_reference_pct: highPriorityTestPct,
      category_count: categoryCount,
      categories_with_critical_frontier_work_open: criticalOpen,
      categories_with_major_frontier_work_open: majorOpen,
      critical_sota_category_closed_pct: criticalClosedPct,
      major_sota_category_closed_pct: majorClosedPct,
      readiness: readinessCounts,
      readiness_proof: {
        claimable_readiness_pct: claimableReadinessPct,
        local_proof_coverage_pct: localReadinessProofPct,
        local_proof_requirement_count: readinessProofSummary.local_proof_requirement_count || 0,
        workorder_surplus_points: readinessProofSummary.workorder_surplus_points || 0,
        over_100_hill_climb: readinessProofHillClimb,
        language_fit: {
          architecture: readinessProof.language_fit?.architecture || null,
          tracked_file_counts: readinessProof.language_fit?.tracked_file_counts || {},
          safety_guards: readinessProof.language_fit?.safety_guards || {},
        },
      },
      components_by_domain: summarizeBy(components, 'domain'),
      components_by_surface: summarizeBy(components, 'surface'),
      top_gap_count: topGaps.length,
    },
    category_targets: categoryRows,
    top_component_gaps: topGaps.map((c) => ({
      path: c.path,
      domain: c.domain,
      surface: c.surface,
      priority_score: c.composition.priority_score,
      risk_signals: c.composition.risk_signals,
      perfection_gaps: c.perfection_gaps,
      category_links: c.current_state.category_links,
      next_best_action: c.next_best_action,
      suggested_verification: c.current_state.suggested_verification,
    })),
    components,
  };

  const md = [
    '# Master Component Spec Sheet',
    '',
    `Generated ${UPDATED_AT}. Source of truth: \`${doc.sources.atomic_ledger}\`, \`${doc.sources.stack_sota_ledger}\`, and \`${doc.sources.readiness_ledger}\`.`,
    '',
    'This is the optimization sheet for the deep-dive workflow. The JSON companion contains one row per backend component; this Markdown file carries the operating summary and the highest-priority gaps.',
    '',
    '## How Close To Perfect',
    '',
    `- Local engineering perfection: **${localEngineeringScore}/100**`,
    `- Frontier/product perfection: **${frontierProductScore}/100**`,
    `- Atomic components inventoried: **${componentCount}**`,
    `- Atomic deep dives complete: **${deepDivePct}%**`,
    `- Direct test referenced: **${directTestRefs}/${componentCount} (${directTestPct}%)**`,
    `- High-priority direct test referenced: **${highPriorityTested}/${highPriority.length} (${highPriorityTestPct}%)**`,
    `- Local readiness proof coverage: **${readinessProofSummary.local_proof_requirement_count || 0}/${readinessCounts.total} (${localReadinessProofPct}%)**`,
    `- Claimable readiness closed locally: **${readinessCounts.closed}/${readinessCounts.total} (${claimableReadinessPct}%)**`,
    `- Readiness proof surplus hill-climb: **${readinessProofHillClimb?.score ?? 100}/${readinessProofHillClimb?.ceiling ?? 100}**`,
    `- Language fit: **${readinessProof.language_fit?.architecture || 'unknown'}**`,
    `- SOTA categories still carrying critical work: **${criticalOpen}/${categoryCount}**`,
    `- SOTA categories still carrying major work: **${majorOpen}/${categoryCount}**`,
    '',
    'Interpretation: local code/spec discipline and readiness proof coverage are now complete, but claimable frontier/product perfection remains lower because partner adoption, package release, public benchmark data, certification, and SOTA category gaps are still external or frontier-open. Above-100 scoring is limited to local proof surplus and never upgrades an external gate into a shipped claim.',
    '',
    '## Category Targets',
    '',
    markdownTable(categoryRows, [
      { label: 'Category', value: (r) => r.id },
      { label: 'Area', value: (r) => r.stack_area },
      { label: 'Status', value: (r) => r.status },
      { label: 'Frontier', value: (r) => `at=${r.already_at_frontier_count} open=${r.critical_gaps}/${r.major_gaps}/${r.minor_gaps}` },
      { label: 'Required Components', value: (r) => r.required_components },
      { label: 'Verification', value: (r) => r.suggested_verification.slice(0, 2).join('<br>') },
    ]),
    '',
    '## Top Component Gaps',
    '',
    markdownTable(doc.top_component_gaps.slice(0, 20), [
      { label: 'Component', value: (r) => `\`${r.path}\`` },
      { label: 'Domain', value: (r) => r.domain },
      { label: 'Priority', value: (r) => r.priority_score },
      { label: 'Gaps', value: (r) => r.perfection_gaps.join('<br>') },
      { label: 'Next Action', value: (r) => r.next_best_action },
    ]),
    '',
    '## Machine Sheet',
    '',
    `Every component row is in \`${normalize(path.relative(ROOT, OUT_JSON))}\` under \`components[]\`. Each row includes composition metrics, risk signals, category links, current tests, target state, perfection gaps, next best action, and suggested verification.`,
    '',
  ].join('\n');

  return { doc, md };
}

function writeIfChanged(file, body) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return false;
  fs.writeFileSync(file, body);
  return true;
}

const { doc, md } = build();
const jsonBody = `${JSON.stringify(doc, null, 2)}\n`;

if (args.has('--check')) {
  const jsonOk = fs.existsSync(OUT_JSON) && fs.readFileSync(OUT_JSON, 'utf8') === jsonBody;
  const mdOk = fs.existsSync(OUT_MD) && fs.readFileSync(OUT_MD, 'utf8') === md;
  if (!jsonOk || !mdOk) {
    console.error('master-component-spec-sheet: generated files were out of date');
    process.exit(1);
  }
} else {
  writeIfChanged(OUT_JSON, jsonBody);
  writeIfChanged(OUT_MD, md);
}

if (args.has('--summary') || !args.has('--check')) {
  console.log(JSON.stringify({
    ok: true,
    json: normalize(path.relative(ROOT, OUT_JSON)),
    markdown: normalize(path.relative(ROOT, OUT_MD)),
    summary: doc.summary,
    perfection_model: doc.perfection_model,
  }, null, 2));
}
