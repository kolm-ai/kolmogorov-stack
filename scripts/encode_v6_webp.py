"""Encode v6-*.png → v6-*.webp at quality 86, method 6."""
import pathlib
from PIL import Image

IMG = pathlib.Path('public/img')
GEN = IMG / '_generations'

for png in sorted(GEN.glob('v6-*.png')):
    out = IMG / (png.stem + '.webp')
    im = Image.open(png).convert('RGB')
    im.save(out, format='WEBP', quality=86, method=6)
    sz_in = png.stat().st_size
    sz_out = out.stat().st_size
    pct = (1 - sz_out/sz_in) * 100
    print(f"{png.stem}: {sz_in//1024}KB → {sz_out//1024}KB (-{pct:.0f}%)")
print("DONE")
