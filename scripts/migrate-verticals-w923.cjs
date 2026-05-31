// W923 vertical merge: the -v2 microsites are richer than their v1 pages, so we
// PROMOTE v2 content into the canonical slug (rewriting the self-URL v2 -> base)
// and convert the -v2 URL to a redirect stub. devtools has no v1, so it is
// promoted to a new /devtools. healthcare was already retired (v1 canonical).
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');

// [v2 slug, base slug]
const JOBS = [
  ['defense-v2', 'defense'],
  ['finance-v2', 'finance'],
  ['legal-v2', 'legal'],
  ['devtools-v2', 'devtools'],
];

function stub(base) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Redirecting to /${base} · kolm.ai</title>
<meta name="description" content="Redirecting to /${base} · kolm.ai. kolm.ai is the open-source AI compiler: capture real prompts, compile your own model, run it on hardware you control, and audit every call.">
<link rel="canonical" href="https://kolm.ai/${base}">
<meta http-equiv="refresh" content="0; url=/${base}">
<meta name="robots" content="noindex,follow">
<script>location.replace('/${base}');</script>
<meta property="og:title" content="Redirecting to /${base} · kolm.ai">
<meta property="og:description" content="Redirecting to /${base} · kolm.ai. kolm.ai is the open-source AI compiler: capture real prompts, compile your own model, run it on hardware you control, and audit every call.">
<meta property="og:url" content="https://kolm.ai/${base}-v2">
<meta property="og:type" content="website">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"kolm","applicationCategory":"DeveloperApplication","operatingSystem":"Linux, macOS, Windows (WSL)","url":"https://kolm.ai/${base}","description":"Redirecting to /${base} · kolm.ai. kolm.ai is the open-source AI compiler.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"publisher":{"@type":"Organization","name":"kolm.ai","@id":"https://kolm.ai/#org"}}
</script>
</head>
<body>
<span class="brand-anchor" style="position:absolute;left:-9999px" aria-hidden="true">kolm.ai - the AI compiler. Not Kolm therapeutics, Kolm band, Kolm engines, or Petter Kolm.</span>
<p>This page has moved to <a href="/${base}">/${base}</a>.</p>
</body>
</html>
`;
}

for (const [v2, base] of JOBS) {
  const v2path = path.join(PUB, `${v2}.html`);
  const basepath = path.join(PUB, `${base}.html`);
  const content = fs.readFileSync(v2path, 'utf8');
  // Promote: rewrite the page's own URL (canonical, og:url, JSON-LD url) v2 -> base.
  // Leaves og:image (/og/<slug>-v2.svg) untouched (that asset exists).
  const promoted = content.split(`https://kolm.ai/${v2}`).join(`https://kolm.ai/${base}`);
  const hadBase = fs.existsSync(basepath);
  fs.writeFileSync(basepath, promoted);
  fs.writeFileSync(v2path, stub(base));
  console.log(`promoted ${v2} -> /${base} (${promoted.length}B, base ${hadBase ? 'overwritten' : 'created'}); stubbed ${v2}`);
}
