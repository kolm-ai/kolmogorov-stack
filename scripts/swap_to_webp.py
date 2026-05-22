"""Swap PNG references to WebP siblings across HTML/CSS, except for
og:image / twitter:image meta tags (Twitter parsers still expect PNG/JPG).
Idempotent."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public"

TARGETS = [
    "hero-artifact",
    "compile-distill",
    "mcp-fanout",
    "run-on-device",
    "verification-chain",
    "horizon-artifact",
    "brand-mark",
    "brand-glyph",
    # brand-og is intentionally excluded — needed for og:image PNG fallback
]

# Match /img/<name>.png NOT inside an og:image / twitter:image meta line.
# We do this conservatively: line-by-line, skip lines containing og:image or twitter:image.

def transform(text: str) -> tuple[str, int]:
    out_lines = []
    swaps = 0
    for line in text.splitlines(keepends=True):
        if 'og:image' in line or 'twitter:image' in line:
            out_lines.append(line)
            continue
        new_line = line
        for name in TARGETS:
            patt = f"/img/{name}.png"
            if patt in new_line:
                new_line = new_line.replace(patt, f"/img/{name}.webp")
                swaps += new_line.count(f"/img/{name}.webp") - line.count(f"/img/{name}.webp")
        out_lines.append(new_line)
    return "".join(out_lines), swaps

total = 0
for path in sorted(list(ROOT.glob("*.html")) + list(ROOT.glob("*.css")) + list(ROOT.glob("*.js"))):
    text = path.read_text(encoding="utf-8")
    new, n = transform(text)
    if n:
        path.write_text(new, encoding="utf-8")
        total += n
        print(f"  {path.name}: swapped {n}")

print(f"\ntotal: {total}")
