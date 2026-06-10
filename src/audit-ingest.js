// Agent Security-Review audit - the ingest layer (logs → AuditEvents).
//
// The distill/eval importers (src/importers/{litellm,helicone,portkey,
// openrouter}.js) flatten a provider log row down to input/output TEXT and
// throw away exactly the dimensions a security audit needs:
//   - which TOOLS the agent was granted (request.tools / request.functions)
//   - which TOOLS it actually invoked (assistant tool_calls / function_call)
//   - which HOST the call reached (api_base / provider) - the egress signal
//   - which IDENTITY made the call (user / metadata / key)
//   - whether the content carried SENSITIVE data (PII scan)
//
// This module re-reads the same provider shapes but keeps that security
// dimension, emitting one normalized AuditEvent (src/audit-event.js) per
// agent action. The three analyzers - permission, audit-trail, control - 
// consume the events this produces.
//
// Contract: ingestForAudit never throws. Malformed records are skipped into
// `errors:[{index, reason}]`; the caller surfaces them. A single provider
// row can yield multiple events (one model/API egress + one per tool call).

import { normalizeEvent, eventId } from './audit-event.js';
import { scanPii } from './pii-redactor.js';

// Reserved source tag for first-party gateway captures (the Tier-A bridge).
// Only the authenticated /v1/audit scan/import bridge may use it - it drives
// evidence grade A, so a caller-supplied source must never be allowed to
// claim it (the routes layer enforces the reservation).
export const KOLM_CAPTURE_SOURCE = 'kolm-capture';

// Provider prefixes LiteLLM/OpenRouter stamp onto model names, mapped to the
// host the inference call actually reached. Used to derive an egress host when
// no explicit api_base is logged.
const PROVIDER_HOSTS = {
  openai: 'api.openai.com',
  azure: 'azure-openai',
  anthropic: 'api.anthropic.com',
  bedrock: 'bedrock.amazonaws.com',
  vertex: 'aiplatform.googleapis.com',
  vertex_ai: 'aiplatform.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  cohere: 'api.cohere.com',
  mistral: 'api.mistral.ai',
  groq: 'api.groq.com',
  together: 'api.together.xyz',
  fireworks: 'api.fireworks.ai',
  deepseek: 'api.deepseek.com',
  openrouter: 'openrouter.ai',
  ollama: 'localhost',
  xai: 'api.x.ai',
};

// Field names commonly carrying a target URL/host inside tool-call arguments.
// Extracting these turns a generic "called a tool" event into a data-egress
// finding the analyzers can reason about.
const URL_ARG_KEYS = ['url', 'endpoint', 'uri', 'host', 'hostname', 'base_url', 'api_base', 'to', 'recipient', 'address', 'webhook'];

/* --------------------------------------------------------------------- */
/* small, never-throw coercion helpers                                    */
/* --------------------------------------------------------------------- */

function asObject(value) {
  // Accept an object, or a JSON-encoded string (spendlogs / *_body shapes).
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t === '' || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    const p = JSON.parse(t);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  const o = asObject(value);
  return Array.isArray(o) ? o : null;
}

