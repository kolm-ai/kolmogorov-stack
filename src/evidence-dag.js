// src/evidence-dag.js
//
// R-5 - Evidence DAG. Every .kolm artifact carries an `evidence_dag: {nodes, edges}`
// block that records the upstream provenance graph behind it: which captures
// fed which evals, which evals seeded the teacher, which teacher seeded the
// student, which runtime probe produced the bound passport, which signature
// chain sealed the bytes, which policy + rights gates passed.
//
// The DAG is a labelled directed acyclic graph:
//   nodes : { id, kind, ...attrs } - every piece of evidence is a node
//   edges : { from, to, relationship } - directed link with a typed verb
//
// Relationships:
//   derived_from - `from` was produced from `to` (parent->child = inverse)
//   validated_by - `from` was checked against `to` (eval->capture)
//   invalidates - `from` revoked the truth-value of `to` (revoke fan-out)
//   supersedes - `from` replaced `to` in the canonical position
//
// Two design constraints from the R-5 brief:
//
//   1. DAG = NO CYCLES. buildDag walks every edge and rejects any input that
//      forms a cycle. revoke / trace / descendants all assume acyclicity and
//      would loop forever on a cyclic graph.
//
//   2. The DAG rides INSIDE the manifest but is NOT bound into
//      artifact_hash_input. Same pattern as runtime_passports (R-1): the
//      provenance graph is OPERATIONAL fingerprint that a re-prover can
//      legitimately re-walk and re-emit without invalidating the receipt
//      chain (e.g., adding a new validated_by edge after an eval re-run).
//      The artifact's actual *bytes* (recipes, weights, evals) are anchored
//      in artifact_hash; the DAG explains where those bytes came from but
//      does not gain authority over them.
//
// Why a separate module: keeping schema + builder + traversals + serializer
// in one place lets every callsite (artifact.buildPayload, CLI evidence
// trace/show/revoke, router /v1/evidence/*, account UI) read from the same
// contract without copy-pasting field lists.

export const EVIDENCE_DAG_SCHEMA_VERSION = 'kolm-evidence-dag-1';

// Canonical evidence kinds. New kinds append here.
//   capture - a captured input/output pair from the gateway
//   eval - an evaluation case + its judge verdict
//   teacher - a teacher model rollout that produced training signal
//   student - a student model snapshot (an artifact's predecessor)
//   runtime - a runtime probe (passport row) on a target host
//   signature - a signature event (HMAC chain, Ed25519, Sigstore)
//   policy - a policy gate verdict (Ed25519-required, Rekor-required)
//   rights - a rights/license check (copyright filter, license grant)
export const EVIDENCE_KINDS = Object.freeze([
  'capture',
  'eval',
  'teacher',
  'student',
  'runtime',
  'signature',
  'policy',
  'rights',
]);

// Canonical relationships. Direction is FROM dependent TO dependency:
//   eval --validated_by--> capture     reads as "the eval was validated by the capture"
//   student --derived_from--> teacher  reads as "the student was derived from the teacher"
//   revokeEvent --invalidates--> capture
//   B --supersedes--> A                reads as "B supersedes A"
export const EVIDENCE_RELATIONSHIPS = Object.freeze([
  'derived_from',
  'validated_by',
  'invalidates',
  'supersedes',
]);

// Node id grammar - a stable identifier. We accept any non-empty string up to
// 256 chars with the same charset as the lifecycle artifact_id regex so a DAG
// can reference an artifact directly. Empty / null ids are rejected.
const _NODE_ID_RE = /^[a-zA-Z0-9_:.@-]{1,256}$/;

function _validNodeId(id) {
  return typeof id === 'string' && _NODE_ID_RE.test(id);
}

function _validKind(k) {
  return EVIDENCE_KINDS.includes(k);
}

function _validRelationship(r) {
  return EVIDENCE_RELATIONSHIPS.includes(r);
}

function _freeze(o) {
  return typeof Object.freeze === 'function' ? Object.freeze(o) : o;
}

// Deep-freeze the dag so callers can't mutate the returned graph and then
// re-pass it expecting validation to re-run. Pure: never throws here.
function _deepFreeze(o) {
  if (o == null || typeof o !== 'object') return o;
  for (const k of Object.keys(o)) _deepFreeze(o[k]);
  return _freeze(o);
}

/**
 * Build an immutable evidence DAG from a `{nodes, edges}` input.
 *
 * Validations enforced here:
 *   1. nodes / edges must be arrays.
 *   2. every node has a valid id + a kind from EVIDENCE_KINDS.
 *   3. node ids are unique.
 *   4. every edge has from/to ids that exist in nodes + a known relationship.
 *   5. no self-loops (from === to).
 *   6. NO CYCLES - Kahn-style topological reachability check. The traversal
 *      helpers (trace, descendants, revoke) all assume acyclicity.
 *
 * Returns a frozen graph object: { nodes, edges, _byId, _outAdj, _inAdj }.
 * The adjacency indexes are pre-computed so trace/descendants are O(n+e) per
 * call without an extra walk. Throws on any validation failure with a
 * specific reason - never silently coerces a malformed input into a
 * partially-valid DAG.
 */
