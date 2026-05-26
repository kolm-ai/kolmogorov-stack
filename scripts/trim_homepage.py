"""
Collapse homepage from 13 sections to 6.
Deletes specific sections by their h2 signature.
Idempotent — running twice is safe.
"""
import re
import pathlib

p = pathlib.Path('public/index.html')
src = p.read_text(encoding='utf-8')

# Sections to delete (matched by unique h2 substring).
TO_DELETE = [
    "Every compile makes the next one cheaper",
    "the more <span class=\"tone\">personal it can be",
    "Every cloud call is paid for",
    "One number on the cover",
    "What gets harder for everyone else",
    "Where kolm fits in",
    "You pay for the cache",
]

deleted = 0
for needle in TO_DELETE:
    # Find a <section> ... </section> block whose body contains the needle.
    # Match the full block: from <section[^>]*> through the matching </section>.
    pat = re.compile(
        r'\n*<section[^>]*>(?:(?!</section>).)*?'
        + re.escape(needle)
        + r'(?:(?!</section>).)*?</section>\n*',
        flags=re.DOTALL,
    )
    new_src, n = pat.subn('\n\n', src, count=1)
    if n == 0:
        print(f"[skip] not found (may already be deleted): {needle[:40]}...")
        continue
    src = new_src
    deleted += 1
    print(f"[del] {needle[:50]}...")

# Collapse 3+ blank lines to 2.
src = re.sub(r'\n{3,}', '\n\n', src)

p.write_text(src, encoding='utf-8')
print(f"DONE: {deleted} sections deleted, file is {len(src):,} bytes / {src.count(chr(10))+1:,} lines")