function str(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return String(value);
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Like firstString, but also accepts a finite number - timestamps are routinely
// logged as unix epoch integers (seconds or ms). normalizeEvent stringifies the
// number and the audit-trail analyzer's parseTs converts it back; dropping it
// here would falsely report a timestamped trail as missing timestamps.
function firstTimestamp(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function hostFromUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  try {
    return new URL(v).host.toLowerCase() || null;
  } catch {
    // Bare host or "host:verb"-ish token - strip scheme/path heuristically.
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(v);
    if (m) return m[1].toLowerCase();
    const bare = v.replace(/^\/+/, '').split(/[/?#]/)[0];
    return bare && bare.includes('.') ? bare.toLowerCase() : null;
  }
}

function hostFromModel(model) {
  if (typeof model !== 'string' || model === '') return null;
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  const provider = model.slice(0, slash).toLowerCase();
  return PROVIDER_HOSTS[provider] || provider;
}

function looksRedacted(text) {
  if (typeof text !== 'string' || text === '') return false;
  return /\[PHI_[A-Z]+_\d+\]|\[REDACTED\b|\bREDACTED\b|█{2,}|\*{4,}|x{6,}@/i.test(text);
}

function sensitivity(text) {
  // Returns { has_sensitive, classes } using the shared PII detector, with a
  // never-throw guard so a detector edge case can't sink an audit ingest.
  if (typeof text !== 'string' || text === '') return { has_sensitive: false, classes: [] };
  try {
    const { classes_hit } = scanPii({ text });
    return { has_sensitive: classes_hit.length > 0, classes: classes_hit };
  } catch {
    return { has_sensitive: false, classes: [] };
  }
}

/* --------------------------------------------------------------------- */
/* OpenAI Responses + Assistants API shape recognition                    */
/* --------------------------------------------------------------------- */
//
// The chat path above keys on `choices[].message`. Two newer OpenAI surfaces
// log a different envelope and would otherwise lose their tool calls:
//   - Responses API: { object:'response', model, output:[ ... ], usage }
//     where output[] is a typed array mixing { type:'message', content:[{
//     type:'output_text', text }] } with { type:'function_call'|'tool_call',
//     name, arguments }.
//   - Assistants API: { object:'thread.run' | 'thread.run.step', assistant_id,
//     thread_id, model, step_details:{ tool_calls:[ ... ] } } and standalone
//     { object:'thread.message', role, content:[{ type:'text', text:{ value }}]}.
// These helpers stay never-throw and additive; the chat/Anthropic branches are
// untouched.

function objectTag(rec, res) {
  // The `object` discriminator can sit on the row OR on a nested response body.
  return firstString(rec && rec.object, res && res.object);
}

function isResponsesShape(rec, res) {
  if (objectTag(rec, res) === 'response') return true;
  // Tolerate a bare Responses body with no `object` tag: an `output` array of
  // typed items (output_text / function_call / message) is the tell.
  const out = asArray(rec && rec.output) || asArray(res && res.output);
  if (!out) return false;
  for (const it of out) {
    if (it && typeof it === 'object') {
      const t = it.type;
      if (t === 'output_text' || t === 'function_call' || t === 'tool_call' ||
          (t === 'message' && Array.isArray(it.content))) return true;
    }
  }
  return false;
}

function isAssistantsShape(rec, res) {
  const tag = objectTag(rec, res);
  return typeof tag === 'string' && tag.indexOf('thread.') === 0;
}

// The Responses `output[]` array, found on the row, a nested response body, or
// (rarely) the request echo. Returns [] when absent.
function responsesOutput(rec, req, res) {
  return (
    asArray(rec && rec.output) ||
    asArray(res && res.output) ||
    asArray(req && req.output) ||
    []
  );
}

// Assistant text from a Responses output[] - the output_text parts of any
// { type:'message', role:'assistant' } items (or top-level output_text items).
function responsesOutputText(output) {
  const parts = [];
  for (const it of asArray(output) || []) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'output_text') { const t = str(it.text); if (t) parts.push(t); continue; }
    if (it.type === 'message' || Array.isArray(it.content)) {
      for (const c of asArray(it.content) || []) {
        if (c && typeof c === 'object' && c.type === 'output_text') {
          const t = str(c.text);
          if (t) parts.push(t);
        }
      }
    }
  }
  return parts.join('\n');
}

// Tool/function calls from a Responses output[] - the { type:'function_call' |
// 'tool_call', name, arguments } items. Returns [{ name, args, id }].
function responsesToolCalls(output) {
  const calls = [];
  for (const it of asArray(output) || []) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call' || it.type === 'tool_call') {
      const fn = it.function && typeof it.function === 'object' ? it.function : it;
      const name = firstString(it.name, fn.name);
      if (name) {
        const args = it.arguments != null ? it.arguments : (fn.arguments != null ? fn.arguments : it.args);
        calls.push({ name, args, id: firstString(it.id, it.call_id, fn.id) });
      }
    }
  }
  return calls;
}

// Text from an Assistants { object:'thread.message' } record, whose content is
// [{ type:'text', text:{ value } }] (text is an OBJECT with .value, unlike the
// chat string content). Returns '' for any other shape.
function assistantsMessageText(rec, res) {
  if (!isAssistantsShape(rec, res)) return '';
  const tag = objectTag(rec, res);
  if (tag !== 'thread.message') return '';
  const parts = [];
  for (const c of asArray(rec.content) || asArray(res && res.content) || []) {
    if (c && typeof c === 'object' && c.type === 'text') {
      const t = c.text && typeof c.text === 'object' ? str(c.text.value) : str(c.text);
      if (t) parts.push(t);
    }
  }
  return parts.join('\n');
}

