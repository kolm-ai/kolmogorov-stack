// W735 - Agent / Tool-Use distillation: training-data formatter.
//
// Closes W735-2 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md line 393:
//
//   W735-2: "Teach student when and how to call external tools" →
//           training format. The student learns the ChatML+tool shape:
//
//             USER: <prompt>
//             ASSISTANT_TOOL_CALL: {"name":"get_weather","arguments":{...}}
//             TOOL_RESULT: {"temp_f":62}
//             ASSISTANT: <final response synthesising tool outputs>
//
//           When `tool_calls` is absent on the capture row, the formatter
//           falls through to the legacy USER/ASSISTANT format so existing
//           distill flows keep working untouched (additive contract).
//
// Design contract:
//
//   * PURE module. No I/O, no timers, no persistence.
//   * Mirrors src/rag-capture.js formatter convention - same defensive
//     fallthrough on missing fields, same shape for the legacy row, same
//     line-anchored tag namespace (USER:, ASSISTANT:, ASSISTANT_TOOL_CALL:,
//     TOOL_RESULT:). The student model can be fine-tuned on captures that
//     mix RAG, tool-use, and plain Q&A without the formatter switching
//     contracts mid-stream.
//   * Multi-call: when a capture has multiple sequential tool calls, the
//     formatter emits one ASSISTANT_TOOL_CALL+TOOL_RESULT pair per call,
//     in order, before the final ASSISTANT response.
//   * validateToolSchema() is shape-only - we never load JSON Schema's
//     full draft validation (heavy dep, not warranted at this layer).
//     Tenant-supplied tool definitions are checked for the load-bearing
//     fields: {name, description, parameters:{type:"object",properties:{...}}}.
//
// Public surface:
//
//   formatToolUseCapture(capture)
//   validateToolSchema(tool_def)

import crypto from 'node:crypto';

export const TOOL_TRAINING_LIMITS = Object.freeze({
  max_text_chars: 20000,
  max_tool_calls: 100,
  max_json_chars: 64 * 1024,
  max_name_chars: 128,
  max_required_fields: 50,
  max_properties: 100,
});

const UNSAFE_TOOL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function _hash(v) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v)).digest('hex');
}

function _safeText(v, max = TOOL_TRAINING_LIMITS.max_text_chars) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function _trainingText(v) {
  return _safeText(v, TOOL_TRAINING_LIMITS.max_text_chars)
    .replace(/\r?\n/g, '\\n')
    .replace(/\b(USER|ASSISTANT|ASSISTANT_TOOL_CALL|TOOL_RESULT):/g, '$1\\:');
}

function _safeToolName(v) {
  if (typeof v !== 'string') return null;
  const name = v.trim().slice(0, TOOL_TRAINING_LIMITS.max_name_chars);
  if (!name || UNSAFE_TOOL_NAMES.has(name)) return null;
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : null;
}

function _isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// =============================================================================
// formatToolUseCapture
// =============================================================================

/**
 * Render a capture row as a ChatML+tool training-data block.
 *
 * When the capture has `tool_calls`, emits one ASSISTANT_TOOL_CALL +
 * TOOL_RESULT pair per call before the final ASSISTANT line:
 *
 *   USER: What's the weather in San Francisco?
 *   ASSISTANT_TOOL_CALL: {"name":"get_weather","arguments":{"city":"SF"}}
 *   TOOL_RESULT: {"temp_f":62,"conditions":"foggy"}
 *   ASSISTANT: The weather in San Francisco is 62°F and foggy.
 *
 * When `tool_calls` is absent or empty, falls through to the legacy
 * USER/ASSISTANT format (identical to pre-W735 behaviour). This is the
 * additive, non-breaking contract - captures with no tool calls keep
 * looking exactly like W734 / pre-W735 rows.
 *
 * The capture row may carry `tool_results` (array of `{tool_call_id?,
 * output}`) and/or `tool_call_results` to pair with each tool_call by
 * `id` (preferred) or by positional order (fallback). Missing results
 * surface as `TOOL_RESULT: {}` so the student still sees the structural
 * shape - better than silently dropping the line.
 *
 * Returns a string. Never throws.
 */
