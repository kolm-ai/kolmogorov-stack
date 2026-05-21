function node(id, type, label, meta = {}) {
  return { id: String(id), type, label: label || String(id), ...meta };
}

function edge(from, to, type, meta = {}) {
  return { from: String(from), to: String(to), type, ...meta };
}

function addNode(map, n) {
  if (!n.id || map.has(n.id)) return;
  map.set(n.id, n);
}

function addEdge(list, e) {
  if (!e.from || !e.to || e.from === e.to) return;
  if (list.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) return;
  list.push(e);
}

function stringList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return [v];
  return [];
}

export function dependencyGraphFromManifest(manifest = {}, { artifactId = null } = {}) {
  const artifact = artifactId || manifest.id || manifest.name || manifest.job_id || 'artifact';
  const nodes = new Map();
  const edges = [];
  addNode(nodes, node(artifact, 'artifact', manifest.name || artifact, {
    runtime_target: manifest.runtime_target || 'js',
    artifact_class: manifest.artifact_class || 'recipe',
    k_score: manifest.k_score || null,
  }));

  const baseModels = [
    manifest.base_model,
    manifest.model,
    manifest.model_id,
    manifest.teacher_model,
    manifest.student_model,
  ].filter(Boolean);
  for (const m of new Set(baseModels.map(String))) {
    const id = `model:${m}`;
    addNode(nodes, node(id, 'model', m));
    addEdge(edges, edge(artifact, id, 'uses_model'));
  }

  const weights = manifest.model_weights || manifest.weights || {};
  for (const [name, value] of Object.entries(weights || {})) {
    const ref = typeof value === 'string' ? value : (value?.uri || value?.path || value?.sha256 || name);
    const id = `weights:${ref}`;
    addNode(nodes, node(id, 'weights', ref, { name }));
    addEdge(edges, edge(artifact, id, 'bundles_weights'));
  }

  for (const t of stringList(manifest.compiled_targets || manifest.runtime_targets || manifest.export?.targets)) {
    const id = `runtime:${t}`;
    addNode(nodes, node(id, 'runtime', t));
    addEdge(edges, edge(artifact, id, 'compiled_for'));
  }
  if (manifest.runtime_target) {
    const id = `runtime:${manifest.runtime_target}`;
    addNode(nodes, node(id, 'runtime', manifest.runtime_target));
    addEdge(edges, edge(artifact, id, 'runs_on'));
  }

  const lineage = manifest.lineage || manifest.provenance || {};
  for (const ref of stringList(lineage.synthesized_from || lineage.parents || lineage.upstream_artifacts)) {
    const id = `artifact:${ref}`;
    addNode(nodes, node(id, 'artifact', ref));
    addEdge(edges, edge(artifact, id, 'derived_from'));
  }
  for (const dep of stringList(lineage.dependencies || manifest.dependencies)) {
    const id = `dependency:${dep}`;
    addNode(nodes, node(id, 'dependency', dep));
    addEdge(edges, edge(artifact, id, 'depends_on'));
  }

  const moe = manifest.moe || manifest.mixture || {};
  const experts = stringList(moe.experts || moe.artifacts);
  for (const expert of experts) {
    const id = `expert:${expert}`;
    addNode(nodes, node(id, 'expert_artifact', expert));
    addEdge(edges, edge(artifact, id, 'routes_to_expert'));
  }

  const workflow = manifest.workflow_ir || manifest.workflow || {};
  for (const step of Array.isArray(workflow.steps) ? workflow.steps : []) {
    const sid = step.id || step.name || step.type;
    if (!sid) continue;
    const id = `workflow:${sid}`;
    addNode(nodes, node(id, 'workflow_step', sid, { step_type: step.type || null }));
    addEdge(edges, edge(artifact, id, 'workflow_step'));
  }

  return {
    ok: true,
    spec: 'kolm-artifact-dependency-graph/1',
    artifact_id: artifact,
    nodes: [...nodes.values()],
    edges,
    counts: { nodes: nodes.size, edges: edges.length },
    secret_values_included: false,
  };
}

export function dependencyBlastRadius(graph, changedIds = []) {
  const changed = new Set(changedIds.map(String));
  const affected = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of graph.edges || []) {
      if ((changed.has(e.to) || affected.has(e.to)) && !affected.has(e.from)) {
        affected.add(e.from);
        grew = true;
      }
    }
  }
  return {
    ok: true,
    changed: [...changed],
    affected_artifacts: [...affected].filter((id) => (graph.nodes || []).find((n) => n.id === id && n.type === 'artifact')),
    affected_nodes: [...affected],
  };
}

export default {
  dependencyGraphFromManifest,
  dependencyBlastRadius,
};
