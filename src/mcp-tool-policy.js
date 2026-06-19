// W981 - MCP per-tool policy gate.
//
// This is intentionally a small, deterministic policy layer for
// /v1/mcp/dispatch. It evaluates tenant/tool/server allow/deny rules and
// optional caller trust levels before the route spends an upstream tool call or
// mints a signed receipt. The policy decision is stamped later as a non-signed
// receipt field, matching guardrail/anchor behavior.

export const MCP_TOOL_POLICY_VERSION = 'w981-mcp-tool-policy-v1';

const TRUST_RANK = Object.freeze({
  anonymous: 0,
  public: 0,
  low: 1,
  user: 1,
  standard: 2,
  medium: 2,
  trusted: 3,
  high: 3,
  admin: 4,
  owner: 4,
  root: 5,
});

function _string(v, max = 256) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function _array(v) {
  if (Array.isArray(v)) return v.map((x) => _string(x)).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => _string(x)).filter(Boolean);
  return [];
}

function _plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _effect(v) {
  const s = _string(v).toLowerCase();
  return s === 'deny' || s === 'block' ? 'deny' : 'allow';
}

function _defaultAction(raw, rules) {
  const s = _string(raw).toLowerCase();
  if (s === 'deny' || s === 'block') return 'deny';
  if (s === 'allow') return 'allow';
  return rules.some((r) => r && r.effect === 'allow') ? 'deny' : 'allow';
}

function _trustLabel(v) {
  const s = _string(v).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TRUST_RANK, s) ? s : null;
}

function _trustRank(v) {
  const label = _trustLabel(v);
  return label == null ? null : TRUST_RANK[label];
}

function _normalizePatternList(v, fallback = ['*']) {
  const rows = _array(v).filter((x) => /^[A-Za-z0-9_.:-]+\*?$|^\*$/.test(x));
  return rows.length ? [...new Set(rows)].sort() : fallback.slice();
}

function _matchesPattern(pattern, value) {
  const p = _string(pattern);
  const v = _string(value);
  if (p === '*') return true;
  if (!v) return false;
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1));
  return p === v;
}

function _matchesAny(patterns, value) {
  return (patterns || ['*']).some((p) => _matchesPattern(p, value));
}

function _normalizeRule(raw, index, forcedEffect = null) {
  if (!_plainObject(raw)) return null;
  const effect = forcedEffect || _effect(raw.effect || raw.action);
  const id = _string(raw.id || raw.rule_id || `rule_${index + 1}`, 128) || `rule_${index + 1}`;
  const tools = _normalizePatternList(raw.tools || raw.tool || raw.tool_names);
  const tenants = _normalizePatternList(raw.tenants || raw.tenant || raw.tenant_ids);
  const servers = _normalizePatternList(raw.servers || raw.server || raw.server_ids);
  const minTrust = _trustLabel(raw.min_trust_level || raw.minTrustLevel || raw.trust_level || raw.trustLevel);
  return {
    id,
    effect,
    tools,
    tenants,
    servers,
    min_trust_level: minTrust,
    reason: _string(raw.reason || (effect === 'deny' ? 'tool policy denied' : 'tool policy allowed'), 512),
  };
}

function _rulesFromList(values, effect, startIndex = 0, base = {}) {
  return _array(values).map((tool, i) => _normalizeRule({
    ...base,
    id: base.id || `${effect}_${startIndex + i + 1}`,
    effect,
    tools: [tool],
  }, startIndex + i, effect)).filter(Boolean);
}

export function normalizeMcpToolPolicy(raw = {}) {
  const cfg = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw); } catch { return {}; } })()
    : (_plainObject(raw) ? raw : {});
  const baseRules = Array.isArray(cfg.rules) ? cfg.rules : [];
  const allowRules = _rulesFromList(cfg.allow || cfg.allow_tools || cfg.allowlist || cfg.allowList, 'allow', baseRules.length, {
    reason: 'tool allow-list match',
  });
  const denyRules = _rulesFromList(cfg.deny || cfg.deny_tools || cfg.denylist || cfg.denyList, 'deny', baseRules.length + allowRules.length, {
    reason: 'tool deny-list match',
  });
  const rules = [
    ...baseRules.map((rule, i) => _normalizeRule(rule, i)).filter(Boolean),
    ...allowRules,
    ...denyRules,
  ];
  const default_action = _defaultAction(cfg.default_action || cfg.defaultAction || cfg.default, rules);
  const minTrust = _trustLabel(cfg.min_trust_level || cfg.minTrustLevel);
  return {
    version: MCP_TOOL_POLICY_VERSION,
    policy_id: _string(cfg.id || cfg.policy_id || 'mcp-tool-policy', 128) || 'mcp-tool-policy',
    default_action,
    min_trust_level: minTrust,
    rules,
  };
}

function _ruleMatches(rule, input) {
  return _matchesAny(rule.tools, input.tool)
    && _matchesAny(rule.tenants, input.tenant)
    && _matchesAny(rule.servers, input.server_id || '*');
}

