"""
Swap every legacy-K mark with the new fold mark across all public/*.html.
Catches three variants:
  1. <svg class="mark" viewBox="0 0 28 28" ...>  (homepage style)
  2. <svg viewBox="0 0 24 24" ...> with kbar-pg-* gradient (other-page style)
  3. footer-only stacked rects with stroke-only kbar gradient (less common)
Idempotent.
"""
import re
import pathlib

NEW_MARK_HEADER = '''<svg class="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M 5 5 L 21 5 L 27 11 L 27 27 L 5 27 Z" fill="currentColor"/>
          <path d="M 21 5 L 21 11 L 27 11 Z" fill="#7c8cff"/>
        </svg>'''

NEW_MARK_INLINE = '''<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M 5 5 L 21 5 L 27 11 L 27 27 L 5 27 Z" fill="currentColor"/>
          <path d="M 21 5 L 21 11 L 27 11 Z" fill="#7c8cff"/>
        </svg>'''

PATS = [
    # 1. <svg class="mark" ... viewBox="0 0 28 28" ... </svg>
    (re.compile(r'<svg class="mark"[^>]*viewBox="0 0 28 28"[^>]*>.*?</svg>', flags=re.DOTALL),
     NEW_MARK_HEADER),
    # 2. <svg viewBox="0 0 24 24" ... </svg> when it contains a kbar gradient
    (re.compile(r'<svg viewBox="0 0 24 24"[^>]*>\s*<defs>\s*<linearGradient id="kbar-[^"]*".*?</svg>', flags=re.DOTALL),
     NEW_MARK_INLINE),
]

count_files = 0
count_replacements = 0
for path in sorted(pathlib.Path('public').rglob('*.html')):
    if 'archive' in path.parts:
        continue
    s = path.read_text(encoding='utf-8')
    total_n = 0
    for pat, repl in PATS:
        s, n = pat.subn(repl, s)
        total_n += n
    if total_n > 0:
        path.write_text(s, encoding='utf-8')
        count_files += 1
        count_replacements += total_n
        print(f"[{total_n}x] {path}")

print(f"DONE: replaced {count_replacements} marks across {count_files} files")
