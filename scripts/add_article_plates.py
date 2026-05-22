"""Cascade hero photo plates into the 5 article essays. Each article gets a
plate matching its topic, inserted right after the byline meta div. Idempotent
— skips files that already have .plate CSS or markup."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public" / "articles"

PLATE_CSS = '''
  .plate{position:relative;margin:32px 0 0;border:1px solid var(--line-strong);border-radius:14px;overflow:hidden;background:#050507;isolation:isolate}
  .plate .img{position:relative;aspect-ratio:16/9;background-position:center;background-size:cover;background-repeat:no-repeat}
  .plate .img::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,transparent 50%,rgba(8,8,10,0.78) 100%),linear-gradient(90deg,rgba(8,8,10,0.55) 0%,transparent 30%,transparent 70%,rgba(8,8,10,0.55) 100%)}
  .plate .img::before{content:"";position:absolute;left:12%;right:12%;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(124,140,255,0.5),transparent);pointer-events:none;z-index:2}
  .plate .stamp{position:absolute;top:18px;left:20px;z-index:3;display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:10px;letter-spacing:0.20em;text-transform:uppercase;color:var(--ink-mute);border:1px solid rgba(124,140,255,0.22);background:rgba(10,10,10,0.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);padding:5px 11px;border-radius:4px}
  .plate .stamp .dot{width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px rgba(124,140,255,0.85)}
  .plate .cap{position:absolute;left:24px;right:24px;bottom:20px;z-index:3;display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
  .plate .cap .title{font-family:var(--sans);font-size:clamp(17px,1.8vw,22px);font-weight:540;letter-spacing:-0.018em;line-height:1.18;color:var(--ink);max-width:62%;text-shadow:0 1px 2px rgba(0,0,0,0.55)}
  .plate .cap .title .tone{background:linear-gradient(170deg,#d4daff 0%,#93a1ff 50%,#7c8cff 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .plate .cap .meta{font-family:var(--mono);font-size:10.5px;color:var(--ink-mute);letter-spacing:0.06em;text-align:right;line-height:1.7}
  .plate .cap .meta b{color:var(--ink);font-weight:520}
  @media(max-width:720px){.plate .cap{left:14px;right:14px;bottom:12px;flex-direction:column;align-items:flex-start;gap:8px}.plate .cap .title{font-size:14px;max-width:100%}.plate .cap .meta{text-align:left;font-size:10px}.plate .stamp{top:12px;left:12px;font-size:9px;padding:4px 9px}}
'''

# (filename) -> (image_basename, stamp_text, title_html, meta_html)
PLATES = {
    "ai-compiler.html": (
        "compile-distill",
        "essay · the compiler",
        'Frontier in. <span class="tone">.kolm out.</span>',
        'distill · decompose · package<br><b>one signed file</b>',
    ),
    "kolm-file-format.html": (
        "hero-artifact",
        "essay · file format",
        'Inside the <span class="tone">.kolm</span> artifact.',
        'model · adapter · recipes<br>index · evals · <b>signature</b>',
    ),
    "k-sample-verified-inference.html": (
        "verification-chain",
        "essay · verified inference",
        'k samples. <span class="tone">One verifier.</span>',
        'parallel attempts<br><b>deterministic</b> picker',
    ),
    "speculative-decoding-recipes.html": (
        "mcp-fanout",
        "essay · recipe drafts",
        'Determinism, <span class="tone">drafted.</span>',
        'tokenized prefixes<br><b>signed registry</b>',
    ),
    "hipaa-on-device.html": (
        "run-on-device",
        "essay · on-device HIPAA",
        'Compliance, <span class="tone">offline.</span>',
        'no PHI leaves device<br><b>receipts on every call</b>',
    ),
}


def process(path: Path, image: str, stamp: str, title: str, meta: str) -> bool:
    text = path.read_text(encoding="utf-8")

    if "/* plate */" in text or "class=\"plate\"" in text:
        return False  # already done

    # 1. inject CSS just before the closing </style> in the head block
    style_close = "</style>"
    if style_close not in text:
        return False
    text = text.replace(style_close, f"  /* plate */\n{PLATE_CSS}{style_close}", 1)

    # 2. find the hero meta byline and inject the plate right after it (still in section.hero)
    # the pattern is <div class="meta">...</div>\n  </div>\n</section>
    plate_html = (
        f'\n    <figure class="plate" role="img" aria-label="kolm artifact essay illustration">'
        f'\n      <div class="img" style="background-image:url(/img/{image}.webp)"></div>'
        f'\n      <span class="stamp"><span class="dot"></span>{stamp}</span>'
        f'\n      <div class="cap">'
        f'\n        <div class="title">{title}</div>'
        f'\n        <div class="meta">{meta}</div>'
        f'\n      </div>'
        f'\n    </figure>'
    )

    # match the closing of section.hero's wrap (the .meta div is the last thing in it)
    # we insert plate_html just before the wrap's closing </div>, so the figure stays inside the hero
    pattern = re.compile(r'(<div class="meta">[\s\S]*?</div>)(\s*</div>\s*</section>)')
    new_text, n = pattern.subn(rf'\1{plate_html}\2', text, count=1)
    if n == 0:
        return False

    path.write_text(new_text, encoding="utf-8")
    return True


total = 0
for name, (image, stamp, title, meta) in PLATES.items():
    p = ROOT / name
    if not p.exists():
        print(f"  SKIP {name} (missing)")
        continue
    if process(p, image, stamp, title, meta):
        total += 1
        print(f"  injected plate -> {name}  ({image}.webp)")
    else:
        print(f"  noop {name}")

print(f"\ntotal: {total}")