// Assistants tool calls from a run-step's step_details.tool_calls[], where each
// entry is { id, type:'function', function:{ name, arguments } } (or already a
// flat { name, arguments }). Returns [{ name, args, id }].
function assistantsStepToolCalls(rec, res) {
  const calls = [];
  const details =
    asObject(rec && rec.step_details) ||
    asObject(res && res.step_details) ||
    null;
  const tcs = details ? asArray(details.tool_calls) : null;
  if (!tcs) return calls;
  for (const tc of tcs) {
    if (!tc || typeof tc !== 'object') continue;
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
    const name = firstString(fn.name, tc.name);
    if (name) calls.push({ name, args: fn.arguments != null ? fn.arguments : (fn.args != null ? fn.args : tc.arguments), id: firstString(tc.id, fn.id) });
  }
  return calls;
}

/* --------------------------------------------------------------------- */
/* exchange coercion - one provider row → a uniform request/response view */
/* --------------------------------------------------------------------- */

function coerceExchange(rec, source) {
  // Find the request object across every supported wrapper shape.
  const req =
    asObject(rec.request) ||
    asObject(rec.request_body) ||
    asObject(rec.requestBody) ||
    (asObject(rec.input) && !Array.isArray(rec.input) ? asObject(rec.input) : null) ||
    rec; // top-level OpenAI request (messages/tools live directly on rec)

  const res =
    asObject(rec.response) ||
    asObject(rec.response_body) ||
    asObject(rec.responseBody) ||
    (asObject(rec.output) && !Array.isArray(rec.output) ? asObject(rec.output) : null) ||
    null;

  // OpenAI Responses / Assistants recognition (additive - the chat path keys on
  // choices[].message and is unaffected). When present these expose the model,
  // the assistant output text, and tool calls from their own envelope shapes.
  const responsesShape = isResponsesShape(rec, res);
  const assistantsShape = isAssistantsShape(rec, res);
  const respOutput = responsesShape ? responsesOutput(rec, req, res) : [];

  // Messages: prefer request.messages; tolerate top-level / JSON-string forms
  // and OpenRouter's input.messages / input array. Guard: a Responses request
  // can carry `input` as an array of typed items (not chat messages), so only
  // treat rec.input as messages when it is NOT the Responses envelope.
  let messages =
    asArray(req && req.messages) ||
    asArray(rec.messages) ||
    (!responsesShape && Array.isArray(rec.input) ? rec.input : null) ||
    [];

  // Tool/function grants declared on the request - what the agent MAY call.
  const tools =
    asArray(req && req.tools) ||
    asArray(req && req.functions) ||
    asArray(rec.tools) ||
    asArray(rec.functions) ||
    [];

  const model = firstString(
    req && req.model, rec.model, rec.model_name, rec.modelName,
    res && res.model,
  );

  const ts = firstTimestamp(
    rec.timestamp, rec.startTime, rec.start_time, rec.created_at, rec.createdAt,
    rec.created, rec.time, rec.ts,
  );

  const requestId = firstString(
    rec.request_id, rec.requestId, rec.trace_id, rec.traceId, rec.id, rec.generation_id,
  );

  // Identity: a credential id and/or an agent/service name, wherever logged.
  // For the Assistants API the agent IS the assistant_id (the configured
  // assistant that ran the step); thread_id is carried on meta for correlation.
  const md = asObject(rec.metadata) || asObject(req && req.metadata) || {};
  const assistantId = firstString(rec.assistant_id, rec.assistantId, res && res.assistant_id, md.assistant_id);
  const threadId = firstString(rec.thread_id, rec.threadId, res && res.thread_id, md.thread_id);
  const keyId = firstString(
    rec.key_id, rec.keyId, rec.api_key_id, md.key_id, md.api_key_id, md.key,
    rec.key_alias, md.key_alias, rec.virtual_key, md.virtual_key,
  );
  const agent = firstString(
    rec.user, req && req.user, rec.user_id, md.user, md.user_id, md.agent,
    md.agent_name, md.agent_id, md.app, rec.app, rec.end_user_id,
    assistantId,
  );

  // Egress host for the inference call itself. An explicit api_base wins; then
  // a known GATEWAY implied by the source tag (an OpenRouter export reaches
  // openrouter.ai - the host that actually saw the data - NOT the upstream
  // provider named in the model slug, which OpenRouter may serve via first-party,
  // Bedrock, or Vertex); only then fall back to the model slug. The slug-derived
  // upstream is preserved as routedProvider so the report still records it.
  const apiBase = firstString(rec.api_base, rec.apiBase, req && req.api_base, md.api_base);
  const gatewayHost = source && PROVIDER_HOSTS[source] ? PROVIDER_HOSTS[source] : null;
  const routedProvider = hostFromModel(model);
  const host = hostFromUrl(apiBase) || (apiBase ? apiBase.toLowerCase() : null) || gatewayHost || routedProvider;

  // Tamper-evidence chain links, if the source already carries them.
  const hash = firstString(rec.hash, rec.entry_hash, rec.chain_hash, md.hash);
  const prevHash = firstString(rec.prev_hash, rec.prevHash, rec.previous_hash, md.prev_hash);

  // Tool calls and assistant text drawn from the OpenAI Responses output[] and
  // the Assistants run-step step_details.tool_calls[]. Empty for every other
  // shape, so the chat/Anthropic tool-call path is unaffected.
  const extraToolCalls = [
    ...(responsesShape ? responsesToolCalls(respOutput) : []),
    ...(assistantsShape ? assistantsStepToolCalls(rec, res) : []),
  ];
  const responsesText = [
    responsesShape ? responsesOutputText(respOutput) : '',
    assistantsShape ? assistantsMessageText(rec, res) : '',
  ].filter(Boolean).join('\n');

  return {
    rec, req, res, messages, tools, model, ts, requestId, keyId, agent,
    host, routedProvider, hash, prevHash,
    responsesShape, assistantsShape, assistantId, threadId,
    extraToolCalls, responsesText,
  };
}

