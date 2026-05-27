#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Scrub W### wave codes from string values in JSON files.
Preserves keys (which are often W-prefixed config keys we want to keep) and structure."""
import json, re, sys
from pathlib import Path

WAVE = r'W\d{3}(?:-?[A-Za-z][A-Za-z0-9]*)?(?:\.\d+)?'
WAVE_RE = re.compile(WAVE)

TEXT_SUBS = [
    (re.compile(rf'^\s*{WAVE}\s*[–—\-:]\s*'), ''),
    (re.compile(rf'\b{WAVE}\s*[–—]\s+'), ''),
    (re.compile(rf'\s*\(\s*{WAVE}(?:\s+[A-Za-z][^)]{{0,80}})?\)'), ''),
    (re.compile(rf'\s*\[\s*{WAVE}[^\]]{{0,80}}\]\s*'), ' '),
    (re.compile(rf'\b(the|via|per|see|from|by|with|under|using|in|on|after|before|to|of|as|like|than|legacy)\s+{WAVE}\s+(?=[a-zA-Z])', re.IGNORECASE), r'\1 '),
    (re.compile(rf',\s*{WAVE}\s+(?=[A-Za-z])'), ', '),
    (re.compile(rf'\s*[·•]\s*{WAVE}\b'), ''),
    (re.compile(rf'\b{WAVE}\s*[·•]\s*'), ''),
    (re.compile(rf'\.\s+{WAVE}\.'), '.'),
    (re.compile(rf' {WAVE} '), ' '),
    (re.compile(rf'\s+{WAVE}\b'), ''),
    (re.compile(rf'\b{WAVE}\s+'), ''),
    (re.compile(rf'\b{WAVE}\b'), ''),
]

CLEAN = [
    (re.compile(r'  +'), ' '),
    (re.compile(r'\s+([.,;:])'), r'\1'),
    (re.compile(r'\(\s+'), '('),
    (re.compile(r'\s+\)'), ')'),
    (re.compile(r'\(\s*\)'), ''),
    (re.compile(r'\[\s*\]'), ''),
]

def scrub_str(s):
    if not isinstance(s, str) or not WAVE_RE.search(s):
        return s
    out = s
    for pat, rep in TEXT_SUBS:
        out = pat.sub(rep, out)
    for pat, rep in CLEAN:
        out = pat.sub(rep, out)
    return out.strip()

def walk(node):
    if isinstance(node, dict):
        return {k: walk(v) for k, v in node.items()}
    if isinstance(node, list):
        return [walk(v) for v in node]
    if isinstance(node, str):
        return scrub_str(node)
    return node

def scrub_json(path):
    with open(path, encoding='utf-8') as f:
        raw = f.read()
    if not WAVE_RE.search(raw):
        return 0, 0
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return 0, 0
    orig_count = len(WAVE_RE.findall(raw))
    cleaned = walk(data)
    out = json.dumps(cleaned, ensure_ascii=False, indent=2)
    new_count = len(WAVE_RE.findall(out))
    if new_count == orig_count:
        return 0, 0
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out + '\n' if not out.endswith('\n') else out)
    return 1, orig_count - new_count

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    tot_f = tot_c = tot_r = 0
    for p in sys.argv[1:]:
        if not Path(p).is_file():
            continue
        tot_f += 1
        try:
            c, r = scrub_json(p)
        except Exception as e:
            print(f'ERROR {p}: {e}', file=sys.stderr)
            continue
        if c:
            tot_c += 1
            tot_r += r
    print(f'files: {tot_f} processed, {tot_c} modified, {tot_r} wave codes removed')
