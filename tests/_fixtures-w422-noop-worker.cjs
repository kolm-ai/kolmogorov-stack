#!/usr/bin/env node
// W422 fixture — no-op distill worker. Reads CLI args, writes manifest.json
// into the --out= dir, exits 0. Keeps distill() from hanging on real ML.
const fs = require('fs');
const path = require('path');
const out = (process.argv.find(a => a.startsWith('--out=')) || '').slice('--out='.length);
if (out) {
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  try {
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
      ok: true, fixture: 'w422-noop', written_at: new Date().toISOString(),
    }, null, 2));
  } catch {}
}
process.exit(0);