export function formatToolUseCapture(capture) {
  if (!capture || typeof capture !== 'object') return '';
  const prompt = _trainingText((typeof capture.prompt === 'string') ? capture.prompt
    : (typeof capture.input === 'string' ? capture.input : ''));
  const response = _trainingText((typeof capture.response === 'string') ? capture.response
    : (typeof capture.output === 'string' ? capture.output : ''));

  const toolCalls = Array.isArray(capture.tool_calls)
    ? capture.tool_calls.slice(0, TOOL_TRAINING_LIMITS.max_tool_calls)
    : [];
  if (toolCalls.length === 0) {
    // Legacy fallthrough - identical to pre-W735 behaviour. Stays in lock-
    // step with src/rag-capture.js so a plain-text capture renders the
    // same regardless of which formatter handled it.
    return `USER: ${prompt}\nASSISTANT: ${response}`;
  }

  // Tool results may be supplied under either field name. Both are
  // optional - missing results surface as {} placeholders.
  const rawResults = Array.isArray(capture.tool_results) ? capture.tool_results
    : (Array.isArray(capture.tool_call_results) ? capture.tool_call_results : []);

  // Index by tool_call_id for O(1) pairing when ids are present.
  const resultsById = new Map();
  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    if (r && typeof r === 'object' && typeof r.tool_call_id === 'string' && r.tool_call_id) {
      resultsById.set(r.tool_call_id, r);
    }
  }

  const lines = [`USER: ${prompt}`];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!tc || typeof tc !== 'object' || typeof tc.name !== 'string') continue;
    const safeName = _safeToolName(tc.name);
    if (!safeName) continue;
    // ASSISTANT_TOOL_CALL line. Arguments are always emitted as compact
    // JSON so the student sees a deterministic shape.
    const callBlob = {
      name: safeName,
      arguments: _isPlainObject(tc.arguments) ? tc.arguments : {},
    };
    lines.push(`ASSISTANT_TOOL_CALL: ${_safeStringify(callBlob)}`);

    // TOOL_RESULT pairing. Prefer id-based, fall back to positional.
    let result = null;
    if (typeof tc.id === 'string' && tc.id && resultsById.has(tc.id)) {
      result = resultsById.get(tc.id);
    } else if (i < rawResults.length) {
      const r = rawResults[i];
      // Only accept positional results that DON'T have an id (to avoid
      // misaligning id-tagged results to the wrong call).
      if (r && typeof r === 'object' && !r.tool_call_id) result = r;
    }
    let resultPayload;
    if (result == null) {
      resultPayload = {};
    } else if (typeof result === 'object' && 'output' in result) {
      resultPayload = result.output;
    } else {
      resultPayload = result;
    }
    lines.push(`TOOL_RESULT: ${_safeStringify(resultPayload)}`);
  }
  lines.push(`ASSISTANT: ${response}`);
  return lines.join('\n');
}

// Defensive JSON.stringify wrapper - never throws on circular refs or
// BigInts (returns '{}'). The student model only needs to see a
// deterministic shape; pathological inputs become empty objects.
function _safeStringify(obj) {
  if (obj == null) return '{}';
  if (typeof obj !== 'object') {
    // Numbers/strings/booleans - wrap in {output:...} so the line is
    // always a valid JSON object for the student to parse.
    try { return JSON.stringify({ output: obj }); }
    catch (_e) { return '{}'; }
  }
  try {
    const json = JSON.stringify(obj, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      return v;
    });
    if (json.length > TOOL_TRAINING_LIMITS.max_json_chars) {
      return JSON.stringify({
        truncated: true,
        sha256: _hash(json),
        bytes: Buffer.byteLength(json, 'utf8'),
      });
    }
    return json;
  } catch (_e) {
    return '{}';
  }
}

// =============================================================================
// validateToolSchema
// =============================================================================

