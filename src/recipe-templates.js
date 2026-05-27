// W910 Track C1 - recipe template loader.
//
// Backs GET /v1/recipes/templates and GET /v1/recipes/templates/:name with
// the JSON files in data/recipes/templates/. Templates are read from disk
// each call (small file count, cheap) so an operator can hand-edit one
// without restarting the server.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'data', 'recipes', 'templates');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function templatesDir() { return TEMPLATES_DIR; }

export function listTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  const entries = fs.readdirSync(TEMPLATES_DIR);
  const out = [];
  for (const fname of entries) {
    if (!fname.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, fname), 'utf8');
      const t = JSON.parse(raw);
      if (t && typeof t === 'object' && t.name) out.push(t);
    } catch { /* skip broken */ }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

export function getTemplate(name) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const p = path.join(TEMPLATES_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
