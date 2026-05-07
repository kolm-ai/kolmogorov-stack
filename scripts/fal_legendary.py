"""Generate legendary product imagery for kolm.ai homepage via FAL gpt-image-2.

Replaces atmospheric blurs with concrete brand visuals: the .kolm artifact as
a physical object, the compile pipeline as a cinematic distillation,
on-device run on a phone, MCP fanout into 4 dev tools, and a closing horizon.

All images: single periwinkle accent (#7C8CFF) on near-black, museum-quality
product photography aesthetic, no text, no logos, no faces.
"""
import os, sys, urllib.request, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if not os.environ.get("FAL_KEY"):
    sys.exit("FAL_KEY env var required")

import fal_client
from PIL import Image, ImageEnhance

OUT_DIR = Path("C:/Users/user/Desktop/kolmogorov-stack/public/img")
OUT_DIR.mkdir(exist_ok=True, parents=True)
RAW_DIR = OUT_DIR / "_generations"
RAW_DIR.mkdir(exist_ok=True, parents=True)

ASSETS = [
    {
        "id": "hero-artifact",
        "out": "hero-artifact.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Hyperreal product photography of a single rectangular slab of "
            "machined matte-black ceramic, 3:2 proportions, floating in deep "
            "near-black space. The slab's front face is engraved with a "
            "precise grid of micro-glyphs glowing in periwinkle blue-violet "
            "(#7C8CFF) light, like circuit traces on dark silicon. A faint "
            "periwinkle bloom emerges from beneath the slab. The object is "
            "positioned slightly off-center, three-quarter perspective view. "
            "The surface has a museum-quality matte finish with sub-millimeter "
            "edge precision, like an Apple device prototype or a Teenage "
            "Engineering object. Shallow depth of field, single soft "
            "key light from upper left, deep shadow falling away to the right. "
            "Cinematic atmospheric haze. Pure dimensional space, no text, no "
            "logos, no humans, no environment, no surface, no horizon. Color "
            "palette strictly: deep matte-black background, single periwinkle "
            "accent, faint silver dust. No warm tones, no orange, no rainbow. "
            "Studio fine-art photography mood."
        ),
    },
    {
        "id": "compile-distill",
        "out": "compile-distill.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Cinematic abstract illustration of a vast intelligence collapsing "
            "into a single object. From the top of the frame, hundreds of "
            "fine periwinkle (#7C8CFF) light beams converge through a narrow "
            "horizontal aperture in the middle of the frame, then funnel "
            "downward into a single rectangular slab at the bottom-center. "
            "The slab glows from within with periwinkle light. Background is "
            "deep near-black with faint volumetric haze. Like a CGI sequence "
            "of distillation: many candidate samples becoming one verified "
            "output. Engineering-diagram precision crossed with cinematic "
            "fine-art lighting. Faint tick-marks along the aperture edge. "
            "No text, no logos, no humans. Single accent color (periwinkle), "
            "monochrome cool palette, museum-quality. Sub-millimeter clarity, "
            "no painterly look. Dimensional depth, cinematic 16:9."
        ),
    },
    {
        "id": "run-on-device",
        "out": "run-on-device.png",
        "image_size": "portrait_16_9",
        "prompt": (
            "Hyperreal product photography of a single sleek matte-black "
            "smartphone floating in deep near-black space, three-quarter "
            "view, screen facing camera. The screen displays a minimalist "
            "interface: a single periwinkle (#7C8CFF) wordmark, three thin "
            "horizontal lines of periwinkle text, and a small pulsing "
            "periwinkle dot in the lower portion. The phone's edges catch "
            "a precise rim-light from the upper left, casting a soft "
            "periwinkle bloom around the device. Museum-quality industrial "
            "photography. Sub-millimeter edge precision, like an Apple "
            "press render. Shallow depth of field, deep blacks falling "
            "away behind the phone, faint silver dust in the air. No "
            "humans, no hands, no environment, no surface. Single periwinkle "
            "accent, no warm tones, no rainbow. Cinematic restraint."
        ),
    },
    {
        "id": "mcp-fanout",
        "out": "mcp-fanout.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Cinematic abstract diagram: a single bright periwinkle (#7C8CFF) "
            "rectangular slab floats at the left of the frame. From it, four "
            "precise periwinkle light beams fan out toward the right of the "
            "frame, each terminating in a small geometric node (a circle, a "
            "square, a hexagon, a triangle), spaced vertically. The four "
            "nodes glow softly with periwinkle light. Engineering-diagram "
            "aesthetic, museum-quality precision, deep near-black background. "
            "Volumetric haze along the beam paths. Like a CGI visualization "
            "of one source serving four protocol clients. Single accent "
            "color, monochrome cool, no text, no logos, no humans. Cinematic "
            "16:9, dimensional depth, sub-millimeter clarity."
        ),
    },
    {
        "id": "verification-chain",
        "out": "verification-chain.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Cinematic abstract illustration of a single horizontal chain of "
            "precise interlocking periwinkle (#7C8CFF) hexagonal links "
            "stretching across the frame at eye level, glowing softly from "
            "within. Each link is sub-millimeter precise, like machined "
            "titanium. Background is deep near-black with faint volumetric "
            "atmospheric haze. Soft single key light from above. Museum-"
            "quality industrial product photography aesthetic. Like a CGI "
            "rendering of a cryptographic signature chain. No text, no "
            "logos, no humans, no environment. Single periwinkle accent on "
            "near-black, no warm tones, no rainbow. Cinematic 16:9, deep "
            "shadow, dimensional restraint."
        ),
    },
    {
        "id": "horizon-artifact",
        "out": "horizon-artifact.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Cinematic final-shot still: a vast deep-black field meets a "
            "soft periwinkle (#7C8CFF) horizon glow at the lower third. A "
            "single tiny rectangular slab silhouette stands precisely on "
            "the horizon line, perfectly centered, dimensions like a "
            "monolith but smaller. The slab is backlit by the periwinkle "
            "horizon glow, its edges glowing faintly. Faint atmospheric "
            "haze rises around the slab. Like the closing still of a quiet "
            "science-fiction film. Museum-quality fine-art photography. "
            "Cinematic 16:9 wide aspect. Single accent color (periwinkle), "
            "monochrome cool. No text, no figures, no logos, no other "
            "objects. Subtle film grain. Mood: terminal, sovereign, calm, "
            "decisive."
        ),
    },
]


