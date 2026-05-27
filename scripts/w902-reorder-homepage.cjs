#!/usr/bin/env node
// W902-C3: Move proof/loop/integrations/meta-demo blocks above the finale CTA.
// The W706 vs-gateways tiny strip stays under the CTA per its in-file directive.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(FILE, 'utf8');

const MOVE_START = '<!-- ============================================================ -->\n<!-- W404 numbers strip                                            -->';
const MOVE_END = '<script defer src="/assistant-widget.js"></script>';

const startIdx = html.indexOf(MOVE_START);
if (startIdx < 0) { console.error('FATAL: move-start anchor missing'); process.exit(1); }
const endAnchor = html.indexOf(MOVE_END, startIdx);
if (endAnchor < 0) { console.error('FATAL: move-end anchor missing'); process.exit(1); }
const endIdx = endAnchor + MOVE_END.length;

const moved = html.slice(startIdx, endIdx);
const tailNewlines = html.slice(endIdx).match(/^\s*/)[0];

const FINALE_ANCHOR = '<!-- ================== Finale ================== -->';
const finaleIdx = html.indexOf(FINALE_ANCHOR);
if (finaleIdx < 0) { console.error('FATAL: finale anchor missing'); process.exit(1); }
if (startIdx < finaleIdx) {
  console.error('NOOP: block already appears before finale; refusing to double-move.');
  process.exit(0);
}

const withoutMoved = html.slice(0, startIdx) + html.slice(endIdx + tailNewlines.length);

const newFinaleIdx = withoutMoved.indexOf(FINALE_ANCHOR);
if (newFinaleIdx < 0) { console.error('FATAL: finale anchor lost'); process.exit(1); }

const out = withoutMoved.slice(0, newFinaleIdx) + moved + '\n\n' + withoutMoved.slice(newFinaleIdx);

fs.writeFileSync(FILE, out);

const beforeMatch = out.indexOf('data-w404="numbers-strip"');
const finaleMatch = out.indexOf('class="ks-finale"');
console.log(`numbers-strip @ ${beforeMatch}, finale @ ${finaleMatch}, order ${beforeMatch < finaleMatch ? 'OK' : 'FAIL'}`);