function _decision({ allow, reason, policy, input, rule = null, requiredTrust = null }) {
  return {
    ok: true,
    allow: !!allow,
    action: allow ? 'allow' : 'deny',
    reason: _string(reason || (allow ? 'allowed' : 'denied'), 512),
    policy_id: policy.policy_id,
    rule_id: rule ? rule.id : null,
    tool: _string(input.tool, 128),
    server_id: input.server_id == null ? null : _string(input.server_id, 128),
    caller_trust_level: input.caller_trust_level || null,
    required_trust_level: requiredTrust || (rule && rule.min_trust_level) || policy.min_trust_level || null,
    version: MCP_TOOL_POLICY_VERSION,
  };
}

function _trustTooLow(required, actual) {
  const req = _trustRank(required);
  if (req == null) return false;
  const got = _trustRank(actual);
  return got == null || got < req;
}

export function evaluateMcpToolPolicy(policyRaw, inputRaw = {}) {
  const policy = normalizeMcpToolPolicy(policyRaw);
  const input = {
    tenant: _string(inputRaw.tenant, 256),
    tool: _string(inputRaw.tool, 128),
    server_id: inputRaw.server_id == null ? null : _string(inputRaw.server_id, 128),
    caller_trust_level: _trustLabel(inputRaw.caller_trust_level || inputRaw.trust_level),
  };
  if (!input.tenant || !input.tool) {
    return _decision({ allow: false, reason: 'tenant and tool are required for MCP policy evaluation', policy, input });
  }

  for (const rule of policy.rules.filter((r) => r.effect === 'deny')) {
    if (_ruleMatches(rule, input)) {
      return _decision({ allow: false, reason: rule.reason || 'deny rule matched', policy, input, rule });
    }
  }

  const matchingAllows = policy.rules.filter((r) => r.effect === 'allow' && _ruleMatches(r, input));
  for (const rule of matchingAllows) {
    if (_trustTooLow(rule.min_trust_level || policy.min_trust_level, input.caller_trust_level)) continue;
    return _decision({ allow: true, reason: rule.reason || 'allow rule matched', policy, input, rule });
  }
  if (matchingAllows.length > 0) {
    const required = matchingAllows.map((r) => r.min_trust_level || policy.min_trust_level).filter(Boolean).sort((a, b) => TRUST_RANK[a] - TRUST_RANK[b])[0] || null;
    return _decision({ allow: false, reason: 'caller trust level below tool policy requirement', policy, input, rule: matchingAllows[0], requiredTrust: required });
  }

  if (_trustTooLow(policy.min_trust_level, input.caller_trust_level)) {
    return _decision({ allow: false, reason: 'caller trust level below global MCP policy requirement', policy, input, requiredTrust: policy.min_trust_level });
  }
  return _decision({
    allow: policy.default_action === 'allow',
    reason: policy.default_action === 'allow' ? 'default allow policy' : 'default deny policy',
    policy,
    input,
  });
}

export function makeMcpToolPolicy(raw = {}) {
  const policy = normalizeMcpToolPolicy(raw);
  return {
    configured: true,
    policy,
    evaluate(input = {}) {
      return evaluateMcpToolPolicy(policy, input);
    },
  };
}

export function mcpToolPolicyFromEnv(env = process.env) {
  const raw = env.KOLM_MCP_TOOL_POLICY_JSON || env.KOLM_MCP_TOOL_POLICY || '';
  const hasShorthand = !!(
    env.KOLM_MCP_TOOL_ALLOWLIST
    || env.KOLM_MCP_TOOL_ALLOW_LIST
    || env.KOLM_MCP_TOOL_DENYLIST
    || env.KOLM_MCP_TOOL_DENY_LIST
    || env.KOLM_MCP_TOOL_DEFAULT
    || env.KOLM_MCP_TOOL_MIN_TRUST_LEVEL
  );
  if (!raw && !hasShorthand) return { configured: false, policy: null, evaluate: undefined };
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw); } catch {
      return makeMcpToolPolicy({
        id: 'mcp-tool-policy-invalid-json',
        default_action: 'deny',
        rules: [{ id: 'invalid_policy_json', effect: 'deny', tools: ['*'], reason: 'invalid MCP tool policy JSON' }],
      });
    }
    if (!_plainObject(parsed)) {
      return makeMcpToolPolicy({
        id: 'mcp-tool-policy-invalid-json',
        default_action: 'deny',
        rules: [{ id: 'invalid_policy_json', effect: 'deny', tools: ['*'], reason: 'invalid MCP tool policy JSON' }],
      });
    }
  }
  const cfg = {
    ...parsed,
  };
  const envAllow = env.KOLM_MCP_TOOL_ALLOWLIST || env.KOLM_MCP_TOOL_ALLOW_LIST;
  const envDeny = env.KOLM_MCP_TOOL_DENYLIST || env.KOLM_MCP_TOOL_DENY_LIST;
  if (envAllow) cfg.allow = _array(envAllow);
  if (envDeny) cfg.deny = _array(envDeny);
  if (env.KOLM_MCP_TOOL_DEFAULT) cfg.default_action = env.KOLM_MCP_TOOL_DEFAULT;
  if (env.KOLM_MCP_TOOL_MIN_TRUST_LEVEL) cfg.min_trust_level = env.KOLM_MCP_TOOL_MIN_TRUST_LEVEL;
  return makeMcpToolPolicy(cfg);
}

export default {
  MCP_TOOL_POLICY_VERSION,
  normalizeMcpToolPolicy,
  evaluateMcpToolPolicy,
  makeMcpToolPolicy,
  mcpToolPolicyFromEnv,
};