export function buildDag(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('buildDag: input must be an object {nodes, edges}');
  }
  const nodesIn = Array.isArray(input.nodes) ? input.nodes : null;
  const edgesIn = Array.isArray(input.edges) ? input.edges : null;
  if (!nodesIn) throw new Error('buildDag: nodes must be an array');
  if (!edgesIn) throw new Error('buildDag: edges must be an array');

  // Validate + index nodes.
  const byId = new Map();
  const nodes = [];
  for (let i = 0; i < nodesIn.length; i++) {
    const n = nodesIn[i];
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      throw new Error(`buildDag: nodes[${i}] must be a non-array object`);
    }
    if (!_validNodeId(n.id)) {
      throw new Error(`buildDag: nodes[${i}].id invalid (must match ${_NODE_ID_RE})`);
    }
    if (!_validKind(n.kind)) {
      throw new Error(
        `buildDag: nodes[${i}].kind invalid: ${JSON.stringify(n.kind)} ` +
        `(must be one of ${EVIDENCE_KINDS.join('|')})`,
      );
    }
    if (byId.has(n.id)) {
      throw new Error(`buildDag: duplicate node id ${JSON.stringify(n.id)}`);
    }
    // Shallow copy + freeze the node so callers can't mutate the indexed copy.
    const copy = { id: n.id, kind: n.kind };
    for (const k of Object.keys(n)) {
      if (k !== 'id' && k !== 'kind') copy[k] = n[k];
    }
    byId.set(n.id, copy);
    nodes.push(copy);
  }

  // Validate edges. Build forward + reverse adjacency in the same pass.
  const outAdj = new Map();   // id -> Array<{to, relationship, attrs}>
  const inAdj = new Map();    // id -> Array<{from, relationship, attrs}>
  for (const n of nodes) {
    outAdj.set(n.id, []);
    inAdj.set(n.id, []);
  }
  const edges = [];
  for (let i = 0; i < edgesIn.length; i++) {
    const e = edgesIn[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`buildDag: edges[${i}] must be a non-array object`);
    }
    if (!_validNodeId(e.from) || !byId.has(e.from)) {
      throw new Error(`buildDag: edges[${i}].from references unknown node ${JSON.stringify(e.from)}`);
    }
    if (!_validNodeId(e.to) || !byId.has(e.to)) {
      throw new Error(`buildDag: edges[${i}].to references unknown node ${JSON.stringify(e.to)}`);
    }
    if (e.from === e.to) {
      throw new Error(`buildDag: edges[${i}] self-loop (${e.from} -> ${e.to})`);
    }
    if (!_validRelationship(e.relationship)) {
      throw new Error(
        `buildDag: edges[${i}].relationship invalid: ${JSON.stringify(e.relationship)} ` +
        `(must be one of ${EVIDENCE_RELATIONSHIPS.join('|')})`,
      );
    }
    const copy = { from: e.from, to: e.to, relationship: e.relationship };
    for (const k of Object.keys(e)) {
      if (k !== 'from' && k !== 'to' && k !== 'relationship') copy[k] = e[k];
    }
    edges.push(copy);
    outAdj.get(e.from).push(copy);
    inAdj.get(e.to).push(copy);
  }

  // Cycle detection - Kahn's algorithm. Start from every node with in-degree
  // zero, peel off, decrement neighbour in-degrees; if any node is left
  // un-peeled the graph has a cycle.
  //
  // A DAG without cycles always topologically sorts; a graph with a cycle
  // leaves the cycle's members forever stuck at in-degree >=1 because each
  // one is waiting for another to be peeled first. We surface the first
  // un-peeled node id in the error so a caller can find the offending loop
  // without re-running their own traversal.
  const inDeg = new Map();
  for (const n of nodes) inDeg.set(n.id, (inAdj.get(n.id) || []).length);
  const queue = [];
  for (const [id, d] of inDeg) {
    if (d === 0) queue.push(id);
  }
  let peeled = 0;
  while (queue.length) {
    const id = queue.shift();
    peeled++;
    for (const e of outAdj.get(id) || []) {
      const cur = inDeg.get(e.to) - 1;
      inDeg.set(e.to, cur);
      if (cur === 0) queue.push(e.to);
    }
  }
  if (peeled < nodes.length) {
    // Find one node still stuck so the error is actionable.
    let stuck = null;
    for (const [id, d] of inDeg) {
      if (d > 0) { stuck = id; break; }
    }
    throw new Error(`buildDag: cycle detected (node ${JSON.stringify(stuck)} is part of a loop)`);
  }

  const dag = {
    spec: EVIDENCE_DAG_SCHEMA_VERSION,
    nodes,
    edges,
    // Hidden indexes used by trace/descendants/revoke. Prefixed with `_` so
    // callers serializing the DAG (e.g. into a manifest) can drop them with
    // a JSON.stringify(dag, (k,v) => k.startsWith('_') ? undefined : v).
    _byId: byId,
    _outAdj: outAdj,
    _inAdj: inAdj,
  };
  return _deepFreeze(dag);
}

