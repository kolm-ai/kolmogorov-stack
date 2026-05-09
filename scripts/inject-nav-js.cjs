const fs = require('fs');
const targets = [
  'public/account.html', 'public/api.html', 'public/build-your-own.html',
  'public/compare.html', 'public/cookbook.html', 'public/dashboard.html',
  'public/docs.html', 'public/edge.html', 'public/how-it-works.html',
  'public/index.html', 'public/legal.html', 'public/quickstart.html',
  'public/run.html', 'public/signup.html'
];
const tag = '<script src="/nav.js" defer></script>';
let touched = 0;
for (const f of targets) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { console.warn('miss', f); continue; }
  if (s.includes('/nav.js')) continue;
  if (!s.includes('</body>')) { console.warn('no </body> in', f); continue; }
  s = s.replace('</body>', tag + '\n</body>');
  fs.writeFileSync(f, s);
  touched++;
}
console.log('nav.js injected into', touched, 'files');
