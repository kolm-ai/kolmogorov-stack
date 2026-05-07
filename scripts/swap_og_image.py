"""Swap legacy og-card.svg references for the new /img/brand-og.png across
every public/*.html. Idempotent."""
import re
from pathlib import Path

ROOT = Path("C:/Users/user/Desktop/kolmogorov-stack/public")

# match any og:image / twitter:image content pointing to og-card.svg or hero-atmosphere
PATTERNS = [
    (re.compile(r'(content=")[^"]*og-card\.svg(")'), r'\1https://kolm.ai/img/brand-og.png\2'),
    (re.compile(r'(content=")[^"]*hero-atmosphere\.png(")'), r'\1https://kolm.ai/img/brand-og.png\2'),
]

total = 0
for html in sorted(ROOT.glob("*.html")):
    text = html.read_text(encoding="utf-8")
    new = text
    n_total = 0
    for pat, repl in PATTERNS:
        new, n = pat.subn(repl, new)
        n_total += n
    if n_total:
        html.write_text(new, encoding="utf-8")
        total += n_total
        print(f"  {html.name}: swapped {n_total}")

print(f"\ntotal: {total}")