/**
 * Serialize a DAG to a JSON-safe object - strips the `_byId`/`_outAdj`/`_inAdj`
 * indexes so the DAG can ride inside a manifest without leaking Map references.
 * The shape matches the buildDag input contract, so a round-trip
 * buildDag(toJSON(buildDag(x))) reconstructs the same graph.
 */
export function toJSON(dag) {
  if (!dag) return null;
  return {
    spec: dag.spec || EVIDENCE_DAG_SCHEMA_VERSION,
    nodes: (dag.nodes || []).map((n) => ({ ...n })),
    edges: (dag.edges || []).map((e) => ({ ...e })),
  };
}

/**
 * Show a single node's full record. Returns null if no such id. Pure: never
 * throws on missing nodes (the caller decides whether absence is an error).
 */
export function showNode(dag, nodeId) {
  if (!dag || !dag._byId) return null;
  const n = dag._byId.get(nodeId);
  return n || null;
}

/**
 * Walk the ANCESTORS of a node - every transitive `to` reachable by following
 * `from->to` edges in reverse. Returns the full provenance chain rooted at
 * nodeId.
 *
 * Output shape:
 *   {
 *     node:       <the requested node>      (null if not found)
 *     ancestors:  [<node>, ...]             (unique, topologically ordered:
 *                                            direct parents first, then
 *                                            grandparents, etc.)
 *     edges:      [<edge>, ...]             (the edges that connect them)
 *   }
 *
 * Acyclicity (enforced at buildDag time) guarantees the BFS terminates
 * without a visited set, but we keep one anyway for O(n+e) determinism.
 */
export function trace(dag, nodeId) {
  if (!dag || !dag._byId) {
    throw new Error('trace: dag must be the output of buildDag()');
  }
  const root = dag._byId.get(nodeId);
  if (!root) return { node: null, ancestors: [], edges: [] };
  const visited = new Set([nodeId]);
  const ancestors = [];
  const edges = [];
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift();
    const outs = dag._outAdj.get(cur) || [];
    for (const e of outs) {
      edges.push(e);
      if (!visited.has(e.to)) {
        visited.add(e.to);
        ancestors.push(dag._byId.get(e.to));
        queue.push(e.to);
      }
    }
  }
  return { node: root, ancestors, edges };
}

/**
 * Walk the DESCENDANTS of a node - every transitive `from` that points AT this
 * node via the reverse adjacency. Used by revoke() to compute the
 * needs_review fan-out: when a capture is revoked, every eval that was
 * `validated_by` it and every student/artifact `derived_from` those evals is
 * surfaced for review.
 *
 * Output shape:
 *   {
 *     node:         <the requested node>     (null if not found)
 *     descendants:  [<node>, ...]            (unique, BFS order: direct
 *                                             children first)
 *     edges:        [<edge>, ...]            (the edges that connect them)
 *   }
 */
export function descendants(dag, nodeId) {
  if (!dag || !dag._byId) {
    throw new Error('descendants: dag must be the output of buildDag()');
  }
  const root = dag._byId.get(nodeId);
  if (!root) return { node: null, descendants: [], edges: [] };
  const visited = new Set([nodeId]);
  const out = [];
  const edges = [];
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift();
    const ins = dag._inAdj.get(cur) || [];
    for (const e of ins) {
      edges.push(e);
      if (!visited.has(e.from)) {
        visited.add(e.from);
        out.push(dag._byId.get(e.from));
        queue.push(e.from);
      }
    }
  }
  return { node: root, descendants: out, edges };
}

/**
 * Mark a node as revoked + propagate a `needs_review` flag to every node that
 * transitively derived from it. The propagation walks the reverse adjacency
 * (children of the revoked node, then their children, etc.) because revoking
 * a capture invalidates every eval that was `validated_by` it, which in turn
 * casts doubt on every student `derived_from` those evals.
 *
 * Pure: does NOT mutate the input DAG (the DAG is frozen). Returns a plain
 * verdict object the caller can persist or re-emit.
 *
 * Output shape:
 *   {
 *     revoked:      [<node_id>]              (always exactly the requested id)
 *     needs_review: [<node_id>, ...]         (transitive descendants - the
 *                                             revoked node itself is NOT in
 *                                             this list)
 *   }
 *
 * Returns { revoked: [], needs_review: [], error } when the node id is not in
 * the graph - letting callers branch on a missing target rather than blowing
 * up a longer revocation workflow.
 */
export function revoke(dag, nodeId) {
  if (!dag || !dag._byId) {
    throw new Error('revoke: dag must be the output of buildDag()');
  }
  if (!dag._byId.has(nodeId)) {
    return { revoked: [], needs_review: [], error: `unknown_node:${nodeId}` };
  }
  const fanout = descendants(dag, nodeId);
  return {
    revoked: [nodeId],
    needs_review: fanout.descendants.map((n) => n.id),
  };
}

/**
 * Conservative validator used by buildPayload - same checks as buildDag, but
 * surfaces them as a result object instead of throwing so the artifact
 * builder can attach a precise error message. Returns { ok:true } or
 * { ok:false, reason }.
 */
export function validateDagInput(input) {
  try {
    buildDag(input);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}
