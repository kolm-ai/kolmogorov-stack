// @kolm/kolm-sdk - ES module entry point.
// Client for kolm account, registry, receipt, and recipe APIs.

const DEFAULT_BASE = "https://kolm.ai";
const SDK_VERSION = "0.1.0";

export class RecipeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RecipeError";
    this.status = status;
    this.body = body;
  }
}

export class RecipeClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || (typeof process !== "undefined" && process.env && (process.env.KOLM_BASE_URL || process.env.RECIPE_BASE_URL)) || DEFAULT_BASE).replace(/\/$/, "");
    this.apiKey = opts.apiKey
      || (typeof process !== "undefined" && process.env && (process.env.KOLM_API_KEY || process.env.RECIPE_API_KEY));
    this.fetcher = opts.fetch || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    if (!this.fetcher) throw new Error("fetch is not available; pass opts.fetch or run on Node 18+ / a modern browser.");
  }

  async _req(method, path, body, init = {}) {
    const url = this.baseUrl + path;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": `@kolm/kolm-sdk/${SDK_VERSION}`,
      ...(init.headers || {}),
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetcher(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        ...init,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    if (!res.ok) {
      const msg = (json && typeof json === "object" && typeof json.error === "string")
        ? json.error
        : `HTTP ${res.status} ${res.statusText}`;
      throw new RecipeError(msg, res.status, json);
    }
    return json;
  }

  // ---------- core (Layer 1) ----------
  synthesize(req)               { return this._req("POST", "/v1/synthesize", req); }
  synthesizeBatch(items)        { return this._req("POST", "/v1/synthesize/batch", { items }); }
  verify(source, examples)      { return this._req("POST", "/v1/verify", { source, positives: examples }); }
  run({ recipe_id, concept_id, version_id, input }) {
    const body = { input };
    if (recipe_id) body.concept_id = recipe_id;
    if (concept_id) body.concept_id = concept_id;
    if (version_id) body.version_id = version_id;
    return this._req("POST", "/v1/run", body);
  }

  // ---------- registry ----------
  list({ tag, q, limit } = {}) {
    const p = new URLSearchParams();
    if (tag) p.set("tag", tag);
    if (q) p.set("q", q);
    if (limit != null) p.set("limit", String(limit));
    const qs = p.toString() ? `?${p}` : "";
    return this._req("GET", `/v1/recipes${qs}`);
  }
  get(recipe_id)              { return this._req("GET", `/v1/recipes/${encodeURIComponent(recipe_id)}`); }
  stats(recipe_id)            { return this._req("GET", `/v1/recipes/${encodeURIComponent(recipe_id)}/stats`); }
  search(query, k = 5)        { return this._req("POST", "/v1/search", { query, k }); }
  compose(opts)               { return this._req("POST", "/v1/compose", opts); }

  // ---------- forward-looking (Phases C/D/E) ----------
  labelCorpus(recipe_id, opts = {}) {
    let corpus;
    if (opts.rows) corpus = { type: "inline", rows: opts.rows };
    else if (opts.hf_dataset) corpus = { type: "huggingface", name: opts.hf_dataset };
    else if (opts.url) corpus = { type: "url", url: opts.url };
    else throw new RecipeError("provide rows, hf_dataset, or url", 400, null);
    return this._req("POST", `/v1/recipes/${encodeURIComponent(recipe_id)}/label-corpus`, {
      corpus, max_rows: opts.max_rows, output_format: opts.output_format,
    });
  }
  job(id)                                     { return this._req("GET", `/v1/jobs/${encodeURIComponent(id)}`); }
  waitlistSpecialist(email, task)             { return this._req("POST", "/v1/specialists/waitlist", { email, task }); }
  trainSpecialist(req)                        { return this._req("POST", "/v1/specialists/train", req); }
  listSpecialists()                           { return this._req("GET", "/v1/specialists"); }
  getSpecialist(id)                           { return this._req("GET", `/v1/specialists/${encodeURIComponent(id)}`); }
  runSpecialist(id, input)                    { return this._req("POST", `/v1/specialists/${encodeURIComponent(id)}/run`, { input }); }

  // ---------- public + account ----------
  featured()                                  { return this._req("GET", "/v1/public/featured"); }
  publicConcepts()                            { return this._req("GET", "/v1/public/concepts"); }
  publicRun({ concept_id, version_id, input }) {
    return this._req("POST", "/v1/public/run", { concept_id, version_id, input });
  }
  account()                                   { return this._req("GET", "/v1/account"); }
  rotateKey()                                 { return this._req("POST", "/v1/account/rotate-key"); }
  signup(email, name)                         { return this._req("POST", "/v1/signup", { email, name }); }
  health()                                    { return this._req("GET", "/health"); }

  // ---------- anonymous CLI auth (autonomous bootstrap for agents/robots) ----------
  // No email, no signup: agents call this on first run, store the kao_ token locally,
  // and have 30 days of full functionality before they have to claim or expire.
  bootstrapAnonymous(meta = {}) {
    return this._req("POST", "/v1/anon/bootstrap", {
      user_agent: meta.user_agent || `@kolm/kolm-sdk/${SDK_VERSION}`,
      hostname: meta.hostname || null,
    });
  }
  // Convert an anonymous workspace to a real account. Body takes anon_token + email.
  // Returns {mode: 'merged'|'upgraded', api_key, tenant}.
  claimAnonymous(anon_token, email, name) {
    return this._req("POST", "/v1/anon/claim", { anon_token, email, name });
  }

  // ---------- W734: RAG-aware capture ----------
  // captureWithContext({prompt, retrieved, response, namespace}) logs a
  // capture row WITH the retrieved chunks the upstream LLM was shown.
  //
  // `retrieved` is an array of `{source, text, score?}` items — one per
  // chunk that landed in the LLM's context window. Each item must have a
  // `source` (URL/document id) and `text` (the chunk content); `score` is
  // optional (the retriever's similarity score).
  //
  // The array is JSON-stringified and base64-encoded onto the
  // `kolm-retrieved-context` request header so structured chunks survive
  // HTTP escaping. The server (W734-1) parses the header and persists the
  // chunks on the capture row alongside prompt + response — the W734-2
  // training-data formatter prefixes them as `<RETRIEVED>` blocks at
  // distill time. Mirrors the Python SDK's capture_with_context.
  //
  // Returns the server JSON envelope. On a malformed header the server
  // returns 400 with `error:'invalid_retrieved_context_header'` so the
  // caller can fail loud.
  async captureWithContext({ prompt, retrieved, response, namespace = "default" } = {}) {
    if (typeof prompt !== "string" || !prompt) {
      throw new RecipeError("captureWithContext: prompt (non-empty string) required", 400, null);
    }
    if (typeof response !== "string") {
      throw new RecipeError("captureWithContext: response (string) required", 400, null);
    }
    if (!Array.isArray(retrieved)) {
      throw new RecipeError("captureWithContext: retrieved must be an array of {source, text, score?}", 400, null);
    }
    for (let i = 0; i < retrieved.length; i++) {
      const it = retrieved[i];
      if (!it || typeof it !== "object" || typeof it.source !== "string" || typeof it.text !== "string") {
        throw new RecipeError(`captureWithContext: retrieved[${i}] must have 'source' and 'text' string fields`, 400, null);
      }
    }
    const payloadJson = JSON.stringify(retrieved);
    // Node 18+ + modern browsers both have Buffer (Node) or btoa (browser).
    let headerVal;
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      headerVal = Buffer.from(payloadJson, "utf8").toString("base64");
    } else if (typeof btoa === "function") {
      // btoa is byte-safe for ASCII; for non-ASCII we'd need encodeURIComponent
      // round-trip. JSON.stringify already escapes non-ASCII as \uXXXX so the
      // payload string is ASCII-safe here.
      headerVal = btoa(payloadJson);
    } else {
      throw new RecipeError("captureWithContext: no base64 encoder available (need Buffer or btoa)", 500, null);
    }
    return this._req("POST", "/v1/capture/log", {
      namespace,
      items: [{ input: prompt, output: response }],
      provider: "manual",
    }, {
      headers: { "kolm-retrieved-context": headerVal },
    });
  }
}

export class KolmClient extends RecipeClient {}

// ---------- Convenience: drop-in replacements for repeat LLM-as-judge calls ----------
let _defaultClient = null;
function _client() {
  if (!_defaultClient) _defaultClient = new RecipeClient();
  return _defaultClient;
}

async function _runByName(name, input) {
  const c = _client();
  const { featured } = await c.featured();
  const found = featured.find(r => r.name === name);
  if (!found) throw new RecipeError(`recipe "${name}" not in public registry yet`, 404, null);
  const r = await c.run({ recipe_id: found.id, input });
  return r.output;
}

export const recipe = {
  isSpam:           (text) => _runByName("is-spam", text),
  classifyIntent:   (text) => _runByName("classify-intent", text),
  detectLanguage:   (text) => _runByName("classify-language", text),
  sentiment:        (text) => _runByName("sentiment", text),
  isQuestion:       (text) => _runByName("is-question", text),
  classifyToxicity: (text) => _runByName("classify-toxicity", text),
  extractEmails:    (text) => _runByName("extract-emails", text),
  classifyIssue:    (text) => _runByName("classify-issue-type", text),
};

export default KolmClient;
