"""
FAL gpt-image-2 brand imagery generator for kolm.

Set FAL_KEY or FAL_API_KEY in your environment before running this script.
Never hard-code provider keys in this repository.
"""
import os
import time
import json
import threading
import pathlib
import traceback
import requests

KEY = os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")
if not KEY:
    raise SystemExit("Set FAL_KEY or FAL_API_KEY before running scripts/fal_generate_v6.py")
OUT = pathlib.Path(__file__).resolve().parents[1] / "public" / "img"
OUT.mkdir(parents=True, exist_ok=True)
GEN = OUT / "_generations"
GEN.mkdir(parents=True, exist_ok=True)

ENDPOINT = "https://queue.fal.run/fal-ai/gpt-image-2"

HEADERS = {
    "Authorization": f"Key {KEY}",
    "Content-Type": "application/json",
}

# Universal style suffix (KOLM_BLACK_UNICORN_SPEC.md §6.3) appended to every prompt.
SUFFIX = (
    "Photoreal product render, medium-format studio capture, 5600K cool key + soft 2:1 fill to hold detail in the blacks, "
    "single phosphor-green rim light tracing the edges. Deep obsidian field #08090A, rich true blacks, no banding. "
    "Phosphor/uranium green #3FE5A0 used surgically as the ONLY chroma — a glow, not a flood. Brushed graphite and gunmetal "
    "hardware, satin not glossy. Premium, expensive, buttoned-up, restrained. No text, no letters, no numbers, no logos, "
    "no UI labels, no watermark, no people. Atomic-age retro-futurist instrument character, editorial, monolithic."
)

# Six renders. Each has (slug, image_size, prompt) where prompt = scene + SUFFIX.
# Brand: near-black obsidian, ONE phosphor-green #3FE5A0 accent (no blue/purple), blank/unlabeled
# panels (gpt-image-2 renders text accurately, so any instrument noun risks a legible label).
# image_size is a named enum OR a {"width","height"} dict (the hero uses a custom OG size).
RENDERS = [
    (
        "kn-hero-reactor-panel",
        {"width": 1200, "height": 632},  # custom OG/hero size (§6.5); promote -> crop 2px -> 1200x630
        "A machined obsidian instrument panel photographed dead-on in a near-black studio, hairline-thin gunmetal seams "
        "dividing four stacked horizontal data lanes that are blank and unlabeled — no text, no characters, no engraved words, "
        "a single phosphor-green #3FE5A0 rim light tracing the top edge and one glowing green pilot LED at the upper left, "
        "the lanes lit only by faint green indicator dots, deep field #08090A to #0F1011 to #191A1B, satin not glossy, one soft "
        "volumetric green bloom behind the panel's right shoulder, fine containment grooves milled into the bezel, expensive and restrained. "
        + SUFFIX,
    ),
    (
        "kn-artifact-core",
        "square_hd",
        "A single small dense matte-black artifact the size of a fist resting on a polished obsidian plinth in a void, its faces "
        "milled with concentric containment rings and one phosphor-green #3FE5A0 core seam glowing from a hairline gap as if sealed "
        "under pressure, a tiny abstract geometric core-mark embossed at center — a glyph, not letters, not a logo, no text, "
        "deep field #08090A to #0F1011 to #191A1B, rich true blacks, satin gunmetal edge catching a single green rim light, "
        "monolithic, watch-movement precision. "
        + SUFFIX,
    ),
    (
        "kn-runtime-shrink",
        "landscape_16_9",
        "A black architectural diptych in one frame: on the left a large machined obsidian instrument slab, on the right the "
        "identical object shrunk to a small handheld matte-black device, both in the same satin gunmetal material with blank "
        "unlabeled faces — no text, no buttons with writing, no screens with characters, connected by a single thin glowing "
        "phosphor-green #3FE5A0 line of light tracing from the large object to the small one, deep field #08090A to #0F1011 to "
        "#191A1B, single key light, deep shadows, the same artifact at two scales, monolithic minimalism. "
        + SUFFIX,
    ),
    (
        "kn-anatomy-stack",
        "portrait_16_9",
        "A precision exploded-view of a small black sealed artifact opened in cross-section — five horizontal paper-thin obsidian "
        "layers floating with knife-edge spacing, each a different microtexture (woven, etched, gridded, pierced, brushed), all "
        "faces blank and unlabeled with no engraved text, no numbers, no callouts, no annotation marks, one single phosphor-green "
        "#3FE5A0 thread of light running vertically through all five layers like a binding line, deep field #08090A to #0F1011 to "
        "#191A1B, studio macro, top light, soft shadows, watch-movement precision, editorial restraint. "
        + SUFFIX,
    ),
    (
        "kn-containment-texture",
        "landscape_16_9",
        "A full-bleed near-black field of finely machined obsidian — softly milled concentric containment rings and a faint "
        "scanline grain, lit by one low phosphor-green #3FE5A0 glow rising from the lower edge like reactor light through a vent, "
        "no focal object, pure texture and atmosphere, deep field #08090A to #0F1011 to #191A1B, true blacks with no banding, "
        "the green a faint rim not a flood, restrained, monolithic, used as an ambient band behind a CTA. "
        + SUFFIX,
    ),
    (
        "kn-verify-seal",
        "square_hd",
        "A macro of a single matte-black pressed seal in satin obsidian, a tiny abstract geometric proof-mark embossed dead "
        "center — a glyph, not letters, not a logo, no text, no readable characters — its recessed channels glowing with one thin "
        "phosphor-green #3FE5A0 line as if freshly verified, light raking from the upper left casting fine shadow grain across an "
        "enormous surrounding field of texture-rich black, deep field #08090A to #0F1011 to #191A1B, museum-grade still life, "
        "contemplative, precise. "
        + SUFFIX,
    ),
]


