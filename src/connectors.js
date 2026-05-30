// src/connectors.js
//
// Automation connectors breadth (P1).
//
// Ready-to-use integration recipes for the kolm OpenAI-compatible gateway.
//
// This module is intentionally dependency-free (Node core only) so it can be
// mounted from src/router.js / server.js without coupling to internal helpers.
// It produces, for a given tenant model + base URL:
//   - A connector catalog            (GET /v1/connectors)
//   - Per-connector recipes          (GET /v1/connectors/:id)
//   - A generic Zapier / Make / n8n webhook-action spec
//   - A LangChain / LlamaIndex / OpenAI-SDK usage-snippet generator
//   - An OpenAPI-shaped connector manifest for the gateway
//
// The gateway is OpenAI-compatible: it speaks POST {base}/v1/chat/completions
// and POST {base}/v1/embeddings with `Authorization: Bearer <KOLM_API_KEY>`,
// so every recipe here points integrations at those standard endpoints.
//
// Conventions matched to the rest of src/*: ESM ("type":"module"), Node >= 20,
// pure functions that return plain objects/strings for the route layer to
// serialize. No tenant secrets are ever emitted -- the API key only ever
// appears as a {{KOLM_API_KEY}} / $KOLM_API_KEY placeholder.
//
// Usage from a router:
//   import * as connectors from './connectors.js';
//   // GET /v1/connectors
//   const list = connectors.listConnectors({ baseUrl, model });
//   // GET /v1/connectors/:id
//   const recipe = connectors.getConnector(id, { baseUrl, model }); // null => 404

// ---------------------------------------------------------------------------
// Defaults & small helpers.
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = 'https://kolm.ai';
const DEFAULT_MODEL = 'kolm-trinity';
const CHAT_PATH = '/v1/chat/completions';
const EMBED_PATH = '/v1/embeddings';

// Normalize a base URL: strip trailing slash + a trailing /v1, default to prod.
// Accepts either "https://host" or "https://host/v1" so callers can pass either
// the host or the OpenAI base.
function normalizeBaseUrl(raw) {
  let b = (raw == null ? '' : String(raw)).trim();
  if (!b) b = DEFAULT_BASE_URL;
  b = b.replace(/\/+$/, '');
  b = b.replace(/\/v1$/i, '');
  return b;
}

function normalizeModel(raw) {
  const m = (raw == null ? '' : String(raw)).trim();
  return m || DEFAULT_MODEL;
}

// Build the OpenAI-style base (host + /v1).
function openAiBase(baseUrl) {
  return normalizeBaseUrl(baseUrl) + '/v1';
}

// ---------------------------------------------------------------------------
// 1) Generic webhook action spec (Zapier / Make / n8n compatible).
//
// Zapier (Webhooks by Zapier -> Custom Request), Make (HTTP > Make a request)
// and n8n (HTTP Request node) all consume the same shape: method, url, headers,
// body. We describe a single high-value action -- "Run a kolm chat completion"
// -- and render the configurable inputs as fields[].
// ---------------------------------------------------------------------------
export function webhookActionSpec({ baseUrl, model } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const url = base + CHAT_PATH;
  const mdl = normalizeModel(model);

  return {
    name: 'kolm Chat Completion',
    description:
      'Send a prompt to your kolm model and receive a completion. ' +
      'Works in Zapier (Webhooks -> Custom Request), Make (HTTP module) ' +
      'and n8n (HTTP Request node).',
    // Canonical HTTP request the automation tool should make.
    request: {
      method: 'POST',
      url,
      headers: {
        Authorization: 'Bearer {{KOLM_API_KEY}}',
        'Content-Type': 'application/json',
      },
      // OpenAI-compatible chat body.
      body: {
        model: mdl,
        messages: [
          { role: 'system', content: '{{system_prompt}}' },
          { role: 'user', content: '{{user_prompt}}' },
        ],
        temperature: 0.2,
        stream: false,
      },
    },
    // UI fields each tool renders so a non-developer can configure the step.
    fields: [
      {
        key: 'KOLM_API_KEY',
        label: 'kolm API key',
        type: 'string',
        secret: true,
        required: true,
        help: 'Create one in your account under API keys. Starts with ks_.',
      },
      {
        key: 'model',
        label: 'Model',
        type: 'string',
        required: true,
        default: mdl,
        help: 'Your tenant model id, e.g. kolm-trinity or a distilled model.',
      },
      {
        key: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        required: false,
        default: 'You are a helpful assistant.',
      },
      {
        key: 'user_prompt',
        label: 'User prompt',
        type: 'text',
        required: true,
        help: 'Map this to the trigger field you want to send to the model.',
      },
    ],
    // Where to read the answer out of the JSON response in each tool.
    response: {
      contentType: 'application/json',
      resultPath: 'choices.0.message.content',
      usagePath: 'usage',
      receiptPath: 'x_kolm.receipt_id',
      examples: {
        zapier: '{{choices__0__message__content}}',
        make: '{{1.choices[0].message.content}}',
        n8n: '={{ $json.choices[0].message.content }}',
      },
    },
    // Copy-paste blocks per tool.
    snippets: {
      curl: curlSnippet({ baseUrl: base, model: mdl }),
      zapier: zapierInstructions({ baseUrl: base, model: mdl }),
      make: makeInstructions({ baseUrl: base, model: mdl }),
      n8n: n8nWorkflow({ baseUrl: base, model: mdl }),
    },
  };
}

