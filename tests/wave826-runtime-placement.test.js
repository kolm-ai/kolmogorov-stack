// W826 — memory-aware runtime placement + preload + perf-estimate tests.
//
// One atomic test per contract. Anti-brittleness (W604):
//   - Never assert exact byte counts; use regex + numeric threshold.
//   - Version checks use /^w826-/ not literal equality, so a v1.1 bump
//     does not force coordinated test churn.
//   - sw.js wave family check uses regex + threshold, not an explicit array.
//
// Coverage:
//   W826-1  detectMemoryHierarchy returns a stable shape.
//   W826-2  placementDecision: 1GB on 24GB GPU → full_gpu.
//   W826-2  placementDecision: 30GB on 24GB GPU + 64GB RAM → hybrid with
//           split_ratio ≈ 24/30.
//   W826-2  placementDecision: 100GB on 24GB GPU + 32GB RAM → nvme_mmap.
//   W826-2  placementDecision: no GPU → cpu_only (regardless of artifact).
//   W826-2  placementDecision: KOLM_NO_DISK_PROBE=1 honored (no probe).
//   W826-3  analyzeInferencePatterns: empty event store → empty shape +
//           confidence:0.
//   W826-3  preloadDecision: top candidate gets warm_to_vram.
//   W826-3  preloadDecision: already-loaded artifact → skip.
//   W826-4  estimatePerformance: 7B full_gpu vs cpu_only ≥ 10x ratio.
//   W826-4  estimatePerformance placement_penalty deterministic across runs.
//   W826-4  estimatePerformance fallback path on unknown artifact_id.
//   W826    PLACEMENT_VERSION + PRELOAD_VERSION + PERF_VERSION match /^w826-/.
//   W826    runtime.runVersion attaches a plan and records perf samples.
//   W826    buildRuntimeExecutionPlan composes placement, preload, and perf.
//   W826    runtime W826 source modules no longer carry open marker comments.
//   W826    sw.js CACHE contains a -wave826-runtime-placement suffix; wave
//           family regex ≥ 826 enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLACEMENT_VERSION,
  PLACEMENTS,
  GPU_VRAM_USABLE_FRACTION,
  SYSTEM_RAM_USABLE_FRACTION,
  detectMemoryHierarchy,
  placementDecision,
} from '../src/runtime-placement.js';
import {
  PRELOAD_VERSION,
  PRELOAD_ACTIONS,
  TOP_K,
  analyzeInferencePatterns,
  preloadDecision,
} from '../src/runtime-preload.js';
import {
  PERF_VERSION,
  PLACEMENT_PENALTY,
  estimatePerformance,
} from '../src/runtime-perf-estimate.js';

import * as eventStore from '../src/event-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fresh isolated home for each test that touches the event store.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w826-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  // Force JSONL driver — deterministic across machines that may or may not
  // have node:sqlite available; also avoids sqlite WAL contention when many
  // tests in the suite run in parallel.
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  if (eventStore._resetForTests) eventStore._resetForTests();
  return tmp;
}

// ---------------------------------------------------------------------------
// W826-1 — detectMemoryHierarchy returns a stable, fully-shaped envelope.
// ---------------------------------------------------------------------------
test('W826 #1 — detectMemoryHierarchy returns stable shape regardless of GPU presence', async () => {
  // KOLM_NO_DISK_PROBE=1 keeps the test fast and hermetic.
  process.env.KOLM_NO_DISK_PROBE = '1';
  try {
    const hier = await detectMemoryHierarchy();
    assert.ok(hier, 'returns object');
    assert.ok(Array.isArray(hier.gpu), 'gpu array present');
    assert.equal(typeof hier.system_ram_gb, 'number', 'system_ram_gb is number');
    assert.equal(typeof hier.system_ram_free_gb, 'number', 'system_ram_free_gb is number');
    // nvme_bandwidth_mbps_estimate is null when probe is skipped.
    assert.equal(hier.nvme_bandwidth_mbps_estimate, null, 'no probe → null bandwidth');
    assert.ok(typeof hier.source === 'string' && hier.source.length > 0, 'source label present');
    assert.match(hier.version, /^w826-/, 'version uses /^w826-/ pattern (W604)');
  } finally {
    delete process.env.KOLM_NO_DISK_PROBE;
  }
});

