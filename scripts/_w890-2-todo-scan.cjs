// W890-2 — TODO/FIXME/HACK/XXX inventory across src/, cli/, workers/, scripts/.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const TARGETS = ['src', 'cli', 'workers', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'data', '__pycache__']);

function walk(d, out = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(m?js|cjs|py)$/.test(ent.name)) out.push(full);
  }
  return out;
}

// Marker matches uppercase keywords, but only after a comment lead (// or # or /*).
// Avoid matching string literals that contain "TODO" or function names.
const RX = /(?:\/\/|#|\/\*|\*)\s*([A-Z]+(?:-[A-Z0-9_]+)?)?\s*(TODO|FIXME|HACK|XXX)(?:\(([^)]+)\))?\b[:\s]/;

const all = [];
let total = 0;
const byFile = {};

for (const root of TARGETS) {
  const dir = path.join(ROOT, root);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = ln.match(RX);
      if (!m) continue;
      const marker = m[2];
      let owner = m[3] || null;  // text inside the parenthesis
      // Also accept owners that follow the marker without parens:
      //  "TODO https://..."  -> URL is owner ref
      //  "TODO W123: ..."    -> wave ref is owner
      //  "TODO @user: ..."   -> github handle is owner
      if (!owner) {
        const after = ln.slice(ln.indexOf(marker) + marker.length);
        const urlMatch = after.match(/^\s+(https?:\/\/\S+)/);
        const waveMatch = after.match(/^\s+(W\d{2,4}[A-Za-z0-9-]*)/);
        const userMatch = after.match(/^\s+(@[A-Za-z0-9_-]+)/);
        if (urlMatch) owner = urlMatch[1];
        else if (waveMatch) owner = waveMatch[1];
        else if (userMatch) owner = userMatch[1];
      }
      const rel = f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
      // Lines that are part of a string literal (i.e., enclosed in matching
      // quotes with a leading whitespace+quote and trailing quote+comma|close)
      // are user-facing template emissions, not source-code TODOs.
      const isUserFacingTemplate =
        /^\s*['"`].*\bTODO\b.*['"`][,)\]]/.test(ln);
      total++;
      const entry = {
        file: rel,
        line: i + 1,
        marker,
        owner,
        has_owner: !!owner || isUserFacingTemplate,
        kind: isUserFacingTemplate ? 'user_facing_template' : (owner ? 'tracked' : 'orphan'),
        text: ln.trim().slice(0, 200),
      };
      all.push(entry);
      (byFile[rel] ||= []).push(entry);
    }
  }
}

const withOwner = all.filter(e => e.has_owner).length;
const orphan = all.filter(e => e.kind === 'orphan').length;
const userFacing = all.filter(e => e.kind === 'user_facing_template').length;

// Marker family breakdown.
const byMarker = {};
for (const e of all) byMarker[e.marker] = (byMarker[e.marker] || 0) + 1;

const out = {
  total,
  with_owner: withOwner,
  orphan,
  user_facing_template: userFacing,
  by_marker: byMarker,
  rewritten: 0,  // We rewrite none in this pass; we document only.
  policy: 'Markers with owner refs (e.g., "TODO(W123-something)" or "TODO(@user)") are tracked. Orphan markers are surfaced for triage; the next mechanical pass either fixes inline or rewrites to "TODO(W890-2-followup): ...".',
  by_file: Object.entries(byFile)
    .map(([file, entries]) => ({ file, count: entries.length, entries }))
    .sort((a, b) => b.count - a.count),
};

fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-todos.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote w890-2-todos.json: total', total, 'with_owner', withOwner, 'orphan', orphan);
console.log('by_marker:', JSON.stringify(byMarker));
