import {
  FAILURE_CODES,
  makeNextAction,
  normalizeReadiness,
  readinessClaimScope,
} from './product-kernel.js';

const FAILURE_BY_CODE = new Map(FAILURE_CODES.map((row) => [row.code, row]));

function normalizeEvidence(evidence = {}) {
  return {
    source_paths: Array.isArray(evidence.source_paths) ? evidence.source_paths.slice() : [],
    artifact_ids: Array.isArray(evidence.artifact_ids) ? evidence.artifact_ids.slice() : [],
    receipt_ids: Array.isArray(evidence.receipt_ids) ? evidence.receipt_ids.slice() : [],
    trace_ids: Array.isArray(evidence.trace_ids) ? evidence.trace_ids.slice() : [],
    audit_event_ids: Array.isArray(evidence.audit_event_ids) ? evidence.audit_event_ids.slice() : [],
    proof_refs: Array.isArray(evidence.proof_refs) ? evidence.proof_refs.slice() : [],
  };
}

function normalizeTenant(tenant = {}) {
  return {
    id: tenant.id || tenant.tenant_id || null,
    workspace_id: tenant.workspace_id || tenant.workspace || null,
    org_id: tenant.org_id || tenant.org || null,
  };
}

function normalizeActions(actions = []) {
  return actions.map((action) => {
    if (action && action.label && action.value) return { ...action };
    return makeNextAction(action);
  });
}

export function okEnvelope({
  surface,
  journey = surface,
  readiness = {},
  tenant = {},
  data = {},
  evidence = {},
  next_actions = [],
  meta = {},
} = {}) {
  const normalizedReadiness = normalizeReadiness(readiness);
  return {
    ok: true,
    surface: surface || null,
    journey: journey || surface || null,
    readiness: normalizedReadiness,
    tenant: normalizeTenant(tenant),
    data,
    evidence: normalizeEvidence(evidence),
    next_actions: normalizeActions(next_actions),
    meta,
  };
}

export function errorEnvelope({
  code = 'unknown_error',
  message = null,
  surface = null,
  journey = surface,
  readiness = {},
  tenant = {},
  evidence = {},
  next_actions = [],
  status = null,
  details = {},
} = {}) {
  const known = FAILURE_BY_CODE.get(code);
  const normalizedReadiness = normalizeReadiness(readiness);
  return {
    ok: false,
    surface,
    journey,
    readiness: normalizedReadiness,
    tenant: normalizeTenant(tenant),
    evidence: normalizeEvidence(evidence),
    error: {
      code,
      message: message || (known ? known.next : code),
      severity: known ? known.severity : 'error',
      retryable: known ? known.retryable : false,
      status,
      details,
    },
    next_actions: normalizeActions(next_actions.length ? next_actions : known ? [{
      kind: 'docs',
      label: known.next,
      value: known.next,
      surface,
      journey,
      priority: 'P0',
    }] : []),
  };
}

export function readinessEnvelope({
  surface,
  journey = surface,
  status = 'implemented',
  requirement_ids = [],
  external_requirements = [],
  blockers = [],
  data = {},
  next_actions = [],
} = {}) {
  return okEnvelope({
    surface,
    journey,
    readiness: {
      status,
      claim_scope: readinessClaimScope(status),
      requirement_ids,
      external_requirements,
    },
    data: {
      blockers: Array.isArray(blockers) ? blockers.slice() : [],
      ...data,
    },
    next_actions,
  });
}

export function jobEnvelope({
  surface,
  journey = surface,
  job,
  readiness = {},
  tenant = {},
  evidence = {},
  next_actions = [],
} = {}) {
  return okEnvelope({
    surface,
    journey,
    readiness,
    tenant,
    data: { job },
    evidence: {
      ...evidence,
      proof_refs: [
        ...(Array.isArray(evidence.proof_refs) ? evidence.proof_refs : []),
        ...(job && job.id ? [{ kind: 'job_id', id: job.id }] : []),
      ],
    },
    next_actions,
  });
}

export function attachEnvelopeHeaders(res, envelope) {
  if (!res || !envelope) return;
  if (envelope.surface) res.set('X-Kolm-Surface', envelope.surface);
  if (envelope.journey) res.set('X-Kolm-Journey', envelope.journey);
  if (envelope.readiness && envelope.readiness.status) res.set('X-Kolm-Readiness', envelope.readiness.status);
}
