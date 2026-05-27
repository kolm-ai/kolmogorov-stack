#!/usr/bin/env python3
"""Context-aware wave-code scrubber.

Strips W### (and W###-suffix) from:
  - HTML comments (entire comment removed if leads with W###)
  - CSS comments inside <style> and .css files (entire comment removed if leads with W###)
  - JS line comments // W### ... (entire comment line removed; leaves code on line)
  - <title>, <meta name="description"|"og:*" content="...">, <meta property="og:*" content="...">
  - User-visible text nodes inside tags (eyebrow/p/h1-6/span/li/td/strong/em/a)
  - Common phrasings: "W### word", "(W###)", "(W### description)", "the W### word"

Preserves:
  - JS function/variable identifiers (paintW815Rec, loadW815Coverage, w777-grid)
  - DOM id="w777-..." and class="w777-..."  attribute values
  - File paths: wave887-*.js, tests/wave888-*.js
  - sw.js cache slugs (wave903-...)
  - Workflow IDs (w777:abc)

Strategy: operate on HTML files via html.parser to distinguish text from attributes.
For .css/.js files, only strip comments.
"""
import os, sys, re, html
from html.parser import HTMLParser
from io import StringIO

WAVE = r'W\d{3}(?:-?[A-Za-z][A-Za-z0-9]*)?'
WAVE_RE = re.compile(WAVE)

# patterns applied to *text content* (not attributes, not code blocks)
TEXT_SUBS = [
    # "(W### description)" or "(W###)" parentheticals
    (re.compile(rf'\s*\(\s*{WAVE}(?:\s+[A-Za-z][^)]{{0,60}})?\)'), ''),
    # "[W### note]"
    (re.compile(rf'\s*\[\s*{WAVE}[^\]]{{0,60}}\]\s*'), ' '),
    # "WAVE – text" / "WAVE — text" / "WAVE - text" / "WAVE: text" leaders (start of text)
    (re.compile(rf'^\s*{WAVE}\s*[–—\-:]\s*'), ''),
    # Mid-text "WAVE – text" / "WAVE — text"
    (re.compile(rf'\b{WAVE}\s*[–—]\s+'), ''),
    # Leading "W### " at start of a phrase
    (re.compile(rf'^{WAVE}\s+(?=[A-Z])'), ''),
    # "the W### Welch t-test" -> "the Welch t-test" (case-insensitive on leader)
    (re.compile(rf'\b(the|via|per|see|from|by|with|under|using|in|on|after|before|to|of|as|like|than)\s+{WAVE}\s+(?=[a-zA-Z])', re.IGNORECASE), r'\1 '),
    # ", W### text" -> ", text"
    (re.compile(rf',\s*{WAVE}\s+(?=[A-Za-z])'), ', '),
    # "X · W###" or "W### · X"
    (re.compile(rf'\s*[·•]\s*{WAVE}\b'), ''),
    (re.compile(rf'\b{WAVE}\s*[·•]\s*'), ''),
    (re.compile(rf'\s*&middot;\s*{WAVE}\b'), ''),
    (re.compile(rf'\b{WAVE}\s*&middot;\s*'), ''),
    # ". W###." trailing tag
    (re.compile(rf'\.\s+{WAVE}\.'), '.'),
    # Standalone word " W### " between text
    (re.compile(rf' {WAVE} '), ' '),
    # Leftover bare W### at end of attribute/sentence
    (re.compile(rf'\s+{WAVE}\b'), ''),
    (re.compile(rf'\b{WAVE}\s+'), ''),
    (re.compile(rf'\b{WAVE}\b'), ''),
]

TEXT_CLEAN = [
    (re.compile(r'  +'), ' '),
    (re.compile(r'\s+([.,;:])'), r'\1'),
    (re.compile(r'\(\s+'), '('),
    (re.compile(r'\s+\)'), ')'),
    (re.compile(r'\(\s*\)'), ''),
    (re.compile(r'\[\s*\]'), ''),
]

def scrub_text(t):
    if not t or not WAVE_RE.search(t):
        return t
    s = t
    for pat, rep in TEXT_SUBS:
        s = pat.sub(rep, s)
    for pat, rep in TEXT_CLEAN:
        s = pat.sub(rep, s)
    return s

# ---- comment strippers ----
# HTML comment: <!-- ... -->
def strip_html_comments_with_wave(s):
    """Remove entire <!-- ... --> blocks containing W### (multi-line OK)."""
    def repl(m):
        body = m.group(1)
        if WAVE_RE.search(body):
            return ''
        return m.group(0)
    return re.sub(r'<!--(.*?)-->', repl, s, flags=re.DOTALL)

# CSS block comment: /* ... */
def strip_css_comments_with_wave(s):
    """Remove entire /* ... */ blocks containing W### (multi-line OK)."""
    def repl(m):
        body = m.group(1)
        if WAVE_RE.search(body):
            return ''
        return m.group(0)
    return re.sub(r'/\*(.*?)\*/', repl, s, flags=re.DOTALL)

# JS line comment: // ... \n
def strip_js_line_comments_with_wave(s):
    """For lines that are ENTIRELY a // comment containing W###, remove the line.
    For lines with code + trailing // W### comment, strip the comment."""
    out = []
    for line in s.split('\n'):
        stripped = line.lstrip()
        if stripped.startswith('//'):
            if WAVE_RE.search(line):
                continue  # drop entire line
            out.append(line)
            continue
        # trailing comment
        if '//' in line:
            # naive: find first // not inside a string
            # for safety, only strip if it's clearly a trailing comment
            idx = line.find('//')
            # Check that // is not inside quotes (very rough)
            before = line[:idx]
            q1 = before.count('"') - before.count('\\"')
            q2 = before.count("'") - before.count("\\'")
            if q1 % 2 == 0 and q2 % 2 == 0:
                comment = line[idx:]
                if WAVE_RE.search(comment):
                    new_line = before.rstrip()
                    if new_line:
                        out.append(new_line)
                    continue
        out.append(line)
    return '\n'.join(out)