/* --------------------------------------------------------------------- */
/* tool-call extraction                                                   */
/* --------------------------------------------------------------------- */

function grantedScopes(tools) {
  const out = [];
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    // OpenAI tools: { type:'function', function:{ name } }
    // Legacy functions: { name }
    const name = firstString(t.function && t.function.name, t.name);
    if (!name) continue;
    const scope = 'tool:' + name.toLowerCase();
    if (seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
}

function argHost(argsValue) {
  // Pull a destination host out of tool-call arguments (string JSON or object).
  const obj = typeof argsValue === 'string' ? asObject(argsValue) : (argsValue && typeof argsValue === 'object' ? argsValue : null);
  if (!obj) {
    // Sometimes arguments are a bare URL string.
    if (typeof argsValue === 'string') return hostFromUrl(argsValue);
    return null;
  }
  for (const k of URL_ARG_KEYS) {
    if (obj[k] != null) {
      const h = hostFromUrl(String(obj[k]));
      if (h) return h;
      const s = String(obj[k]).trim();
      if (s && /@|\./.test(s)) return s.toLowerCase(); // email recipient etc.
    }
  }
  return null;
}

function toolCallsFromMessage(m) {
  // Returns [{ name, args, id }] for an assistant message's tool_calls,
  // legacy function_call, OR Anthropic content-block tool_use shape. The
  // provider call id (when present) is the stable key used to dedup the same
  // logical call as it reappears in the response and the next record's history.
  const calls = [];
  if (!m || typeof m !== 'object') return calls;
  const tcs = asArray(m.tool_calls);
  if (tcs) {
    for (const tc of tcs) {
      if (!tc || typeof tc !== 'object') continue;
      const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
      const name = firstString(fn.name);
      if (name) calls.push({ name, args: fn.arguments != null ? fn.arguments : fn.args, id: firstString(tc.id, fn.id) });
    }
  }
  if (m.function_call && typeof m.function_call === 'object') {
    const name = firstString(m.function_call.name);
    if (name) calls.push({ name, args: m.function_call.arguments, id: firstString(m.function_call.id) });
  }
  // Anthropic content-block shape: message.content is an array of blocks and a
  // tool call is { type:'tool_use', name, input } (mirrors src/tool-use-capture.js).
  // Portkey/Helicone passthrough store native Anthropic bodies, so this is common.
  const blocks = asArray(m.content);
  if (blocks) {
    for (const b of blocks) {
      if (b && typeof b === 'object' && b.type === 'tool_use' && typeof b.name === 'string') {
        calls.push({ name: b.name, args: b.input, id: firstString(b.id) });
      }
    }
  }
  return calls;
}

/* --------------------------------------------------------------------- */
/* per-record event emission                                              */
/* --------------------------------------------------------------------- */

function eventsFromRecord(rec, source, index, seenCallKeys) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { events: [], error: 'record is not a JSON object' };
  }
  const seen = seenCallKeys instanceof Set ? seenCallKeys : new Set();
  const x = coerceExchange(rec, source);
  const granted = x.tools.length ? grantedScopes(x.tools) : null;

  // Sensitivity is assessed over the whole exchange text once and shared.
  const inputText = x.messages.map((m) => (m && typeof m === 'object' ? str(m.content) : str(m))).filter(Boolean).join('\n');
  const outputText = (() => {
    if (!x.res) return '';
    const choices = asArray(x.res.choices);
    if (choices) {
      for (const c of choices) {
        if (c && c.message) {
          const t = str(c.message.content);
          if (t) return t;
        }
      }
    }
    return str(x.res.content || x.res.output_text || x.res.text);
  })();
  // Responses output_text (and Assistants thread.message text, surfaced via the
  // messages walk above) feed the same shared sensitivity scan.
  const exchangeText = [inputText, outputText, x.responsesText].filter(Boolean).join('\n').trim();
  const sens = sensitivity(exchangeText);
  const redacted = looksRedacted(exchangeText);

  const baseActor = { key_id: x.keyId, agent: x.agent };
  const baseMeta = { source, model: x.model, request_id: x.requestId };
  // Correlation handles for the Assistants API (the agent IS the assistant_id,
  // already folded into actor.agent; thread_id/assistant_id stay on meta).
  if (x.assistantId) baseMeta.assistant_id = x.assistantId;
  if (x.threadId) baseMeta.thread_id = x.threadId;

  const events = [];

  // 1) Tool-call events - the security-relevant actions. Walk request-side
  //    assistant turns (the agent's own calls) AND the response message - 
  //    OpenAI choices[].message OR an Anthropic-shaped response with a
  //    content[] block array. The SAME logical call appears in record N's
  //    response AND record N+1's request history (and a response can echo the
  //    request's last assistant turn), so dedup by a stable per-call key across
  //    the whole ingest run, or every agentic call is counted twice.
  const toolCallSites = [];
  for (const m of x.messages) {
    if (m && typeof m === 'object' && (m.role === 'assistant' || m.tool_calls || m.function_call || Array.isArray(m.content))) {
      toolCallSites.push(m);
    }
  }
  if (x.res) {
    const choices = asArray(x.res.choices);
    if (choices) {
      for (const c of choices) {
        if (c && c.message) toolCallSites.push(c.message);
      }
    } else if (Array.isArray(x.res.content)) {
      toolCallSites.push(x.res); // Anthropic-shaped response message
    }
  }
  // Flatten the message-derived calls (chat tool_calls / function_call /
  // Anthropic tool_use) and append the calls extracted from the OpenAI
  // Responses output[] and the Assistants run-step step_details. The dedup +
  // PII-scan + emit body below is identical for all of them.
  const allCalls = [];
  for (const m of toolCallSites) {
    for (const call of toolCallsFromMessage(m)) allCalls.push(call);
  }
  for (const call of x.extraToolCalls) allCalls.push(call);

  let callIndex = 0;
  {
    for (const call of allCalls) {
      const toolName = call.name.toLowerCase();
      const argStr = safeStringify(call.args);
      const dest = argHost(call.args);

      // Dedup the same logical call across its appearances. Prefer the provider
      // tool_call id (stable across response + next-record history); else fall
      // back to a content key. A call already emitted this run is skipped.
      const dedupKey = call.id
        ? 'id:' + call.id
        : 'c:' + [x.keyId || '', toolName, argStr, dest || ''].join('|');
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // PII can live in the call ARGUMENTS (send_email body, db write, http POST
      // body) - the primary exfil channel - so scan them too, not just the
      // message/response text, or a signed report can claim "no sensitive data
      // left the boundary" while an SSN was emailed out.
      const argSens = sensitivity(argStr);
      const hasSensitive = sens.has_sensitive || argSens.has_sensitive;
      const piiClasses = uniqStrings([...sens.classes, ...argSens.classes]);

      // Discriminator so genuinely-distinct parallel calls (different args) get
      // distinct event ids instead of colliding into a false duplicate finding.
      const disc = call.id || [x.requestId || '', toolName, argStr, dest || '', String(callIndex)].join('|');

      events.push(normalizeEvent({
        ts: x.ts,
        namespace: source,
        actor: baseActor,
        action: { type: 'tool', tool: toolName, host: dest, method: null, endpoint: null },
        scopes: { granted, used: ['tool:' + toolName] },
        data: { has_sensitive: hasSensitive, redacted, egress: !!dest },
        hash: x.hash,
        prev_hash: x.prevHash,
        disc,
        meta: { ...baseMeta, kind: 'tool_call', args_host: dest, pii_classes: piiClasses },
      }));
      callIndex++;
    }
  }

  // 2) The inference egress itself - one event per exchange so the audit-trail
  //    analyzer sees every call even when no tool fired. Only emitted when the
  //    record carried something auditable; a contentless record is reported as
  //    an error rather than a phantom event.
  const hasSignal = !!(
    x.model || x.host || (x.messages && x.messages.length) || x.res || events.length ||
    x.responsesShape || x.assistantsShape || (x.responsesText && x.responsesText.length)
  );
  if (hasSignal) {
    // Discriminate distinct exchanges that share {ts, actor, host}: the source
    // request_id when present, else a content hash. Without this, two calls by
    // the same actor in the same one-second bucket collapse to one id and the
    // trail is falsely flagged for duplicate ids / loses its positive finding.
    const disc = x.requestId || (exchangeText ? eventId({ c: exchangeText }) : null);
    events.push(normalizeEvent({
      ts: x.ts,
      namespace: source,
      actor: baseActor,
      action: { type: 'model', host: x.host, method: 'post', endpoint: '/chat/completions' },
      scopes: { granted, used: x.host ? [x.host.toLowerCase() + ':post'] : [] },
      data: { has_sensitive: sens.has_sensitive, redacted, egress: !!x.host },
      hash: x.hash,
      prev_hash: x.prevHash,
      disc,
      meta: { ...baseMeta, kind: 'model_call', api_base: x.host, routed_provider: x.routedProvider, pii_classes: sens.classes },
    }));
  }

  return { events, error: null };
}

