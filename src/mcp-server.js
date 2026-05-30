// src/mcp-server.js
//
// Model Context Protocol (MCP) SERVER endpoint for kolm.
//
// This exposes the authenticated tenant's models as MCP *tools* over JSON-RPC
// 2.0 (POST /v1/mcp). An MCP client (Claude Desktop, Cursor, an agent SDK, etc.)
// can connect, call `tools/list` to discover the tenant's deployed models, and
// `tools/call` to run a chat completion -- which we proxy in-process to the
// existing OpenAI-compatible gateway (src/completions-api.js). No external HTTP
// hop; the call runs under the already-authenticated tenant context.
//
// Distinct from src/mcp-gateway.js (which is the *client* side -- kolm calling
// out to other MCP servers). This file is kolm acting AS an MCP server.
//
// Transport note: MCP is transport-agnostic JSON-RPC. We implement the
// "Streamable HTTP" style where each POST carries one JSON-RPC request (or a
// batch array) and the response carries the matching result(s). This is the
// subset MCP HTTP clients require for request/response method calls.
//
// Conventions matched: ESM, Node >= 20, returns plain objects for the route
// layer to serialize. Strict tenant fencing -- the tenant id is always supplied
// by the authenticated route handler and never read from the JSON-RPC body.

import * as completionsModule from './completions-api.js';
import * as modelsModule from './models.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'kolm', version: '1.0.0' };

// JSON-RPC 2.0 error codes.
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

// ---------------------------------------------------------------------------
// Resolve the OpenAI-compatible chat handler from completions-api.js. We probe
// the common export names so a rename does not silently break MCP tool calls.
// The resolved function is expected to take a normalized chat request and
// return a normalized completion ({ choices: [{ message: { content } }] } or a
// raw string). We adapt whatever shape comes back.
// ---------------------------------------------------------------------------
function resolveChat() {
  const m = completionsModule && completionsModule.default
    ? { ...completionsModule, ...completionsModule.default }
    : completionsModule || {};
  const fn =
    m.chatCompletion ||
    m.createChatCompletion ||
    m.completion ||
    m.complete ||
    m.handleChatCompletion ||
    m.runChatCompletion ||
    m.chat ||
    null;
  if (typeof fn !== 'function') {
    throw new Error(
      'mcp-server: completions-api has no chat helper ' +
        '(looked for chatCompletion/createChatCompletion/completion/complete/handleChatCompletion/chat)'
    );
  }
  return fn;
}

function resolveListModels() {
  const m = modelsModule && modelsModule.default
    ? { ...modelsModule, ...modelsModule.default }
    : modelsModule || {};
  return (
    m.listModels ||
    m.listForTenant ||
    m.list ||
    m.tenantModels ||
    m.getModels ||
    null
  );
}

// ---------------------------------------------------------------------------
// Build the list of MCP tools for a tenant. We expose a single generic
// `chat` tool whose `model` argument is constrained to the tenant's models,
// plus one convenience tool per model. The generic tool keeps clients that
// dislike large tool lists happy; the per-model tools improve discoverability.
// ---------------------------------------------------------------------------
async function tenantModelIds(tenant) {
  const listFn = resolveListModels();
  if (!listFn) return [];
  let rows;
  try {
    rows = await listFn(tenant);
  } catch {
    try {
      rows = await listFn({ tenant, tenant_id: tenant });
    } catch {
      rows = [];
    }
  }
  if (!Array.isArray(rows)) rows = (rows && (rows.models || rows.data || rows.rows)) || [];
  return rows
    .map((r) => (typeof r === 'string' ? r : r && (r.id || r.name || r.model)))
    .filter(Boolean);
}

function toolNameForModel(id) {
  return 'chat_' + String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function buildTools(tenant) {
  const models = await tenantModelIds(tenant);
  const tools = [];

  tools.push({
    name: 'chat',
    description:
      "Run a chat completion against one of this tenant's kolm models. " +
      'Returns the assistant message text.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model id to use.',
          ...(models.length ? { enum: models } : {}),
        },
        messages: {
          type: 'array',
          description: 'OpenAI-style chat messages.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        temperature: { type: 'number' },
        max_tokens: { type: 'integer' },
      },
      required: ['model', 'messages'],
    },
  });

  for (const id of models) {
    tools.push({
      name: toolNameForModel(id),
      description: `Chat with kolm model "${id}".`,
      inputSchema: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
                content: { type: 'string' },
              },
              required: ['role', 'content'],
            },
          },
          prompt: {
            type: 'string',
            description: 'Convenience single-turn user prompt (alternative to messages).',
          },
          temperature: { type: 'number' },
          max_tokens: { type: 'integer' },
        },
      },
      // Carry the bound model id so tools/call knows which model to use.
      _kolmModel: id,
    });
  }

  return { tools, models };
}