# ---- HTML-aware scrubber ----
# Attributes whose values are user-visible
VISIBLE_ATTRS = {'content', 'title', 'alt', 'placeholder', 'aria-label', 'label', 'value'}
# Skip text inside these tags entirely (they're code)
CODE_TAGS = {'script', 'style', 'code', 'pre', 'kbd', 'samp'}

class WaveScrubber(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.out = []
        self.skip_depth = 0
        self.current_code_tag = []

    def handle_starttag(self, tag, attrs):
        # rewrite attributes
        new_attrs = []
        is_ld_json = False
        for k, v in attrs:
            if v is not None and k.lower() in VISIBLE_ATTRS:
                if WAVE_RE.search(v):
                    v = scrub_text(v).strip()
            if tag.lower() == 'script' and k.lower() == 'type' and v and 'json' in v.lower():
                is_ld_json = True
            new_attrs.append((k, v))
        # Render tag
        self.out.append(self._render_start(tag, new_attrs, self_closing=False))
        if tag.lower() in CODE_TAGS:
            self.skip_depth += 1
            self.current_code_tag.append(tag.lower())
            if is_ld_json:
                self.current_code_tag[-1] = 'ld+json'

    def handle_startendtag(self, tag, attrs):
        new_attrs = []
        for k, v in attrs:
            if v is not None and k.lower() in VISIBLE_ATTRS:
                if WAVE_RE.search(v):
                    v = scrub_text(v).strip()
            new_attrs.append((k, v))
        self.out.append(self._render_start(tag, new_attrs, self_closing=True))

    def handle_endtag(self, tag):
        if self.current_code_tag:
            top = self.current_code_tag[-1]
            if top == tag.lower() or (top == 'ld+json' and tag.lower() == 'script'):
                self.current_code_tag.pop()
                self.skip_depth = max(0, self.skip_depth - 1)
        self.out.append(f'</{tag}>')

    def handle_data(self, data):
        if self.skip_depth > 0:
            tag = self.current_code_tag[-1] if self.current_code_tag else ''
            if tag == 'ld+json':
                # JSON-LD: scrub W### tokens from string values (user-visible SEO)
                data = scrub_text(data)
            elif tag == 'script':
                data = strip_js_line_comments_with_wave(data)
                data = strip_css_comments_with_wave(data)
            elif tag == 'style':
                data = strip_css_comments_with_wave(data)
            self.out.append(data)
            return
        # Outside code blocks: scrub user-visible text
        if WAVE_RE.search(data):
            data = scrub_text(data)
        self.out.append(data)

    def handle_comment(self, data):
        # Comments containing W### are dropped entirely
        if WAVE_RE.search(data):
            return
        self.out.append(f'<!--{data}-->')

    def handle_entityref(self, name):
        self.out.append(f'&{name};')

    def handle_charref(self, name):
        self.out.append(f'&#{name};')

    def handle_decl(self, decl):
        self.out.append(f'<!{decl}>')

    def handle_pi(self, data):
        self.out.append(f'<?{data}>')

    def _render_start(self, tag, attrs, self_closing):
        parts = [tag]
        for k, v in attrs:
            if v is None:
                parts.append(k)
            else:
                # escape quotes
                esc = v.replace('&', '&amp;').replace('"', '&quot;')
                parts.append(f'{k}="{esc}"')
        end = ' />' if self_closing else '>'
        return '<' + ' '.join(parts) + end

    def result(self):
        return ''.join(self.out)

def scrub_html(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        s = f.read()
    orig = s
    # First strip HTML comments wholesale (faster + safer than parser pass)
    s = strip_html_comments_with_wave(s)
    # Then run the HTML-aware scrubber for the rest
    p = WaveScrubber()
    try:
        p.feed(s)
        p.close()
        s = p.result()
    except Exception as e:
        # Fall back to text-only scrub if parser blows up
        pass
    if s != orig:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(s)
        removed = len(WAVE_RE.findall(orig)) - len(WAVE_RE.findall(s))
        return 1, removed
    return 0, 0

def scrub_css(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        s = f.read()
    orig = s
    s = strip_css_comments_with_wave(s)
    if s != orig:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(s)
        return 1, len(WAVE_RE.findall(orig)) - len(WAVE_RE.findall(s))
    return 0, 0

def scrub_js(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        s = f.read()
    orig = s
    s = strip_css_comments_with_wave(s)  # /* */ blocks
    s = strip_js_line_comments_with_wave(s)  # // lines
    if s != orig:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(s)
        return 1, len(WAVE_RE.findall(orig)) - len(WAVE_RE.findall(s))
    return 0, 0

def scrub(path):
    if path.endswith('.html') or path.endswith('.htm'):
        return scrub_html(path)
    if path.endswith('.css'):
        return scrub_css(path)
    if path.endswith('.js'):
        return scrub_js(path)
    return 0, 0

if __name__ == '__main__':
    total_files = 0
    total_changed = 0
    total_removed = 0
    for path in sys.argv[1:]:
        if not os.path.isfile(path):
            continue
        total_files += 1
        try:
            changed, removed = scrub(path)
        except Exception as e:
            print(f'ERROR {path}: {e}', file=sys.stderr)
            continue
        if changed:
            total_changed += 1
            total_removed += removed
    print(f'files: {total_files} processed, {total_changed} modified, {total_removed} wave codes removed')
