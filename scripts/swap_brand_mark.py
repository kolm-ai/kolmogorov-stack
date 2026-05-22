"""Swap the legacy 24x24 K-letterform brand mark for the new 3-bar pyramid
mark across every public/*.html page. Idempotent."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public"

# match the K-letterform path in any svg of viewBox 0 0 24 24, regardless of
# extra attributes or whitespace
OLD = re.compile(
    r'<svg([^>]*viewBox="0 0 24 24"[^>]*)>\s*'
    r'(?:<g[^>]*>\s*)?'
    r'<path[^/]*d="M 6\.5 4 L 6\.5 20 M 6\.5 13\.4 L 14\.6 4\.6 M 9\.4 10\.6 L 17\.5 19\.4"[^/]*/>'
    r'(?:\s*</g>)?'
    r'\s*</svg>',
    re.MULTILINE | re.DOTALL,
)


def replace_one(match, idx):
    svg_attrs = match.group(1)
    # preserve width/height attrs if present, drop stroke-related (we use fill)
    keep = re.findall(r'(width|height)="[^"]*"', svg_attrs)
    extra = " " + " ".join(keep) if keep else ""
    gid = f"kbar-pg-{idx}"
    return (
        f'<svg viewBox="0 0 24 24"{extra} fill="none" aria-hidden="true">'
        f'<defs><linearGradient id="{gid}" x1="0%" y1="0%" x2="100%" y2="0%">'
        f'<stop offset="0%" stop-color="#a8b3ff"/>'
        f'<stop offset="50%" stop-color="#7c8cff"/>'
        f'<stop offset="100%" stop-color="#a8b3ff"/></linearGradient></defs>'
        f'<rect x="8" y="6" width="8" height="1.4" rx="0.7" fill="url(#{gid})"/>'
        f'<rect x="6" y="11.2" width="12" height="1.4" rx="0.7" fill="url(#{gid})"/>'
        f'<rect x="4" y="16.4" width="16" height="1.4" rx="0.7" fill="url(#{gid})"/>'
        f'</svg>'
    )


def swap_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    counter = [0]

    def repl(m):
        counter[0] += 1
        return replace_one(m, counter[0])

    new_text, n = OLD.subn(repl, text)
    if n:
        path.write_text(new_text, encoding="utf-8")
    return n


total = 0
for html in sorted(ROOT.glob("*.html")):
    n = swap_file(html)
    if n:
        total += n
        print(f"  {html.name}: swapped {n} mark{'s' if n > 1 else ''}")

print(f"\ntotal: {total}")
