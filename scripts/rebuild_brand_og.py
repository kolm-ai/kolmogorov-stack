"""Rebuild /img/brand-og.png as 1200x630 from v6-monolith.png with subtle text overlay-free."""
import pathlib
from PIL import Image

src = pathlib.Path('public/img/_generations/v6-monolith.png')
out_png = pathlib.Path('public/img/brand-og.png')
out_webp = pathlib.Path('public/img/brand-og.webp')

im = Image.open(src).convert('RGB')
# Resize to fit 1200x630 cropped center.
target_w, target_h = 1200, 630
src_w, src_h = im.size
src_ratio = src_w / src_h
tgt_ratio = target_w / target_h
if src_ratio > tgt_ratio:
    # source wider — crop sides
    new_w = int(src_h * tgt_ratio)
    left = (src_w - new_w) // 2
    im = im.crop((left, 0, left + new_w, src_h))
else:
    new_h = int(src_w / tgt_ratio)
    top = (src_h - new_h) // 2
    im = im.crop((0, top, src_w, top + new_h))
im = im.resize((target_w, target_h), Image.LANCZOS)
im.save(out_png, format='PNG', optimize=True)
im.save(out_webp, format='WEBP', quality=88, method=6)
print(f"PNG {out_png.stat().st_size//1024}KB | WebP {out_webp.stat().st_size//1024}KB")