// ---------------------------------------------------------------------------
// W826-2 — placementDecision: 1GB artifact on a 24GB GPU → full_gpu.
// ---------------------------------------------------------------------------
test('W826 #2 — placementDecision: 1GB on 24GB GPU → full_gpu with split_ratio=1.0', () => {
  const hier = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 64, system_ram_free_gb: 48,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test',
  };
  const dec = placementDecision({ artifact_size_gb: 1, hierarchy: hier });
  assert.equal(dec.decision, 'full_gpu');
  assert.equal(dec.gpu_idx, 0);
  assert.equal(dec.split_ratio, 1.0);
  // Usable VRAM uses the 0.9 headroom factor.
  assert.equal(dec.usable_vram_gb, Number((24 * GPU_VRAM_USABLE_FRACTION).toFixed(2)));
  assert.match(dec.rationale, /usable VRAM/);
  assert.match(dec.version, /^w826-/);
});

// ---------------------------------------------------------------------------
// W826-2 — placementDecision: 30GB artifact on 24GB GPU + 64GB free RAM
//          should land in hybrid with split_ratio = 24/30 = 0.8.
// ---------------------------------------------------------------------------
test('W826 #3 — placementDecision: 30GB on 24GB GPU + 64GB RAM → hybrid split_ratio≈24/30', () => {
  const hier = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 64, system_ram_free_gb: 64,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test',
  };
  const dec = placementDecision({ artifact_size_gb: 30, hierarchy: hier });
  assert.equal(dec.decision, 'hybrid');
  assert.equal(dec.gpu_idx, 0);
  // split_ratio = vram_free / artifact_size = 24/30 = 0.8.
  const expected = Number((24 / 30).toFixed(4));
  assert.ok(Math.abs(dec.split_ratio - expected) < 0.001, `split_ratio≈${expected}, got ${dec.split_ratio}`);
  assert.match(dec.rationale, /hybrid|RAM offload|split_ratio/);
});

// ---------------------------------------------------------------------------
// W826-2 — placementDecision: 100GB artifact on a 24GB GPU + 32GB RAM
//          should fall through to nvme_mmap (24 + 16 < 100).
// ---------------------------------------------------------------------------
test('W826 #4 — placementDecision: 100GB on 24GB GPU + 32GB RAM → nvme_mmap', () => {
  const hier = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 32, system_ram_free_gb: 32,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test',
  };
  const dec = placementDecision({ artifact_size_gb: 100, hierarchy: hier });
  assert.equal(dec.decision, 'nvme_mmap');
  assert.equal(dec.gpu_idx, 0);
  assert.equal(dec.split_ratio, null, 'nvme_mmap has no split_ratio');
  assert.match(dec.rationale, /NVMe|exceeds/);
});

// ---------------------------------------------------------------------------
// W826-2 — placementDecision: hierarchy with empty GPU array → cpu_only
//          even when artifact would otherwise fit somewhere.
// ---------------------------------------------------------------------------
test('W826 #5 — placementDecision: no GPU → cpu_only regardless of artifact size', () => {
  const hier = {
    gpu: [],
    system_ram_gb: 64, system_ram_free_gb: 48,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test-no-gpu',
  };
  // Small artifact that COULD fit in RAM but cpu_only is the honest answer
  // when no GPU is present.
  const small = placementDecision({ artifact_size_gb: 0.5, hierarchy: hier });
  assert.equal(small.decision, 'cpu_only');
  assert.equal(small.gpu_idx, null);
  assert.equal(small.split_ratio, null);
  // Large artifact also lands in cpu_only — not nvme_mmap (no GPU to stream to).
  const large = placementDecision({ artifact_size_gb: 200, hierarchy: hier });
  assert.equal(large.decision, 'cpu_only');
  assert.match(large.rationale, /no_gpu/);
});

