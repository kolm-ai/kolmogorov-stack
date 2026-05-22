"""Brand asset generation for kolm via FAL gpt-image-2.

Generates:
  - brand-mark.png    (1:1 square logomark — for header logo + favicon)
  - brand-og.png      (16:9 OG/Twitter card — text overlaid in HTML, not in render)
  - brand-glyph.png   (1:1 tighter abstract glyph — alt mark for footer/loading)

Strict: NO TEXT, NO LETTERS, NO WORDMARK, NO LOGO TYPOGRAPHY anywhere in any
render. The wordmark stays in CSS. These renders are pure object photography.
"""
import os, sys, urllib.request, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if not os.environ.get("FAL_KEY"):
    sys.exit("FAL_KEY env var required")

import fal_client
from PIL import Image, ImageEnhance

OUT_DIR = Path(__file__).resolve().parents[1] / "public" / "img"
RAW_DIR = OUT_DIR / "_generations"
RAW_DIR.mkdir(exist_ok=True, parents=True)

NEGATIVE = (
    "ABSOLUTELY NO text, NO letters, NO words, NO wordmark, NO logo typography, "
    "NO numbers, NO labels, NO captions, NO icons resembling letters, NO subtitles. "
    "NO humans, NO hands, NO faces, NO environment, NO furniture, NO background "
    "objects, NO reflections of other things. Single periwinkle accent color "
    "(#7C8CFF) only — no warm tones, no orange, no yellow, no rainbow."
)

ASSETS = [
    {
        "id": "brand-mark",
        "out": "brand-mark.png",
        "image_size": "square_hd",
        "prompt": (
            "Hyperreal logomark photograph, square 1:1 composition, centered. "
            "A single rectangular slab of machined matte-black ceramic, perfectly "
            "centered, three-quarter perspective view, floating in deep "
            "near-black space. The slab's front face is engraved with a precise "
            "5x5 grid of micro-glyph dots glowing in periwinkle (#7C8CFF) light, "
            "each dot the size of a pinhead, the grid forming a geometric "
            "constellation pattern. A faint periwinkle bloom emerges from "
            "beneath the slab. Sub-millimeter edge precision, like an Apple "
            "device prototype or a Teenage Engineering object. Single soft "
            "key light from upper left. Museum-quality industrial product "
            "photography. The composition has generous negative space around "
            "the slab so the icon reads cleanly at any size. " + NEGATIVE
        ),
    },
    {
        "id": "brand-og",
        "out": "brand-og.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Cinematic landscape product photograph for an Open Graph social "
            "card, 16:9. A single rectangular slab of machined matte-black "
            "ceramic floats in the upper-right third of the frame, three-quarter "
            "perspective view, engraved with a precise grid of micro-glyphs "
            "glowing in periwinkle (#7C8CFF). The lower-left two-thirds of the "
            "frame is intentionally empty deep matte-black space — clean, "
            "dimensional, slightly hazy — reserved for an HTML text overlay. "
            "A faint periwinkle bloom emerges from beneath the slab. Sub-"
            "millimeter edge precision. Studio fine-art photography mood. "
            "Composition strictly: hero object upper-right, generous negative "
            "space lower-left. " + NEGATIVE
        ),
    },
    {
        "id": "brand-glyph",
        "out": "brand-glyph.png",
        "image_size": "square_hd",
        "prompt": (
            "Hyperreal abstract glyph photograph, square 1:1, perfectly "
            "centered. A single tight cluster of three precise periwinkle "
            "(#7C8CFF) horizontal bars stacked vertically — bottom bar long, "
            "middle bar slightly shorter, top bar shortest — forming an "
            "abstract pyramid silhouette inside a soft periwinkle aura. The "
            "bars are thin like machined titanium edges glowing from within. "
            "Background is deep matte-black with faint volumetric haze. "
            "Sub-millimeter precision, museum-quality. The icon reads as a "
            "minimalist pictogram: signal converging into form. " + NEGATIVE
        ),
    },
]


def generate(asset):
    print(f"[{asset['id']}] starting...", flush=True)
    t0 = time.time()
    try:
        result = fal_client.subscribe(
            "fal-ai/gpt-image-2",
            arguments={
                "prompt": asset["prompt"],
                "image_size": asset["image_size"],
                "num_images": 2,
            },
            with_logs=False,
        )
    except Exception as e:
        print(f"[{asset['id']}] FAILED: {e}", flush=True)
        return asset["id"], [], str(e)

    elapsed = time.time() - t0
    images = result.get("images") or result.get("data", {}).get("images") or []
    raw_paths = []
    for i, im in enumerate(images):
        url = im.get("url") or im
        raw_path = RAW_DIR / f"{asset['id']}_{i+1}_raw.png"
        urllib.request.urlretrieve(url, str(raw_path))
        raw_paths.append(raw_path)
    print(f"[{asset['id']}] {len(raw_paths)} renders in {elapsed:.1f}s", flush=True)
    return asset["id"], raw_paths, None


def post_process(asset_id, raw_path):
    out_path = OUT_DIR / next(a["out"] for a in ASSETS if a["id"] == asset_id)
    img = Image.open(raw_path).convert("RGB")
    img = ImageEnhance.Brightness(img).enhance(0.92)
    img = ImageEnhance.Contrast(img).enhance(1.10)
    img.save(out_path, optimize=True)
    print(f"[{asset_id}] -> {out_path.name} ({out_path.stat().st_size/1024:.1f} KB)", flush=True)
    return str(out_path)


def main():
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(generate, a): a for a in ASSETS}
        results = []
        for fut in as_completed(futs):
            asset_id, raws, err = fut.result()
            if err or not raws:
                print(f"[{asset_id}] skipped (error: {err})", flush=True)
                continue
            try:
                final = post_process(asset_id, raws[0])
                results.append((asset_id, final))
            except Exception as e:
                print(f"[{asset_id}] post-process error: {e}", flush=True)
    print()
    print("=== brand summary ===", flush=True)
    for aid, path in results:
        size = Path(path).stat().st_size
        print(f"  {aid:18s} -> {Path(path).name:24s} {size/1024:.1f} KB", flush=True)


if __name__ == "__main__":
    main()