export function curlSnippet({ baseUrl, model } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const mdl = normalizeModel(model);
  return [
    `curl ${base}${CHAT_PATH} \\`,
    `  -H "Authorization: Bearer $KOLM_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "model": "${mdl}",`,
    `    "messages": [{"role": "user", "content": "Hello from automation"}]`,
    `  }'`,
  ].join('\n');
}

export function zapierInstructions({ baseUrl, model } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '1. Add an action: "Webhooks by Zapier" -> "Custom Request".',
    '2. Method: POST',
    `3. URL: ${base}${CHAT_PATH}`,
    '4. Data Pass-Through?: No',
    '5. Data (JSON):',
    '   {',
    `     "model": "${mdl}",`,
    '     "messages": [',
    '       {"role": "user", "content": "{{trigger field}}"}',
    '     ]',
    '   }',
    '6. Headers:',
    '   Authorization | Bearer YOUR_KOLM_API_KEY',
    '   Content-Type  | application/json',
    '7. Use the reply in later steps via:',
    '   {{choices__0__message__content}}',
  ].join('\n');
}

export function makeInstructions({ baseUrl, model } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '1. Add module: "HTTP" -> "Make a request".',
    `2. URL: ${base}${CHAT_PATH}`,
    '3. Method: POST',
    '4. Headers:',
    '   Authorization: Bearer YOUR_KOLM_API_KEY',
    '   Content-Type: application/json',
    '5. Body type: Raw, Content type: JSON (application/json)',
    '6. Request content:',
    '   {',
    `     "model": "${mdl}",`,
    '     "messages": [{"role": "user", "content": "{{1.text}}"}]',
    '   }',
    '7. Parse response: Yes',
    '8. Read the answer at: {{2.choices[0].message.content}}',
  ].join('\n');
}

// A ready-to-import n8n workflow (importable JSON). Two nodes: a manual trigger
// and an HTTP Request node hitting the gateway.
export function n8nWorkflow({ baseUrl, model } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const mdl = normalizeModel(model);
  return {
    name: 'kolm Chat Completion',
    nodes: [
      {
        parameters: {},
        id: 'trigger',
        name: 'When clicking Test workflow',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [240, 300],
      },
      {
        parameters: {
          method: 'POST',
          url: base + CHAT_PATH,
          authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth',
          sendHeaders: true,
          headerParameters: {
            parameters: [{ name: 'Content-Type', value: 'application/json' }],
          },
          sendBody: true,
          specifyBody: 'json',
          jsonBody:
            '{\n  "model": "' +
            mdl +
            '",\n  "messages": [{"role": "user", "content": "Hello from n8n"}]\n}',
          options: {},
        },
        id: 'kolm',
        name: 'kolm Gateway',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [480, 300],
        credentials: {
          httpHeaderAuth: {
            id: 'KOLM_HEADER_AUTH',
            name: 'kolm API (Authorization: Bearer ks_...)',
          },
        },
      },
    ],
    connections: {
      'When clicking Test workflow': {
        main: [[{ node: 'kolm Gateway', type: 'main', index: 0 }]],
      },
    },
    settings: {},
    meta: {
      note:
        'Create a "Header Auth" credential named "kolm API" with ' +
        'Name=Authorization and Value="Bearer YOUR_KOLM_API_KEY". ' +
        'Read the reply at $json.choices[0].message.content.',
    },
  };
}