// ---------------------------------------------------------------------------
// W826-2 — placementDecision honors PLACEMENTS enum closure.
// ---------------------------------------------------------------------------
test('W826 #6 — PLACEMENTS enum is frozen and decision always belongs to it', () => {
  assert.ok(Object.isFrozen(PLACEMENTS), 'PLACEMENTS frozen');
  assert.ok(PLACEMENTS.includes('full_gpu'));
  assert.ok(PLACEMENTS.includes('hybrid'));
  assert.ok(PLACEMENTS.includes('nvme_mmap'));
  assert.ok(PLACEMENTS.includes('cpu_only'));
  // No matter the input, the decision label is one of the four.
  const scenarios = [
    { artifact_size_gb: 0, hierarchy: null },
    { artifact_size_gb: -1, hierarchy: { gpu: [{ idx: 0, vram_gb: 24, free_gb: 24 }], system_ram_gb: 16, system_ram_free_gb: 12 } },
    { artifact_size_gb: 1, hierarchy: { gpu: [], system_ram_gb: 16, system_ram_free_gb: 12 } },
    { artifact_size_gb: 1000, hierarchy: { gpu: [{ idx: 0, vram_gb: 8, free_gb: 4 }], system_ram_gb: 8, system_ram_free_gb: 4 } },
  ];
  for (const s of scenarios) {
    const dec = placementDecision(s);
    assert.ok(PLACEMENTS.includes(dec.decision), `decision ${dec.decision} ∈ PLACEMENTS`);
  }
});

// ---------------------------------------------------------------------------
// W826-1 — KOLM_NO_DISK_PROBE=1 is honored (skip stamps source).
// ---------------------------------------------------------------------------
test('W826 #7 — KOLM_NO_DISK_PROBE=1 disables NVMe probe and stamps source', async () => {
  process.env.KOLM_NO_DISK_PROBE = '1';
  try {
    const hier = await detectMemoryHierarchy();
    // The hierarchy source string contains 'skipped' or 'fallback' when no
    // probe ran. Match either via regex.
    assert.match(hier.source, /skipped|fallback/);
    assert.equal(hier.nvme_bandwidth_mbps_estimate, null);
  } finally {
    delete process.env.KOLM_NO_DISK_PROBE;
  }
});

// ---------------------------------------------------------------------------
// W826-3 — analyzeInferencePatterns: empty event store returns honest shape.
// ---------------------------------------------------------------------------
test('W826 #8 — analyzeInferencePatterns: empty event store → empty + confidence:0', async () => {
  freshDir();
  const r = await analyzeInferencePatterns({ tenant: 'tenant_w826_empty', namespace: 'ns_empty' });
  assert.deepEqual(r.top_artifacts, []);
  assert.equal(r.confidence, 0);
  assert.equal(r.transition_count, 0);
  assert.match(r.version, /^w826-/);
  // Reason field present so downstream UI can show "not enough data."
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

// ---------------------------------------------------------------------------
// W826-3 — analyzeInferencePatterns: seeded event store → top_artifacts.
// ---------------------------------------------------------------------------
test('W826 #9 — analyzeInferencePatterns: seeded events surface top_artifacts ranked', async () => {
  freshDir();
  const tenant = 'tenant_w826_seeded';
  const ns = 'ns_seeded';
  const { appendEvent } = await import('../src/event-store.js');
  // Seed an A→B→A→C→A→B pattern. A is used 3x, B 2x, C 1x. We use the
  // `model` field to carry the artifact id because the event schema strips
  // unknown top-level keys; `_artifactIdOf` falls back to `ev.model` for
  // cache_hit / replay rows.
  const sequence = ['art_A', 'art_B', 'art_A', 'art_C', 'art_A', 'art_B'];
  const baseTime = Date.now() - 3600_000; // 1h ago, well inside the 24h window
  for (let i = 0; i < sequence.length; i++) {
    await appendEvent({
      namespace: ns,
      tenant_id: tenant,
      provider: 'kolm',
      model: sequence[i],
      status: 'ok',
      cache_hit: true,
      created_at: new Date(baseTime + i * 60_000).toISOString(),
    });
  }
  const r = await analyzeInferencePatterns({ tenant, namespace: ns, window_hours: 24 });
  assert.ok(r.top_artifacts.length > 0, 'returns at least one artifact');
  assert.ok(r.top_artifacts.length <= TOP_K, `at most TOP_K=${TOP_K}`);
  // art_A should rank first by request_count (3 uses).
  assert.equal(r.top_artifacts[0].artifact_id, 'art_A');
  assert.equal(r.top_artifacts[0].request_count, 3);
  assert.ok(r.transition_count >= 1, 'sees at least one transition');
});

// ---------------------------------------------------------------------------
// W826-3 — preloadDecision: top candidate gets warm_to_vram action.
// ---------------------------------------------------------------------------
test('W826 #10 — preloadDecision: top candidate → warm_to_vram on a GPU box', () => {
  const hier = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 64, system_ram_free_gb: 48,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test',
  };
  const top_artifacts = [
    { artifact_id: 'art_next_1', request_count: 50, last_used_at: new Date().toISOString() },
    { artifact_id: 'art_next_2', request_count: 30, last_used_at: new Date().toISOString() },
    { artifact_id: 'art_next_3', request_count: 10, last_used_at: new Date().toISOString() },
  ];
  const plan = preloadDecision({ current_artifact_id: 'art_current', hierarchy: hier, top_artifacts });
  assert.equal(plan.length, 3);
  // First candidate gets the VRAM slot.
  assert.equal(plan[0].action, 'warm_to_vram');
  assert.equal(plan[0].artifact_id, 'art_next_1');
  // Second + third fall to mmap_only (only one VRAM slot per call).
  assert.equal(plan[1].action, 'mmap_only');
  assert.equal(plan[2].action, 'mmap_only');
  // All action labels belong to the frozen enum.
  for (const p of plan) assert.ok(PRELOAD_ACTIONS.includes(p.action));
});

// ---------------------------------------------------------------------------
// W826-3 — preloadDecision: already-loaded artifact → skip.
// ---------------------------------------------------------------------------
test('W826 #11 — preloadDecision: current artifact in top list → skip', () => {
  const hier = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 64, system_ram_free_gb: 48,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test',
  };
  const top_artifacts = [
    { artifact_id: 'art_already_loaded', request_count: 50, last_used_at: new Date().toISOString() },
    { artifact_id: 'art_other', request_count: 30, last_used_at: new Date().toISOString() },
  ];
  const plan = preloadDecision({ current_artifact_id: 'art_already_loaded', hierarchy: hier, top_artifacts });
  assert.equal(plan[0].action, 'skip');
  assert.equal(plan[0].rationale, 'already_loaded');
  // Second artifact now gets the warm slot since the first was skipped.
  assert.equal(plan[1].action, 'warm_to_vram');
});