// ---------------------------------------------------------------------------
// Adapt a completions-api result into a plain assistant string.
// ---------------------------------------------------------------------------
function extractText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result.choices && result.choices[0]) {
    const c = result.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
    if (Array.isArray(c.message && c.message.content)) {
      return c.message.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
    }
  }
  if (typeof result.content === 'string') return result.content;
  if (typeof result.text === 'string') return result.text;
  return JSON.stringify(result);
}

async function runChat(ctx, model, args) {
  const chat = resolveChat();
  const messages =
    Array.isArray(args.messages) && args.messages.length
      ? args.messages
      : args.prompt
      ? [{ role: 'user', content: String(args.prompt) }]
      : null;
  if (!messages) {
    const e = new Error('messages (or prompt) is required');
    e.rpcCode = ERR.INVALID_PARAMS;
    throw e;
  }
  const request = {
    model,
    messages,
    temperature: args.temperature,
    max_tokens: args.max_tokens,
    stream: false,
    // Carry tenant context for the gateway's tenant fencing / usage accounting.
    tenant: ctx.tenant,
    tenant_id: ctx.tenant,
    auth: ctx.auth,
  };
  // Tolerate (request) and (request, ctx) signatures.
  const result = chat.length >= 2 ? await chat(request, ctx) : await chat(request);
  return extractText(result);
}

// ---------------------------------------------------------------------------
// JSON-RPC method dispatch.
//   ctx: { tenant, auth } supplied by the authenticated route handler.
// ---------------------------------------------------------------------------
async function dispatch(ctx, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, ERR.INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined; // JSON-RPC: no id => notification

  try {
    switch (method) {
      case 'initialize': {
        const res = rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
        return isNotification ? null : res;
      }

      case 'notifications/initialized':
      case 'initialized':
        return null; // notification, no response

      case 'ping':
        return isNotification ? null : rpcResult(id, {});

      case 'tools/list': {
        const { tools } = await buildTools(ctx.tenant);
        // Strip internal-only fields before returning to the client.
        const clean = tools.map(({ _kolmModel, ...t }) => t);
        return rpcResult(id, { tools: clean });
      }

      case 'tools/call': {
        const p = params || {};
        const name = p.name;
        const args = p.arguments || {};
        if (!name || typeof name !== 'string') {
          return rpcError(id, ERR.INVALID_PARAMS, 'tool name is required');
        }

        const { tools } = await buildTools(ctx.tenant);
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return rpcError(id, ERR.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
        }

        const model = tool._kolmModel || args.model;
        if (!model) {
          return rpcError(id, ERR.INVALID_PARAMS, 'model is required');
        }

        try {
          const text = await runChat(ctx, model, args);
          // MCP tools/call result: content blocks + isError flag.
          return rpcResult(id, {
            content: [{ type: 'text', text }],
            isError: false,
          });
        } catch (err) {
          if (err && err.rpcCode) {
            return rpcError(id, err.rpcCode, err.message);
          }
          // Tool execution failures are reported as a non-error JSON-RPC result
          // with isError:true, per MCP convention (so the model can see them).
          return rpcResult(id, {
            content: [{ type: 'text', text: `Tool error: ${(err && err.message) || err}` }],
            isError: true,
          });
        }
      }

      default:
        if (isNotification) return null;
        return rpcError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, ERR.INTERNAL, (err && err.message) || 'Internal error', undefined);
  }
}

// ---------------------------------------------------------------------------
// handleMcpRequest: the single entry point the route layer calls.
//   ctx:  { tenant, auth }  (from authenticated request)
//   body: parsed JSON request body (object for single call, array for batch)
// Returns { status, body } for the route layer to send.
// ---------------------------------------------------------------------------
export async function handleMcpRequest(ctx, body) {
  if (!ctx || !ctx.tenant) {
    return { status: 401, body: rpcError(null, ERR.INVALID_REQUEST, 'unauthenticated') };
  }

  // Batch request.
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { status: 400, body: rpcError(null, ERR.INVALID_REQUEST, 'empty batch') };
    }
    const responses = [];
    for (const msg of body) {
      const r = await dispatch(ctx, msg);
      if (r !== null) responses.push(r);
    }
    // All-notifications batch -> 202 with no body.
    if (responses.length === 0) return { status: 202, body: null };
    return { status: 200, body: responses };
  }

  // Single request.
  if (!body || typeof body !== 'object') {
    return { status: 400, body: rpcError(null, ERR.PARSE, 'invalid JSON body') };
  }
  const r = await dispatch(ctx, body);
  if (r === null) return { status: 202, body: null }; // notification
  return { status: 200, body: r };
}

export default { handleMcpRequest, PROTOCOL_VERSION, SERVER_INFO };
