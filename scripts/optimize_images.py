"""Convert the FAL-generated PNGs to WebP siblings. Keep PNGs as fallback;
serve WebP via <picture> source. Idempotent — only writes if WebP is missing
or older than the PNG."""
from pathlib import Path
from PIL import Image

ROOT = Path("C:/Users/user/Desktop/kolmogorov-stack/public/img")

TARGETS = [
    "hero-artifact.png",
    "compile-distill.png",
    "mcp-fanout.png",
    "run-on-device.png",
    "verification-chain.png",
    "horizon-artifact.png",
    "brand-og.png",
    "brand-mark.png",
    "brand-glyph.png",
]

total_before = 0
total_after = 0
for name in TARGETS:
    src = ROOT / name
    if not src.exists():
        print(f"  SKIP {name} (missing)")
        continue
    dst = src.with_suffix(".webp")
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        before = src.stat().st_size
        after = dst.stat().st_size
        total_before += before
        total_after += after
        print(f"  fresh {name:28s} {before/1024:6.1f} KB -> {after/1024:6.1f} KB ({100*after/before:.0f}%)")
        continue

    img = Image.open(src).convert("RGB")
    # quality 86 keeps the periwinkle gradient faithful while shrinking aggressively
    img.save(dst, "WEBP", quality=86, method=6)
    before = src.stat().st_size
    after = dst.stat().st_size
    total_before += before
    total_after += after
    print(f"  wrote {name:28s} {before/1024:6.1f} KB -> {after/1024:6.1f} KB ({100*after/before:.0f}%)")

print()
print(f"  total: {total_before/1024:.1f} KB -> {total_after/1024:.1f} KB"
      f"  ({100*total_after/total_before:.0f}%, saved {(total_before-total_after)/1024:.1f} KB)")