/* --------------------------------------------------------------------- */
/* first-party gateway capture rows (the Tier-A bridge)                   */
/* --------------------------------------------------------------------- */
//
// The kolm gateway stores two observation-row shapes:
//   - capture rows ('cap_...'): { id, tenant, tenant_id, model, prompt,
//     response, tool_calls[], corpus_namespace, created_at, ... }
//   - receipt rows ('rcpt_...'): { id, tenant, receipt_id, ts, model,
//     input_hash, output_hash, receipt:{ ..., signature_ed25519 } }
// Both were recorded by kolm's own gateway at runtime, which is exactly what
// evidence grade A means. This parser mirrors eventsFromRecord's contract
// ({ events, error }, shared seenCallKeys dedup) so the rest of the audit
// pipeline is unchanged.

export function eventsFromCaptureRow(row, index, seenCallKeys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { events: [], error: 'capture row is not a JSON object' };
  }
  const seen = seenCallKeys instanceof Set ? seenCallKeys : new Set();
  const receipt = asObject(row.receipt);
  const receiptId = firstString(row.receipt_id, receipt && receipt.receipt_id);
  const captureId = firstString(row.id, receiptId);
  const ts = firstTimestamp(
    row.created_at, receipt && receipt.timestamp, row.ts, row.createdAt, row.timestamp,
  );
  const model = firstString(row.model, receipt && receipt.model);

  // Egress host: explicit api_base wins; then a known provider tag; then the
  // model slug. Gateway captures often log only the model, so the slug
  // fallback matters here.
  const provider = firstString(row.provider, row.vendor);
  const apiBase = firstString(row.api_base, row.apiBase);
  const host =
    hostFromUrl(apiBase) ||
    (apiBase ? apiBase.toLowerCase() : null) ||
    (provider ? (PROVIDER_HOSTS[provider.toLowerCase()] || provider.toLowerCase()) : null) ||
    hostFromModel(model);

  const keyId = firstString(row.key_id, row.api_key_id, receipt && receipt.signing_key_id);
  const agent = firstString(row.actor_id, row.user_id, row.agent, row.team_id, row.tenant);

  const promptText = str(row.prompt != null ? row.prompt : row.input);
  const responseText = str(row.response != null ? row.response : row.output);
  const exchangeText = [promptText, responseText].filter(Boolean).join('\n').trim();
  const sens = sensitivity(exchangeText);
  const redacted =
    (Array.isArray(row.redaction_applied) && row.redaction_applied.length > 0) ||
    Number(row.redaction_count) > 0 ||
    looksRedacted(exchangeText);
  const receiptSigned = !!(receipt && receipt.signature_ed25519);

  // Tamper-evidence chain links, where the capture path recorded them.
  const hash = firstString(row.hash, row.entry_hash, row.chain_hash);
  const prevHash = firstString(row.prev_hash, row.prevHash, row.previous_hash);

  const baseActor = { key_id: keyId, agent };
  const baseMeta = {
    source: KOLM_CAPTURE_SOURCE,
    model,
    request_id: captureId,
  };
  const rowId = firstString(row.id);
  if (rowId) baseMeta.capture_id = rowId;
  const ns = firstString(row.corpus_namespace, row.namespace);
  if (ns) baseMeta.corpus_namespace = ns;
  if (receiptId) baseMeta.receipt_id = receiptId;
  if (receipt) {
    baseMeta.receipt_signed = receiptSigned;
    const inHash = firstString(row.input_hash, receipt.input_hash);
    const outHash = firstString(row.output_hash, receipt.output_hash);
    if (inHash) baseMeta.input_hash = inHash;
    if (outHash) baseMeta.output_hash = outHash;
  }

  const events = [];

  // 1) Tool-call events from the capture's tool_calls[] (flat { name,
  //    arguments } / OpenAI { function:{ name, arguments } } / Anthropic-ish
  //    { name, input }). Same dedup + args-PII discipline as eventsFromRecord.
  let callIndex = 0;
  for (const tc of asArray(row.tool_calls) || []) {
    if (!tc || typeof tc !== 'object') continue;
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
    const name = firstString(fn.name, tc.name);
    if (!name) continue;
    const rawArgs = fn.arguments != null ? fn.arguments : (fn.args != null ? fn.args : (tc.input != null ? tc.input : tc.arguments));
    const toolName = name.toLowerCase();
    const argStr = safeStringify(rawArgs);
    const dest = argHost(rawArgs);

    const callId = firstString(tc.id, fn.id);
    const dedupKey = callId
      ? 'id:' + callId
      : 'c:' + [keyId || '', toolName, argStr, dest || ''].join('|');
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const argSens = sensitivity(argStr);
    const hasSensitive = sens.has_sensitive || argSens.has_sensitive;
    const piiClasses = uniqStrings([...sens.classes, ...argSens.classes]);
    const disc = callId || [captureId || '', toolName, argStr, dest || '', String(callIndex)].join('|');

    events.push(normalizeEvent({
      ts,
      namespace: KOLM_CAPTURE_SOURCE,
      actor: baseActor,
      action: { type: 'tool', tool: toolName, host: dest, method: null, endpoint: null },
      scopes: { granted: null, used: ['tool:' + toolName] },
      data: { has_sensitive: hasSensitive, redacted, egress: !!dest },
      hash,
      prev_hash: prevHash,
      disc,
      meta: { ...baseMeta, kind: 'tool_call', args_host: dest, pii_classes: piiClasses },
    }));
    callIndex++;
  }

  // 2) The captured inference call itself. A contentless row is an error, not
  //    a phantom event - mirrors eventsFromRecord's hasSignal guard.
  const hasSignal = !!(model || host || promptText || responseText || receipt || events.length);
  if (!hasSignal) {
    return { events: [], error: 'no auditable action found in capture row' };
  }
  const disc = captureId || (exchangeText ? eventId({ c: exchangeText }) : null);
  events.push(normalizeEvent({
    ts,
    namespace: KOLM_CAPTURE_SOURCE,
    actor: baseActor,
    action: { type: 'model', host, method: 'post', endpoint: '/chat/completions' },
    scopes: { granted: null, used: host ? [host.toLowerCase() + ':post'] : [] },
    data: { has_sensitive: sens.has_sensitive, redacted, egress: !!host },
    hash,
    prev_hash: prevHash,
    disc,
    meta: { ...baseMeta, kind: 'model_call', api_base: host, provider: provider || null, pii_classes: sens.classes },
  }));

  return { events, error: null };
}