// ---------------------------------------------------------------------------
// 2) LangChain / LlamaIndex / OpenAI-SDK usage-snippet generators.
//
// Every generator takes a tenant model + base URL and returns copyable code.
// They all point at the gateway's OpenAI-compatible base, which is the
// supported way to target an OpenAI-compatible server in each framework.
// ---------------------------------------------------------------------------
export function langchainPython({ baseUrl, model } = {}) {
  const base = openAiBase(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '# pip install langchain-openai',
    'import os',
    'from langchain_openai import ChatOpenAI',
    '',
    'llm = ChatOpenAI(',
    `    model="${mdl}",`,
    `    base_url="${base}",`,
    '    api_key=os.environ["KOLM_API_KEY"],  # ks_...',
    '    temperature=0.2,',
    ')',
    '',
    'resp = llm.invoke("Summarize the kolm receipt model in one line.")',
    'print(resp.content)',
  ].join('\n');
}

export function langchainJs({ baseUrl, model } = {}) {
  const base = openAiBase(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '// npm i @langchain/openai',
    'import { ChatOpenAI } from "@langchain/openai";',
    '',
    'const llm = new ChatOpenAI({',
    `  model: "${mdl}",`,
    '  apiKey: process.env.KOLM_API_KEY, // ks_...',
    '  configuration: {',
    `    baseURL: "${base}",`,
    '  },',
    '  temperature: 0.2,',
    '});',
    '',
    'const res = await llm.invoke("Hello from LangChain.js");',
    'console.log(res.content);',
  ].join('\n');
}

export function langchainEmbeddingsPython({ baseUrl } = {}) {
  const base = openAiBase(baseUrl);
  return [
    '# pip install langchain-openai',
    'import os',
    'from langchain_openai import OpenAIEmbeddings',
    '',
    'embeddings = OpenAIEmbeddings(',
    '    model="kolm-embed",',
    `    base_url="${base}",`,
    '    api_key=os.environ["KOLM_API_KEY"],',
    ')',
    '',
    'vec = embeddings.embed_query("vectorize me")',
    'print(len(vec))',
  ].join('\n');
}

export function llamaindexPython({ baseUrl, model } = {}) {
  const base = openAiBase(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '# pip install llama-index-llms-openai-like',
    'import os',
    'from llama_index.llms.openai_like import OpenAILike',
    '',
    'llm = OpenAILike(',
    `    model="${mdl}",`,
    `    api_base="${base}",`,
    '    api_key=os.environ["KOLM_API_KEY"],  # ks_...',
    '    is_chat_model=True,',
    '    context_window=8192,',
    ')',
    '',
    'print(llm.complete("Explain kolm distillation in one sentence."))',
  ].join('\n');
}

export function openaiSdkPython({ baseUrl, model } = {}) {
  const base = openAiBase(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '# pip install openai',
    'import os',
    'from openai import OpenAI',
    '',
    'client = OpenAI(',
    `    base_url="${base}",`,
    '    api_key=os.environ["KOLM_API_KEY"],',
    ')',
    '',
    'resp = client.chat.completions.create(',
    `    model="${mdl}",`,
    '    messages=[{"role": "user", "content": "Hello, kolm"}],',
    ')',
    'print(resp.choices[0].message.content)',
  ].join('\n');
}

export function openaiSdkNode({ baseUrl, model } = {}) {
  const base = openAiBase(baseUrl);
  const mdl = normalizeModel(model);
  return [
    '// npm i openai',
    'import OpenAI from "openai";',
    '',
    'const client = new OpenAI({',
    `  baseURL: "${base}",`,
    '  apiKey: process.env.KOLM_API_KEY,',
    '});',
    '',
    'const resp = await client.chat.completions.create({',
    `  model: "${mdl}",`,
    '  messages: [{ role: "user", content: "Hello, kolm" }],',
    '});',
    'console.log(resp.choices[0].message.content);',
  ].join('\n');
}

