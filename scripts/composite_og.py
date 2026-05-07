"""Overlay the kolm wordmark + tagline onto brand-og.png in the empty
lower-left negative space. Outputs final OG card at 1200x630."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path("C:/Users/user/Desktop/kolmogorov-stack/public/img")
SRC = ROOT / "_generations" / "brand-og_1_raw.png"
OUT = ROOT / "brand-og.png"  # always recompose from raw

# resize source to standard OG dimensions
img = Image.open(SRC).convert("RGB")
img = img.resize((1200, 630), Image.LANCZOS)

draw = ImageDraw.Draw(img, "RGBA")

# windows font candidates, fall back to default
def font(size, weight="regular"):
    candidates = (
        ["C:/Windows/Fonts/segoeuib.ttf"] if weight == "bold" else
        ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"]
    )
    for p in candidates:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

# subtle vignette in the lower-left to deepen the type bed
vignette = Image.new("RGBA", img.size, (0, 0, 0, 0))
vd = ImageDraw.Draw(vignette)
for r in range(380, 0, -8):
    vd.ellipse([100 - r, 540 - r, 100 + r, 540 + r], fill=(8, 8, 12, 4))
img = Image.alpha_composite(img.convert("RGBA"), vignette).convert("RGB")
draw = ImageDraw.Draw(img, "RGBA")

# eyebrow line above the wordmark — periwinkle, mono-feel
draw.text((70, 270), "THE  AI  COMPILER", font=font(22), fill=(124, 140, 255, 230))

# wordmark "kolm" — tight, generous, 156px
wm_font = font(156, "regular")
draw.text((68, 305), "kolm", font=wm_font, fill=(237, 237, 237, 255))

# measure wordmark width to place the trailing accent dot cleanly past it
bbox = draw.textbbox((68, 305), "kolm", font=wm_font)
dot_x = bbox[2] + 14  # 14px gap after the m
dot_y = bbox[3] - 26  # baseline-aligned
draw.ellipse([dot_x, dot_y, dot_x + 16, dot_y + 16], fill=(124, 140, 255, 255))

# tagline below the wordmark
draw.text((68, 480), "Compile once.  Run locally.  Verifiably.",
          font=font(30), fill=(195, 198, 215, 255))

# small mono caption further below — credibility footer
draw.text((68, 530), "frontier models are the compiler  ·  .kolm is the binary",
          font=font(18), fill=(124, 132, 160, 230))

img.save(OUT, "PNG", optimize=True)
print(f"composited -> {OUT.name} ({OUT.stat().st_size/1024:.1f} KB)")