/* --------------------------------------------------------------------- */
/* public API                                                             */
/* --------------------------------------------------------------------- */

function recordsFromInput(input) {
  // Accept: array of objects, a single object, or a string (JSON array,
  // { data:[...] } / { generations:[...] } wrapper, or JSONL).
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return [input];
  if (typeof input !== 'string') return [];
  const trimmed = input.trim();
  if (trimmed === '') return [];
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.data)) return parsed.data;
        if (Array.isArray(parsed.generations)) return parsed.generations;
        if (Array.isArray(parsed.rows)) return parsed.rows;
        if (Array.isArray(parsed.events)) return parsed.events;
        return [parsed];
      }
    } catch {
      // fall through to JSONL
    }
  }
  // JSONL - one object per non-empty line; bad lines become null sentinels so
  // the index/line numbering stays aligned for error reporting.
  const out = [];
  for (const raw of trimmed.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw || raw.trim() === '') continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push(Symbol.for('kolm.audit.badline'));
    }
  }
  return out;
}

const BAD_LINE = Symbol.for('kolm.audit.badline');

/**
 * ingestForAudit - turn raw agent/provider logs into normalized AuditEvents.
 *
 * @param {string|object|object[]} input  JSONL/JSON text, one record, or an
 *                                         array of already-parsed records.
 * @param {{ source?: string }} [opts]    source tag stamped on every event's
 *                                         namespace/meta (default 'import').
 * @returns {{ events: object[], errors: {index:number, reason:string}[],
 *             stats: object }}
 */
