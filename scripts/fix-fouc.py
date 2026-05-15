#!/usr/bin/env python3
"""
Inject critical-CSS <style> block into every dark-theme HTML page in public/
to eliminate the FOUC white flash on Windows light-mode systems.

The block guarantees html+body paint dark from the very first frame, before
any external stylesheet (Google Fonts, /styles.css, /brand-refresh.css)
loads. Order in head becomes:
  <meta charset>
  <meta viewport>
  <style>html,body{background:#08090c;color:#faf2e1}html{color-scheme:dark}</style>  <-- new
  <script>(theme init)</script>
  ...
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/brand-refresh.css">

Skips: research/eagle3-lookahead, mixture-of-judges-and-prm, multi-lora-serving,
       test-time-compute (intentionally light-theme cream-paper articles).
"""

from __future__ import annotations
import re
import sys
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "public"

# 4 intentionally-light-theme research articles. Do NOT touch.
SKIP = {
    "research/eagle3-lookahead.html",
    "research/mixture-of-judges-and-prm.html",
    "research/multi-lora-serving.html",
    "research/test-time-compute.html",
}

CRITICAL_CSS = '<style>html,body{background:#08090c;color:#faf2e1}html{color-scheme:dark}</style>'

# Match the viewport meta line (any quoting). Insert critical-CSS right after.
VIEWPORT_RE = re.compile(
    r'(<meta[^>]*name=["\']viewport["\'][^>]*>)',
    re.IGNORECASE,
)


def needs_patch(html: str) -> bool:
    return 'html,body{background:#08090c' not in html


def patch(html: str) -> str | None:
    if not needs_patch(html):
        return None
    m = VIEWPORT_RE.search(html)
    if not m:
        return None
    # Insert critical-CSS on its own line directly after viewport meta.
    insert_at = m.end()
    return html[:insert_at] + '\n' + CRITICAL_CSS + html[insert_at:]


def main() -> int:
    files = sorted(PUBLIC.rglob("*.html"))
    patched = 0
    skipped_intentional = 0
    skipped_already = 0
    skipped_no_viewport = 0
    samples_patched: list[str] = []

    for path in files:
        rel = path.relative_to(PUBLIC).as_posix()
        if rel in SKIP:
            skipped_intentional += 1
            continue
        original = path.read_text(encoding="utf-8")
        result = patch(original)
        if result is None:
            if not needs_patch(original):
                skipped_already += 1
            else:
                skipped_no_viewport += 1
                print(f"  WARN no viewport meta: {rel}", file=sys.stderr)
            continue
        path.write_text(result, encoding="utf-8")
        patched += 1
        if len(samples_patched) < 8:
            samples_patched.append(rel)

    print(f"Patched: {patched}")
    print(f"Skipped intentional-light: {skipped_intentional}")
    print(f"Skipped already-patched:   {skipped_already}")
    print(f"Skipped no-viewport:       {skipped_no_viewport}")
    print(f"Total HTML scanned:        {len(files)}")
    print(f"Samples patched: {samples_patched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
