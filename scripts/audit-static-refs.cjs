const fs = require("fs");
const path = require("path");

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (e.name.endsWith(".html")) out.push(f);
  }
  return out;
}

const checks = [
  { name: "img src", re: /<img[^>]+src="(\/[^"#?]+\.(?:png|jpg|jpeg|webp|gif|avif|svg))"/gi },
  { name: "script src", re: /<script[^>]+src="(\/[^"#?]+\.(?:js|mjs))"/gi },
  { name: "link href", re: /<link[^>]+href="(\/[^"#?]+\.(?:css|svg|png|webp|ico))"/gi },
];

let bad = 0;
for (const f of walk("public")) {
  if (f.includes("_archive")) continue;
  const s = fs.readFileSync(f, "utf8");
  for (const c of checks) {
    c.re.lastIndex = 0;
    let m;
    while ((m = c.re.exec(s)) !== null) {
      const p = "public" + m[1];
      if (!fs.existsSync(p)) {
        console.error(`MISSING ${c.name}: ${f} -> ${m[1]}`);
        bad++;
      }
    }
  }
}
console.log("missing static refs:", bad);
process.exit(bad ? 1 : 0);
