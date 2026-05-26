"""Regenerate the phone shot — no hallucinated brand text.

Strict prompt: screen is mostly black with only a single small periwinkle dot.
NO words, NO logos, NO wordmark, NO subtitles.
"""
import os
import sys
import urllib.request
import time
from pathlib import Path

if not os.environ.get("FAL_KEY"):
    sys.exit("FAL_KEY env var required")

import fal_client
from PIL import Image, ImageEnhance

OUT_DIR = Path(__file__).resolve().parents[1] / "public" / "img"
RAW_DIR = OUT_DIR / "_generations"
RAW_DIR.mkdir(exist_ok=True, parents=True)

PROMPT = (
    "Hyperreal product photography of a single sleek matte-black smartphone "
    "(generic frameless slab, NO Apple logo, NO branding) floating in deep "
    "near-black space, three-quarter view tilted slightly, screen facing "
    "the camera. The screen is almost entirely deep matte-black with NO "
    "WORDS, NO LETTERS, NO WORDMARK, NO LOGO, NO TYPOGRAPHY, NO TEXT OF "
    "ANY KIND. The only thing visible on the screen is a single small "
    "softly glowing circular periwinkle (#7C8CFF) dot positioned in the "
    "lower-third center of the screen, like a status indicator. The phone's "
    "edges catch a precise rim-light from the upper left, casting a soft "
    "periwinkle bloom around the device. Museum-quality industrial press "
    "photography, like an Apple product render before content is added. "
    "Sub-millimeter edge precision. Shallow depth of field, deep blacks "
    "falling away behind the phone, faint silver dust in the air. NO humans, "
    "NO hands, NO environment, NO surface, NO reflection on table, NO names, "
    "NO interface elements, NO icons, NO buttons. Single periwinkle accent "
    "color only, no warm tones, no rainbow. The screen MUST be blank except "
    "for the single small dot."
)

print("starting fal subscribe (phone redo)...", flush=True)
t0 = time.time()
result = fal_client.subscribe(
    "fal-ai/gpt-image-2",
    arguments={
        "prompt": PROMPT,
        "image_size": "portrait_16_9",
        "num_images": 2,
    },
    with_logs=False,
)
elapsed = time.time() - t0
images = result.get("images") or result.get("data", {}).get("images") or []
print(f"got {len(images)} images in {elapsed:.1f}s", flush=True)

for i, im in enumerate(images):
    url = im.get("url") or im
    raw_path = RAW_DIR / f"run-on-device_v2_{i+1}_raw.png"
    urllib.request.urlretrieve(url, str(raw_path))
    print(f"saved -> {raw_path.name}", flush=True)

# pick the first by default; user can swap manually if v2 looks better
src = RAW_DIR / "run-on-device_v2_1_raw.png"
if src.exists():
    out = OUT_DIR / "run-on-device.png"
    img = Image.open(src).convert("RGB")
    img = ImageEnhance.Brightness(img).enhance(0.92)
    img = ImageEnhance.Contrast(img).enhance(1.10)
    img.save(out, optimize=True)
    print(f"installed -> {out.name} ({out.stat().st_size/1024:.1f} KB)", flush=True)