def submit(slug: str, size: str, prompt: str):
    body = {
        "prompt": prompt,
        "image_size": size,
        "num_images": 1,
        "quality": "high",
        "moderation": "auto",
        "background": "transparent" if False else "auto",
    }
    r = requests.post(ENDPOINT, headers=HEADERS, json=body, timeout=60)
    r.raise_for_status()
    return r.json()


def wait(qresp, slug):
    status_url = qresp["status_url"]
    response_url = qresp["response_url"]
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(4)
        s = requests.get(status_url, headers=HEADERS, timeout=30).json()
        st = s.get("status")
        if st == "COMPLETED":
            return requests.get(response_url, headers=HEADERS, timeout=60).json()
        if st in ("FAILED", "CANCELLED"):
            raise RuntimeError(f"{slug}: {s}")
    raise TimeoutError(f"{slug}: did not finish in 600s")


def download(url: str, dest: pathlib.Path):
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return len(r.content)


def run_one(slug: str, size: str, prompt: str):
    try:
        print(f"[{slug}] submitting...", flush=True)
        q = submit(slug, size, prompt)
        print(f"[{slug}] queued: {q.get('request_id', '?')}", flush=True)
        result = wait(q, slug)
        images = result.get("images") or []
        if not images:
            print(f"[{slug}] no images in result: {json.dumps(result)[:400]}", flush=True)
            return
        url = images[0].get("url")
        png_path = GEN / f"{slug}.png"
        size_b = download(url, png_path)
        print(f"[{slug}] saved {png_path.name} ({size_b//1024} KB)", flush=True)
    except Exception as e:
        traceback.print_exc()
        print(f"[{slug}] FAILED: {e}", flush=True)


def main():
    threads = []
    for slug, size, prompt in RENDERS:
        t = threading.Thread(target=run_one, args=(slug, size, prompt), daemon=False)
        t.start()
        threads.append(t)
        time.sleep(0.5)  # stagger so we don't burst-rate-limit
    for t in threads:
        t.join()
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
