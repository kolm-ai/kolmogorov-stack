import fs from 'fs';

const FILES = [
  'public/quickstart.html',
  'public/anatomy.html',
  'public/k-score.html',
  'public/articles/ai-compiler.html',
  'public/articles/speculative-decoding-recipes.html',
  'public/customers.html',
  'public/defense.html',
  'public/finance.html',
];

const REPL = [
  [/Compile your <span class="tone">first artifact\.<\/span>/g, 'Compile your <span class="tone">first AI.</span>'],
  [/Compile your first artifact (<span aria-hidden="true">&rarr;<\/span>)/g, 'Compile your first AI $1'],
  [/Compile your first artifact in five minutes\./g, 'Compile your first AI in five minutes.'],
  [/Compile your first artifact in five minutes/g, 'Compile your first AI in five minutes'],
  [/Compile your first artifact and ship a recipe pack\./g, 'Compile your first AI and ship a recipe pack.'],
  [/compile the first artifact end-to-end/g, 'compile the first AI end-to-end'],
  [/compile your first artifact against your own examples/g, 'compile your first AI against your own examples'],
];

let totalReplaced = 0;
for (const f of FILES) {
  const orig = fs.readFileSync(f, 'utf8');
  let fixed = orig;
  let local = 0;
  for (const [re, sub] of REPL) {
    const m = fixed.match(re);
    if (m) local += m.length;
    fixed = fixed.replace(re, sub);
  }
  if (fixed !== orig) {
    fs.writeFileSync(f, fixed);
    totalReplaced += local;
    console.log(`${f}: ${local}`);
  } else {
    console.log(`${f}: 0 (no change)`);
  }
}
console.log(`total: ${totalReplaced}`);