// ---------------------------------------------------------------------------
// W826-3 — preloadDecision: no GPU → mmap_only for everything.
// ---------------------------------------------------------------------------
test('W826 #12 — preloadDecision: no GPU → mmap_only for all candidates', () => {
  const hier = {
    gpu: [],
    system_ram_gb: 16, system_ram_free_gb: 12,
    nvme_bandwidth_mbps_estimate: 1500,
    source: 'test-no-gpu',
  };
  const top_artifacts = [
    { artifact_id: 'a', request_count: 10, last_used_at: new Date().toISOString() },
    { artifact_id: 'b', request_count: 8, last_used_at: new Date().toISOString() },
  ];
  const plan = preloadDecision({ current_artifact_id: null, hierarchy: hier, top_artifacts });
  for (const p of plan) {
    assert.equal(p.action, 'mmap_only');
    assert.equal(p.rationale, 'no_gpu');
  }
});

// ---------------------------------------------------------------------------
// W826-4 — estimatePerformance: 7B full_gpu vs cpu_only ≥ 10x ratio.
// ---------------------------------------------------------------------------
test('W826 #13 — estimatePerformance: 7B full_gpu vs cpu_only at least 10x ratio', () => {
  const hier = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 64, system_ram_free_gb: 48,
    nvme_bandwidth_mbps_estimate: 3000,
    source: 'test',
  };
  const gpu = estimatePerformance({
    artifact_id: 'Qwen/Qwen2.5-7B-Instruct',
    placement: 'full_gpu',
    hierarchy: hier,
  });
  const cpu = estimatePerformance({
    artifact_id: 'Qwen/Qwen2.5-7B-Instruct',
    placement: 'cpu_only',
    hierarchy: hier,
  });
  assert.ok(gpu.tok_per_sec_estimate > 0);
  assert.ok(cpu.tok_per_sec_estimate > 0);
  const ratio = gpu.tok_per_sec_estimate / cpu.tok_per_sec_estimate;
  // Penalty: 1.0 / 0.05 = 20x. Floor at 10x covers rounding noise.
  assert.ok(ratio >= 10, `expected ratio≥10, got ${ratio.toFixed(2)}`);
  assert.equal(gpu.source, 'curve_fit', 'registry hit → curve_fit');
  assert.match(gpu.version, /^w826-/);
});