export function ingestForAudit(input, opts = {}) {
  const source = (opts.source && String(opts.source).trim()) || 'import';
  const isCapture = source === KOLM_CAPTURE_SOURCE;
  const records = recordsFromInput(input);
  const events = [];
  const errors = [];
  // Shared across records so the same logical tool call - which appears in
  // record N's response AND record N+1's request history - is counted once.
  const seenCallKeys = new Set();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === BAD_LINE) {
      errors.push({ index: i, reason: 'invalid JSON' });
      continue;
    }
    const { events: evs, error } = isCapture
      ? eventsFromCaptureRow(rec, i, seenCallKeys)
      : eventsFromRecord(rec, source, i, seenCallKeys);
    if (error) {
      errors.push({ index: i, reason: error });
      continue;
    }
    if (evs.length === 0) {
      errors.push({ index: i, reason: 'no auditable action found in record' });
      continue;
    }
    for (const e of evs) events.push(e);
  }

  return { events, errors, stats: summarize(events, records.length, errors.length) };
}

function summarize(events, recordCount, errorCount) {
  const actors = new Set();
  const keys = new Set();
  const tools = new Set();
  const hosts = new Set();
  let toolCalls = 0;
  let modelCalls = 0;
  let sensitive = 0;
  let egress = 0;
  for (const e of events) {
    if (e.actor.agent) actors.add(e.actor.agent);
    if (e.actor.key_id) keys.add(e.actor.key_id);
    if (e.action.tool) tools.add(e.action.tool);
    if (e.action.host) hosts.add(e.action.host);
    if (e.meta && e.meta.kind === 'tool_call') toolCalls++;
    if (e.meta && e.meta.kind === 'model_call') modelCalls++;
    if (e.data.has_sensitive) sensitive++;
    if (e.data.egress) egress++;
  }
  return {
    records: recordCount,
    events: events.length,
    errors: errorCount,
    tool_calls: toolCalls,
    model_calls: modelCalls,
    distinct_agents: actors.size,
    distinct_keys: keys.size,
    distinct_tools: tools.size,
    distinct_hosts: hosts.size,
    sensitive_events: sensitive,
    egress_events: egress,
  };
}