/**
 * Shape-only validation of a tenant-supplied tool definition.
 *
 * We intentionally do NOT pull in a full JSON Schema validator (Ajv etc.)
 * - that's a heavy dep for the scaffold layer, and the runtime adapter
 * (src/tool-runtime.js) is where actual argument validation belongs.
 * This function only checks the load-bearing shape so we can fail-loud
 * on registration time when a tool def is obviously misformed.
 *
 * Expected shape (OpenAI-compatible, since most tenants are migrating
 * existing tool specs):
 *
 *   {
 *     name: "get_weather",                              // required, string
 *     description: "Get the current weather for a city", // recommended
 *     parameters: {                                       // required, object
 *       type: "object",                                   // required, must be 'object'
 *       properties: { ... },                              // required, object
 *       required: ["city"],                               // optional, array of strings
 *     }
 *   }
 *
 * Returns `{ok:true}` when the shape is valid.
 * Returns `{ok:false, errors:["..."]}` when one or more checks fail.
 * Never throws.
 */
function _legacyValidateToolSchema(tool_def) {
  const errors = [];
  if (tool_def == null || typeof tool_def !== 'object' || Array.isArray(tool_def)) {
    return { ok: false, errors: ['tool_def must be a plain object'] };
  }
  if (typeof tool_def.name !== 'string' || !tool_def.name) {
    errors.push('tool_def.name must be a non-empty string');
  } else if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tool_def.name)) {
    errors.push('tool_def.name must match /^[A-Za-z_][A-Za-z0-9_-]*$/');
  } else if (tool_def.name.length > 128) {
    errors.push('tool_def.name must be ≤128 characters');
  }
  if (tool_def.description != null && typeof tool_def.description !== 'string') {
    errors.push('tool_def.description must be a string when present');
  }
  if (tool_def.parameters == null || typeof tool_def.parameters !== 'object' || Array.isArray(tool_def.parameters)) {
    errors.push('tool_def.parameters must be a plain object (JSON Schema)');
  } else {
    const p = tool_def.parameters;
    if (p.type !== 'object') {
      errors.push("tool_def.parameters.type must be 'object'");
    }
    if (p.properties == null || typeof p.properties !== 'object' || Array.isArray(p.properties)) {
      errors.push('tool_def.parameters.properties must be a plain object');
    }
    if (p.required != null) {
      if (!Array.isArray(p.required)) {
        errors.push('tool_def.parameters.required must be an array of strings when present');
      } else {
        for (const r of p.required) {
          if (typeof r !== 'string' || !r) {
            errors.push('tool_def.parameters.required[] entries must be non-empty strings');
            break;
          }
        }
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateToolSchema(tool_def) {
  const errors = [];
  if (!_isPlainObject(tool_def)) {
    return { ok: false, errors: ['tool_def must be a plain object'] };
  }
  const safeName = _safeToolName(tool_def.name);
  if (typeof tool_def.name !== 'string' || !tool_def.name) {
    errors.push('tool_def.name must be a non-empty string');
  } else if (!safeName) {
    errors.push('tool_def.name must match /^[A-Za-z_][A-Za-z0-9_-]*$/');
  } else if (tool_def.name.length > TOOL_TRAINING_LIMITS.max_name_chars) {
    errors.push('tool_def.name must be <=128 characters');
  }
  if (tool_def.description != null && typeof tool_def.description !== 'string') {
    errors.push('tool_def.description must be a string when present');
  } else if (typeof tool_def.description === 'string' && tool_def.description.length > TOOL_TRAINING_LIMITS.max_text_chars) {
    errors.push('tool_def.description is too large');
  }
  if (!_isPlainObject(tool_def.parameters)) {
    errors.push('tool_def.parameters must be a plain object (JSON Schema)');
  } else {
    const p = tool_def.parameters;
    if (p.type !== 'object') {
      errors.push("tool_def.parameters.type must be 'object'");
    }
    if (!_isPlainObject(p.properties)) {
      errors.push('tool_def.parameters.properties must be a plain object');
    } else if (Object.keys(p.properties).length > TOOL_TRAINING_LIMITS.max_properties) {
      errors.push('tool_def.parameters.properties has too many keys');
    }
    if (p.required != null) {
      if (!Array.isArray(p.required)) {
        errors.push('tool_def.parameters.required must be an array of strings when present');
      } else if (p.required.length > TOOL_TRAINING_LIMITS.max_required_fields) {
        errors.push('tool_def.parameters.required has too many entries');
      } else {
        for (const r of p.required) {
          if (!_safeToolName(r)) {
            errors.push('tool_def.parameters.required[] entries must be non-empty strings');
            break;
          }
        }
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