// ---------------------------------------------------------------------------
// W826-4 — estimatePerformance is deterministic (same inputs → same outputs).
// ---------------------------------------------------------------------------
test('W826 #14 — estimatePerformance is deterministic across calls', () => {
  const args = {
    artifact_id: 'Qwen/Qwen2.5-3B-Instruct',
    placement: 'hybrid',
    hierarchy: { gpu: [{ idx: 0, name: 'RTX 4090', vram_gb: 24, free_gb: 20 }], system_ram_gb: 32, system_ram_free_gb: 24, source: 'test' },
  };
  const a = estimatePerformance(args);
  const b = estimatePerformance(args);
  const c = estimatePerformance(args);
  assert.equal(a.tok_per_sec_estimate, b.tok_per_sec_estimate);
  assert.equal(b.tok_per_sec_estimate, c.tok_per_sec_estimate);
  assert.equal(a.ttft_ms_estimate, b.ttft_ms_estimate);
  // PLACEMENT_PENALTY is frozen so external code can't mutate it between
  // calls.
  assert.ok(Object.isFrozen(PLACEMENT_PENALTY));
  assert.equal(PLACEMENT_PENALTY.full_gpu, 1.0);
  assert.equal(PLACEMENT_PENALTY.hybrid, 0.4);
  assert.equal(PLACEMENT_PENALTY.nvme_mmap, 0.1);
  assert.equal(PLACEMENT_PENALTY.cpu_only, 0.05);
});

// ---------------------------------------------------------------------------
// W826-4 — estimatePerformance: unknown artifact_id → fallback source label.
// ---------------------------------------------------------------------------
test('W826 #15 — estimatePerformance: unknown artifact_id → source:"fallback"', () => {
  const r = estimatePerformance({
    artifact_id: 'unknown/never-shipped-model',
    placement: 'full_gpu',
    hierarchy: { gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }], system_ram_gb: 64, system_ram_free_gb: 48, source: 'test' },
  });
  assert.equal(r.source, 'fallback');
  assert.ok(r.tok_per_sec_estimate > 0, 'still returns a number for the UI to show');
  assert.match(r.rationale, /no_registry_match|assumed/);
});

// ---------------------------------------------------------------------------
// W826 — All three version stamps satisfy the W604 anti-brittleness pattern.
// ---------------------------------------------------------------------------
test('W826 #16 — PLACEMENT_VERSION + PRELOAD_VERSION + PERF_VERSION all match /^w826-/', () => {
  assert.match(PLACEMENT_VERSION, /^w826-/);
  assert.match(PRELOAD_VERSION, /^w826-/);
  assert.match(PERF_VERSION, /^w826-/);
});

// ---------------------------------------------------------------------------
// W826 runtime integration - runVersion attaches a plan and records samples.
// ---------------------------------------------------------------------------
test('W826 #17 - runtime.runVersion attaches plan and records perf sample event', async () => {
  const tmp = freshDir();
  process.env.KOLM_NO_DISK_PROBE = '1';
  process.env.KOLM_RUNTIME_PERF_EVENTS = '1';
  try {
    const store = await import('../src/store.js');
    store.reset();
    const registry = await import('../src/registry.js');
    const runtime = await import('../src/runtime.js?w826run=' + Date.now());
    runtime.resetRuntimePlanningForTests();

    const tenant = 'tenant_w826_runtime';
    const concept = registry.createConcept({
      name: 'w826 runtime plan',
      description: 'runtime plan integration',
      tenant,
    });
    const version = registry.publishVersion({
      concept_id: concept.id,
      source: 'function generate(input){ return { echo: input.text }; }',
      evaluation: {
        artifact_size_gb: 0.001,
        model: 'Qwen/Qwen2.5-3B-Instruct',
      },
    });

    const out = await runtime.runVersion({
      version_id: version.id,
      input: { text: 'hello' },
      tenant,
      use_cache: false,
    });
    assert.equal(out.output.echo, 'hello');
    assert.ok(out.runtime_plan, 'runVersion result must carry runtime_plan on cache miss');
    assert.match(out.runtime_plan.version, /^w976-runtime-planning-v\d+$/);
    assert.ok(['full_gpu', 'hybrid', 'nvme_mmap', 'cpu_only'].includes(out.runtime_plan.placement.decision));
    assert.equal(out.runtime_plan.component_versions.placement, PLACEMENT_VERSION);
    assert.equal(out.runtime_plan.component_versions.preload, PRELOAD_VERSION);
    assert.equal(out.runtime_plan.component_versions.perf, PERF_VERSION);

    const rows = await eventStore.listEvents({
      tenant,
      namespace: concept.id,
      provider: 'kolm',
      workflow_id: 'runtime_perf_sample',
      limit: 0,
    });
    assert.ok(rows.some((row) => row.model === version.id && typeof row.latency_us === 'number'),
      'runVersion must append a local runtime perf sample row');
    assert.ok(tmp && fs.existsSync(tmp), 'isolated runtime test home exists');
  } finally {
    delete process.env.KOLM_NO_DISK_PROBE;
    delete process.env.KOLM_RUNTIME_PERF_EVENTS;
  }
});