def generate(asset):
    print(f"[{asset['id']}] starting fal subscribe...", flush=True)
    t0 = time.time()
    try:
        result = fal_client.subscribe(
            "fal-ai/gpt-image-2",
            arguments={
                "prompt": asset["prompt"],
                "image_size": asset["image_size"],
                "num_images": 1,
            },
            with_logs=False,
        )
    except Exception as e:
        print(f"[{asset['id']}] FAILED: {e}", flush=True)
        return asset["id"], None, str(e)

    elapsed = time.time() - t0
    images = result.get("images") or result.get("data", {}).get("images") or []
    if not images:
        print(f"[{asset['id']}] no images in result: {list(result.keys())}", flush=True)
        return asset["id"], None, "no images"
    url = images[0].get("url") or images[0]
    raw_path = RAW_DIR / f"{asset['id']}_raw.png"
    urllib.request.urlretrieve(url, str(raw_path))
    print(f"[{asset['id']}] generated in {elapsed:.1f}s -> {raw_path.name}", flush=True)
    return asset["id"], str(raw_path), None


def post_process(asset_id, raw_path):
    out_path = OUT_DIR / next(a["out"] for a in ASSETS if a["id"] == asset_id)
    img = Image.open(raw_path).convert("RGB")
    img = ImageEnhance.Brightness(img).enhance(0.92)
    img = ImageEnhance.Contrast(img).enhance(1.10)
    img.save(out_path, optimize=True)
    print(f"[{asset_id}] post-processed -> {out_path.name}", flush=True)
    return str(out_path)


def main():
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(generate, a): a for a in ASSETS}
        results = []
        for fut in as_completed(futs):
            asset_id, raw_path, err = fut.result()
            if err or not raw_path:
                print(f"[{asset_id}] skipped (error: {err})", flush=True)
                continue
            try:
                final = post_process(asset_id, raw_path)
                results.append((asset_id, final))
            except Exception as e:
                print(f"[{asset_id}] post-process error: {e}", flush=True)
    print()
    print("=== summary ===", flush=True)
    for aid, path in results:
        size = Path(path).stat().st_size
        print(f"  {aid:24s} -> {Path(path).name:32s} {size/1024:.1f} KB", flush=True)


if __name__ == "__main__":
    main()
