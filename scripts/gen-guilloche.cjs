#!/usr/bin/env node
// gen-guilloche.cjs — generates public/guilloche.svg, a faint guilloché rosette.
//
// Guilloché is the fine spirograph engraving on banknotes, passports and stock
// certificates — an anti-forgery motif almost never seen on software sites and
// dead-on for a tamper-evidence brand. We render it mathematically as a set of
// interfering "wave rings" r(θ) = R + A·sin(kθ + φ) plus a hypotrochoid rosette,
// hairline strokes in a cool obsidian-grey so it reads as engraving, not a CDN
// image. Output is a single self-hosted SVG (CSP: img-src 'self').
const fs = require('fs');
const path = require('path');

const SIZE = 640;
const C = SIZE / 2;
const STEPS = 720;
const TAU = Math.PI * 2;
const f = (n) => {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

function ring(R, A, k, phase) {
  let d = '';
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * TAU;
    const r = R + A * Math.sin(k * t + phase);
    d += (i === 0 ? 'M' : 'L') + f(C + r * Math.cos(t)) + ' ' + f(C + r * Math.sin(t));
  }
  return d + 'Z';
}

// hypotrochoid (spirograph) — the dense rosette at the centre. petals = closed
// figure in `petals` lobes over a single 2π sweep (no runaway turn count).
function rosette(R, amp, petals) {
  let out = '';
  const N = STEPS;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TAU;
    const r = R + amp * Math.cos(petals * t);
    out += (i === 0 ? 'M' : 'L') + f(C + r * Math.cos(t)) + ' ' + f(C + r * Math.sin(t));
  }
  return out + 'Z';
}

const rings = [];
// concentric interference rings
for (let n = 0; n < 9; n++) {
  const R = 70 + n * 24;
  const A = 9 + (n % 3) * 3;
  const k = 14 + n * 2;
  rings.push({ d: ring(R, A, k, (n * Math.PI) / 5), w: 0.5, o: 0.5 });
}
// a heavier guide ring + a fine inner ring
rings.push({ d: ring(300, 4, 60, 0), w: 0.7, o: 0.6 });
rings.push({ d: ring(46, 5, 22, 0), w: 0.5, o: 0.55 });
// central rosettes (rose curves — closed in one sweep)
rings.push({ d: rosette(120, 70, 12), w: 0.45, o: 0.45 });
rings.push({ d: rosette(165, 60, 18), w: 0.4, o: 0.38 });
rings.push({ d: rosette(60, 34, 7), w: 0.45, o: 0.5 });

const paths = rings
  .map((r) => `<path d="${r.d}" fill="none" stroke="#39414F" stroke-width="${r.w}" opacity="${r.o}"/>`)
  .join('\n  ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="presentation">
  ${paths}
</svg>\n`;

const out = path.join(__dirname, '..', 'public', 'guilloche.svg');
fs.writeFileSync(out, svg);
console.log('wrote', out, '(' + svg.length + ' bytes,', rings.length, 'engraved paths)');