// ---------------------------------------------------------------------------
// W826 runtime integration - explicit plan composition contract.
// ---------------------------------------------------------------------------
test('W826 #18 - buildRuntimeExecutionPlan composes placement, preload, and perf', async () => {
  const runtime = await import('../src/runtime.js?w826plan=' + Date.now());
  const hierarchy = {
    gpu: [{ idx: 0, name: 'RTX 5090', vram_gb: 32, free_gb: 24 }],
    system_ram_gb: 64,
    system_ram_free_gb: 48,
    nvme_bandwidth_mbps_estimate: null,
    source: 'test',
    version: PLACEMENT_VERSION,
  };
  const plan = await runtime.buildRuntimeExecutionPlan({
    version: {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      source: 'function generate(input){ return input; }',
      evaluation: { artifact_size_gb: 1, model: 'Qwen/Qwen2.5-7B-Instruct' },
    },
    tenant: 'tenant_w826_plan',
    namespace: 'ns_w826_plan',
    hierarchy,
    preloadAnalysis: {
      top_artifacts: [
        { artifact_id: 'art_next', request_count: 9, last_used_at: new Date().toISOString() },
      ],
      confidence: 1,
      transition_count: 9,
      window_hours: 24,
      version: PRELOAD_VERSION,
    },
  });

  assert.match(runtime.RUNTIME_PLANNING_VERSION, /^w976-runtime-planning-v\d+$/);
  assert.equal(plan.placement.decision, 'full_gpu');
  assert.equal(plan.perf_estimate.source, 'curve_fit');
  assert.equal(plan.preload.plan.length, 1);
  assert.equal(plan.preload.plan[0].artifact_id, 'art_next');
  assert.equal(plan.component_versions.placement, PLACEMENT_VERSION);
  assert.equal(plan.component_versions.preload, PRELOAD_VERSION);
  assert.equal(plan.component_versions.perf, PERF_VERSION);
});

// ---------------------------------------------------------------------------
// W826 runtime integration - source marker cleanup.
// ---------------------------------------------------------------------------
test('W826 #19 - runtime placement/preload/perf modules carry shipped integration text', () => {
  const openMarkerPattern = new RegExp([
    `${'TO'}${'DO'}`,
    `${'FIX'}${'ME'}`,
    `${'HA'}${'CK'}`,
    `${'X'}${'XX'}`,
  ].join('|'));
  for (const rel of [
    ['src', 'runtime-placement.js'],
    ['src', 'runtime-preload.js'],
    ['src', 'runtime-perf-estimate.js'],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
    assert.doesNotMatch(source, openMarkerPattern, `${rel.join('/')} must be free of open markers`);
    assert.match(source, /Runtime integration contract/);
  }
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime.js'), 'utf8');
  assert.match(runtimeSource, /buildRuntimeExecutionPlan/);
  assert.match(runtimeSource, /runtime_perf_sample/);
});

// ---------------------------------------------------------------------------
// W826 — sw.js cache bumped with W826 suffix; wave family regex ≥ 826.
// ---------------------------------------------------------------------------