// Public, parameterized snippet generator. Given a tenant model + base URL,
// returns every copyable snippet keyed by framework/target.
export function generateSnippets({ baseUrl, model } = {}) {
  const ctx = {
    baseUrl: normalizeBaseUrl(baseUrl),
    model: normalizeModel(model),
  };
  return {
    base_url: openAiBase(ctx.baseUrl),
    model: ctx.model,
    targets: {
      curl: curlSnippet(ctx),
      'openai-python': openaiSdkPython(ctx),
      'openai-node': openaiSdkNode(ctx),
      'langchain-python': langchainPython(ctx),
      'langchain-js': langchainJs(ctx),
      'langchain-embeddings-python': langchainEmbeddingsPython(ctx),
      'llamaindex-python': llamaindexPython(ctx),
    },
  };
}

// ---------------------------------------------------------------------------
// 3) OpenAPI / connector manifest for the gateway.
//
// A compact OpenAPI 3.1 document describing the gateway endpoints that
// connectors consume. This is what you upload to ChatGPT "Actions", Zapier
// "AI Actions / OpenAPI", or any tool that ingests an OpenAPI manifest.
// ---------------------------------------------------------------------------
export function connectorManifest({ baseUrl, model } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const apiBase = openAiBase(base);
  const mdl = normalizeModel(model);

  return {
    openapi: '3.1.0',
    info: {
      title: 'kolm Gateway (OpenAI-compatible)',
      version: '1.0.0',
      description:
        'OpenAI-compatible chat + embeddings gateway for kolm tenant models. ' +
        'Authenticate with a Bearer API key (ks_...).',
      'x-kolm': {
        default_model: mdl,
        receipts:
          'Responses include an x_kolm.receipt_id you can verify at /v1/verify/:id',
      },
    },
    servers: [{ url: apiBase, description: 'kolm OpenAI-compatible base' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'ks_*' },
      },
      schemas: {
        ChatMessage: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: { type: 'string' },
          },
        },
        ChatRequest: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: { type: 'string', default: mdl },
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/ChatMessage' },
            },
            temperature: { type: 'number', default: 0.2 },
            stream: { type: 'boolean', default: false },
          },
        },
        EmbeddingRequest: {
          type: 'object',
          required: ['model', 'input'],
          properties: {
            model: { type: 'string', default: 'kolm-embed' },
            input: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/chat/completions': {
        post: {
          operationId: 'createChatCompletion',
          summary: 'Create a chat completion',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatRequest' },
              },
            },
          },
          responses: {
            200: { description: 'OpenAI-compatible chat completion' },
          },
        },
      },
      '/embeddings': {
        post: {
          operationId: 'createEmbedding',
          summary: 'Create embeddings',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EmbeddingRequest' },
              },
            },
          },
          responses: { 200: { description: 'OpenAI-compatible embeddings' } },
        },
      },
      '/models': {
        get: {
          operationId: 'listModels',
          summary: 'List available tenant models',
          responses: { 200: { description: 'OpenAI-compatible model list' } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 4) Connector catalog + recipe assembly.
//
// Static metadata for each connector. The heavy, parameterized payload
// (snippets, specs) is built lazily in buildRecipe() so list responses stay
// small. EMBED_PATH is referenced in the manifest's embeddings path above.
// ---------------------------------------------------------------------------
void EMBED_PATH; // referenced for documentation symmetry with CHAT_PATH

const CONNECTOR_META = [
  {
    id: 'zapier',
    name: 'Zapier',
    category: 'automation',
    kind: 'webhook',
    tagline: 'Trigger kolm completions from 6,000+ Zapier apps.',
    docs: 'https://zapier.com/apps/webhook/integrations',
  },
  {
    id: 'make',
    name: 'Make (Integromat)',
    category: 'automation',
    kind: 'webhook',
    tagline: 'Call the kolm gateway from any Make scenario via the HTTP module.',
    docs: 'https://www.make.com/en/help/tools/http',
  },
  {
    id: 'n8n',
    name: 'n8n',
    category: 'automation',
    kind: 'webhook',
    tagline: 'Importable n8n workflow using the HTTP Request node.',
    docs: 'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/',
  },
  {
    id: 'langchain',
    name: 'LangChain',
    category: 'framework',
    kind: 'snippet',
    tagline: 'Drop-in ChatOpenAI / OpenAIEmbeddings pointed at kolm.',
    docs: 'https://python.langchain.com/docs/integrations/chat/openai/',
  },
  {
    id: 'llamaindex',
    name: 'LlamaIndex',
    category: 'framework',
    kind: 'snippet',
    tagline: 'OpenAILike LLM adapter wired to the kolm gateway.',
    docs: 'https://docs.llamaindex.ai/',
  },
  {
    id: 'openai-sdk',
    name: 'OpenAI SDK',
    category: 'framework',
    kind: 'snippet',
    tagline: 'Point the official OpenAI Python/Node SDK at base_url.',
    docs: 'https://platform.openai.com/docs/libraries',
  },
  {
    id: 'openapi',
    name: 'OpenAPI / Actions',
    category: 'manifest',
    kind: 'manifest',
    tagline: 'OpenAPI 3.1 manifest for ChatGPT Actions, Zapier AI, etc.',
    docs: 'https://spec.openapis.org/oas/v3.1.0',
  },
];

// Build the full recipe payload for a single connector id.
function buildRecipe(meta, ctx) {
  const base = { ...meta };
  switch (meta.kind) {
    case 'webhook': {
      const spec = webhookActionSpec(ctx);
      const toolSnippet =
        meta.id === 'zapier'
          ? spec.snippets.zapier
          : meta.id === 'make'
            ? spec.snippets.make
            : meta.id === 'n8n'
              ? spec.snippets.n8n
              : spec.snippets.curl;
      return { ...base, spec, primary_snippet: toolSnippet, curl: spec.snippets.curl };
    }
    case 'snippet': {
      const all = generateSnippets(ctx);
      let targets;
      if (meta.id === 'langchain') {
        targets = {
          'langchain-python': all.targets['langchain-python'],
          'langchain-js': all.targets['langchain-js'],
          'langchain-embeddings-python': all.targets['langchain-embeddings-python'],
        };
      } else if (meta.id === 'llamaindex') {
        targets = { 'llamaindex-python': all.targets['llamaindex-python'] };
      } else {
        targets = {
          'openai-python': all.targets['openai-python'],
          'openai-node': all.targets['openai-node'],
        };
      }
      return {
        ...base,
        base_url: all.base_url,
        model: all.model,
        snippets: targets,
        curl: all.targets.curl,
      };
    }
    case 'manifest': {
      return {
        ...base,
        manifest: connectorManifest(ctx),
        manifest_url: ctx.baseUrl + '/v1/connectors/openapi',
      };
    }
    default:
      return base;
  }
}

// GET /v1/connectors -- list all connectors (metadata only, with the live
// base_url/model baked in so the UI can render "for your tenant" copy).
export function listConnectors({ baseUrl, model } = {}) {
  const ctx = {
    baseUrl: normalizeBaseUrl(baseUrl),
    model: normalizeModel(model),
  };
  return {
    object: 'list',
    base_url: openAiBase(ctx.baseUrl),
    model: ctx.model,
    count: CONNECTOR_META.length,
    data: CONNECTOR_META.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      kind: m.kind,
      tagline: m.tagline,
      docs: m.docs,
      recipe_url: '/v1/connectors/' + m.id,
    })),
  };
}

// GET /v1/connectors/:id -- full recipe for one connector.
// Returns null if the id is unknown (caller should 404).
export function getConnector(id, { baseUrl, model } = {}) {
  const meta = CONNECTOR_META.find(
    (m) => m.id === String(id || '').toLowerCase(),
  );
  if (!meta) return null;
  const ctx = {
    baseUrl: normalizeBaseUrl(baseUrl),
    model: normalizeModel(model),
  };
  return { object: 'connector', ...buildRecipe(meta, ctx) };
}

// Convenience: list of valid ids.
export function connectorIds() {
  return CONNECTOR_META.map((m) => m.id);
}

export {
  CONNECTOR_META,
  normalizeBaseUrl,
  normalizeModel,
  openAiBase,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};

export default {
  listConnectors,
  getConnector,
  connectorIds,
  CONNECTOR_META,
  webhookActionSpec,
  zapierInstructions,
  makeInstructions,
  n8nWorkflow,
  generateSnippets,
  langchainPython,
  langchainJs,
  langchainEmbeddingsPython,
  llamaindexPython,
  openaiSdkPython,
  openaiSdkNode,
  curlSnippet,
  connectorManifest,
  normalizeBaseUrl,
  normalizeModel,
  openAiBase,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
