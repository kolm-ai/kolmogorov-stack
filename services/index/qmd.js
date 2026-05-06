// qmd adapter — Recall backend powered by github.com/tobi/qmd.
//
// qmd does BM25 + vector + RRF + LLM reranking, all locally via GGUF.
// We wrap it so the kolm compile orchestrator can ground Distill calls
// in the user's own corpus without us having to implement, host, or
// pay for embedders + a vector DB. The user runs qmd locally; the cloud
// only ever sees the {recall_chunks} the user opted to send.
//
// Three surfaces:
//   add(namespace, paths)       — register a directory or files
//   embed(namespace?)           — generate embeddings (qmd embed)
//   query(namespace, q, k)      — hybrid query, returns chunks
//   status(namespace?)          — index health
//
// We shell out to the qmd CLI. If the user has the MCP HTTP transport
// running (`qmd mcp --http --daemon`) we prefer that for sub-second
// latency on warm models; otherwise stdio works fine.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function qmdBin() {
  return process.env.QMD_BIN || 'qmd';
}

function qmdHttp() {
  return process.env.QMD_MCP_URL || null;  // e.g. http://localhost:8181/mcp
}

function run(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(qmdBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`qmd ${args.join(' ')} exited ${code}: ${err.trim()}`));
      resolve(out);
    });
    if (input) proc.stdin.write(input);
    proc.stdin.end();
  });
}

// HTTP MCP transport (preferred when the user runs `qmd mcp --http --daemon`).
async function mcpCall(method, params) {
  const url = qmdHttp();
  if (!url) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: params } }),
  });
  if (!r.ok) throw new Error('qmd mcp http: ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('qmd mcp: ' + j.error.message);
  return j.result;
}

export async function isAvailable() {
  try {
    if (qmdHttp()) {
      const r = await fetch(qmdHttp().replace(/\/mcp$/, '/health'));
      if (r.ok) return { available: true, transport: 'http' };
    }
    await run(['--version']);
    return { available: true, transport: 'cli' };
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

// Add a directory or set of files to a named collection.
export async function addCollection({ name, paths }) {
  for (const p of [].concat(paths || [])) {
    await run(['collection', 'add', p, '--name', name]);
  }
  return { ok: true };
}

// Generate embeddings for a collection (or all). Long-running; the caller
// should await and surface a "generating embeddings…" UI state.
export async function embed({ name } = {}) {
  const args = ['embed'];
  if (name) args.push('-c', name);
  await run(args);
  return { ok: true };
}

// Hybrid query — returns the top-k chunks. Each chunk is the qmd-emitted
// JSON record: { docid, path, score, snippet, ... }.
export async function query({ namespace, query: q, k = 12 }) {
  // HTTP transport — uses MCP `query` tool.
  const http = qmdHttp();
  if (http) {
    try {
      const r = await mcpCall('query', { query: q, collection: namespace, n: k });
      if (Array.isArray(r?.content)) {
        return r.content.map(c => parseChunk(c)).filter(Boolean).slice(0, k);
      }
    } catch (e) { /* fall through to CLI */ }
  }
  // CLI transport — `qmd query "<q>" -c <ns> --json -n <k>`
  const args = ['query', q, '--json', '-n', String(k)];
  if (namespace) { args.push('-c', namespace); }
  const out = await run(args);
  let parsed;
  try { parsed = JSON.parse(out); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = parsed?.results || [];
  return parsed.slice(0, k).map(normalizeChunk);
}

function parseChunk(c) {
  if (typeof c === 'string') return { snippet: c };
  return normalizeChunk(c);
}

function normalizeChunk(c) {
  return {
    docid: c.docid || c.id || null,
    path: c.path || null,
    score: typeof c.score === 'number' ? c.score : null,
    snippet: c.snippet || c.excerpt || c.text || '',
    collection: c.collection || null,
  };
}

export async function status({ name } = {}) {
  const args = ['status'];
  if (name) args.push('-c', name);
  try {
    const out = await run([...args, '--json']);
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
