"""Generate three atmospheric assets for kolm.ai homepage via FAL gpt-image-2.

Each asset is dimensional, atmospheric, single periwinkle accent on near-black.
Outputs land in public/img/ and are post-processed with PIL to enforce exact
#7C8CFF accent (hue-tint pipeline) when needed.
"""
import os, sys, urllib.request, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if not os.environ.get("FAL_KEY"):
    sys.exit("FAL_KEY env var required (read from ~/Desktop/agent-apis/.env)")

import fal_client
from PIL import Image, ImageEnhance

OUT_DIR = Path(__file__).resolve().parents[1] / "public" / "img"
OUT_DIR.mkdir(exist_ok=True, parents=True)
RAW_DIR = OUT_DIR / "_generations"
RAW_DIR.mkdir(exist_ok=True, parents=True)

ASSETS = [
    {
        "id": "hero-atmosphere",
        "out": "hero-atmosphere.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Ultra-wide cinematic abstract image. A single soft periwinkle "
            "blue-violet light source emerges from deep within near-black "
            "cosmic darkness, gently dispersing into faint silver-grey "
            "particle dust converging from the frame edges toward the center. "
            "Museum-quality fine-art photography aesthetic. Subtle film grain. "
            "Pure atmospheric depth, no text, no figures, no logos, no faces. "
            "Wide cinematic 16:9 ratio. Professional studio lighting with one "
            "key source. Restrained, technical, minimalist mood. Digital, "
            "sovereign, precise. Color palette: deep black background "
            "(#0a0a0a), single periwinkle accent (#7C8CFF), faint silver dust. "
            "No warm tones, no orange, no red, no rainbow gradient."
        ),
    },
    {
        "id": "compile-pipeline",
        "out": "compile-pipeline.png",
        "image_size": "square_hd",
        "prompt": (
            "Abstract technical illustration of many parallel light streams "
            "converging from the top of the frame down through a narrow waist, "
            "becoming a single bright periwinkle (#7C8CFF) line at the bottom. "
            "Dark near-black background. Minimalist, museum-quality, "
            "engineering-diagram aesthetic. Like a cinematic visualization "
            "of distillation: many candidate samples becoming one verified "
            "output. Faint tick-marks and grid lines. Slight grain. No text, "
            "no logos, no human figures. Cool monochrome with only one "
            "periwinkle accent color. Square format. Restrained, precise."
        ),
    },
    {
        "id": "closing-atmosphere",
        "out": "closing-atmosphere.png",
        "image_size": "landscape_16_9",
        "prompt": (
            "Cinematic abstract horizon: deep matte-black field meets a soft "
            "periwinkle (#7C8CFF) horizon glow at the lower third, with faint "
            "atmospheric haze rising. Like the final still of a quiet "
            "science-fiction film. Museum-quality, restrained, dimensional. "
            "Wide cinematic 16:9 aspect. Single accent color (periwinkle), "
            "monochrome cool. No text, no figures, no logos, no specific "
            "objects. Subtle grain texture. Mood: terminal, sovereign, "
            "calm, decisive."
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
        print(f"[{asset['id']}] FAILED first endpoint: {e}", flush=True)
        try:
            result = fal_client.subscribe(
                "fal-ai/gpt-image-1",
                arguments={
                    "prompt": asset["prompt"],
                    "image_size": asset["image_size"],
                    "num_images": 1,
                },
                with_logs=False,
            )
        except Exception as e2:
            print(f"[{asset['id']}] FAILED both endpoints: {e2}", flush=True)
            return asset["id"], None, str(e2)

    elapsed = time.time() - t0
    images = result.get("images") or result.get("data", {}).get("images") or []
    if not images:
        print(f"[{asset['id']}] no images in result: {list(result.keys())}", flush=True)
        return asset["id"], None, "no images"
    url = images[0].get("url") or images[0]
    raw_path = RAW_DIR / f"{asset['id']}_raw.png"
    urllib.request.urlretrieve(url, str(raw_path))
    print(f"[{asset['id']}] generated in {elapsed:.1f}s -> {raw_path}", flush=True)
    return asset["id"], str(raw_path), None


def post_process(asset_id, raw_path):
    """PIL pass: tighten contrast, enforce no-warm-tone if needed.
    For now, simple darken-pass + slight saturation lift on the periwinkle
    accent. Full hue-tint enforcement skipped (gpt-image-2 honors color
    instructions reliably with these prompts).
    """
    out_path = OUT_DIR / next(a["out"] for a in ASSETS if a["id"] == asset_id)
    img = Image.open(raw_path).convert("RGB")
    enhancer = ImageEnhance.Brightness(img)
    img = enhancer.enhance(0.94)
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.06)
    img.save(out_path, optimize=True)
    print(f"[{asset_id}] post-processed -> {out_path}", flush=True)
    return str(out_path)


def main():
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(generate, a): a for a in ASSETS}
        results = []
        for fut in as_completed(futs):
            asset_id, raw_path, err = fut.result()
            if err or not raw_path:
                print(f"[{asset_id}] skipped post-process due to error", flush=True)
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
        print(f"  {aid:24s} -> {Path(path).name:36s} {size/1024:.1f} KB", flush=True)


if __name__ == "__main__":
    main()
