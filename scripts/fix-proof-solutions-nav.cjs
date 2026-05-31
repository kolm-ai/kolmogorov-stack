// Fix proof.html + solutions.html nav: they ended up with the plain W221 marker
// block (no logo/CTA) after the double-nav cleanup. Restore the single BRANDED
// chrome nav (nav.js injectSiteChrome fills <div data-include-nav>) and drop the
// duplicate marker block. Footer stays as the after-main data-include-footer slot.
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');

for (const f of ['proof.html', 'solutions.html']) {
  const full = path.join(PUB, f);
  let s = fs.readFileSync(full, 'utf8');
  // Remove the W221 marker nav block (the plain duplicate).
  s = s.replace(/[ \t]*<!-- KOLM_NAV_BEGIN \(W221\) -->[\s\S]*?<!-- KOLM_NAV_END \(W221\) -->\n?/, '');
  // Ensure the branded chrome slot is present right after the skip link.
  if (!s.includes('data-include-nav')) {
    s = s.replace(
      /(<a href="#main" class="ks-skip">Skip to content<\/a>\n)/,
      '$1<div data-include-nav></div>\n',
    );
  }
  fs.writeFileSync(full, s);
  console.log(`${f}: marker removed, data-include-nav present = ${s.includes('data-include-nav')}, marker present = ${s.includes('KOLM_NAV_BEGIN')}`);
}
