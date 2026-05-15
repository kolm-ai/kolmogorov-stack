"""Model registry mirror of src/models.js. Python side authoritative for
training defaults; JS side is the source of truth for the catalog. Keep
shapes in sync by re-running ``scripts/check-model-parity.mjs`` after edits.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Model:
    id: str
    family: str
    params_b: float
    license: str
    tier: str
    vram_gb_4bit: float
    vram_gb_bf16: float
    context_tokens: int
    tokenizer_vocab: int
    tool_use: str
    multilingual: bool
    use_for: tuple[str, ...]
    notes: str = ""

    def fits_on(self, device: dict[str, Any]) -> bool:
        if not device:
            return False
        vram = device.get("vram_gb")
        if vram is None:
            return False
        if vram == 0:
            cpu_ram = device.get("cpu_ram_gb_min", 8)
            return 0.6 * self.params_b <= cpu_ram
        return self.vram_gb_4bit + 2 <= vram

    def trains_on(self, device: dict[str, Any]) -> bool:
        if not device or device.get("class") != "training":
            return False
        vram = device.get("vram_gb", 0)
        if not vram:
            return False
        return (self.vram_gb_4bit * 2) + 4 <= vram


MODELS: tuple[Model, ...] = (
    Model("Qwen/Qwen2.5-0.5B-Instruct", "qwen2.5", 0.5, "apache-2.0", "tiny",
          1.0, 1.5, 32768, 151936, "native", True,
          ("edge", "mobile", "wasm"), "Phone / Pi / WASM. Fastest; weakest reasoning."),
    Model("Qwen/Qwen2.5-1.5B-Instruct", "qwen2.5", 1.5, "apache-2.0", "small",
          2.0, 3.5, 32768, 151936, "native", True,
          ("laptop", "classifier", "extractor"), "Laptop iGPU / Apple Silicon 8GB."),
    Model("Qwen/Qwen2.5-3B-Instruct", "qwen2.5", 3, "apache-2.0", "default",
          4.0, 7.0, 32768, 151936, "native", True,
          ("default", "chat", "agent", "healthcare", "finance", "legal"),
          "DEFAULT. Apache 2.0, strong tool/JSON, fits 8GB consumer GPU."),
    Model("Qwen/Qwen2.5-7B-Instruct", "qwen2.5", 7, "apache-2.0", "quality",
          8.0, 16.0, 131072, 151936, "native", True,
          ("quality", "long-context", "rag"), "Quality tier. 128K YaRN context."),
    Model("Qwen/Qwen2.5-Coder-7B-Instruct", "qwen2.5-coder", 7, "apache-2.0", "coder",
          8.0, 16.0, 131072, 151936, "native", True,
          ("code", "agent"), "HumanEval 88.4. IDE / repo agents."),
    Model("Qwen/Qwen2.5-14B-Instruct", "qwen2.5", 14, "apache-2.0", "large",
          16.0, 30.0, 131072, 151936, "native", True,
          ("server", "high-stakes"), "Server-class. A100-40GB+."),
    Model("meta-llama/Llama-3.2-1B-Instruct", "llama3.2", 1, "llama-community", "tiny",
          1.5, 2.5, 131072, 128256, "limited", False,
          ("edge", "english-only"), "English-first edge."),
    Model("meta-llama/Llama-3.2-3B-Instruct", "llama3.2", 3, "llama-community", "alternate-default",
          4.0, 7.5, 131072, 128256, "limited", False,
          ("english-only", "long-context"), "Stronger English than Qwen 3B; weaker JSON."),
    Model("meta-llama/Llama-3.1-8B-Instruct", "llama3.1", 8, "llama-community", "quality",
          9.0, 18.0, 131072, 128256, "good", False,
          ("quality", "english-only"), "Mature stack."),
    Model("microsoft/Phi-3.5-mini-instruct", "phi3.5", 3.8, "mit", "reasoning-small",
          4.5, 8.0, 131072, 32064, "good", True,
          ("reasoning", "classifier", "mit-only"), "MIT license. Strong reasoning."),
    Model("google/gemma-3-1b-it", "gemma3", 1, "gemma", "tiny",
          1.5, 2.5, 32768, 262144, "limited", True,
          ("mobile", "edge"), "Mobile target. 2025-03 release."),
    Model("google/gemma-3-4b-it", "gemma3", 4, "gemma", "small",
          4.5, 8.5, 131072, 262144, "good", True,
          ("mobile", "vision", "multilingual"), "Closest match to 'Gemma 3B'. Vision input."),
    Model("google/gemma-3-12b-it", "gemma3", 12, "gemma", "large",
          14.0, 26.0, 131072, 262144, "good", True,
          ("vision", "quality"), "Vision+text 12B. 5090-friendly at 4-bit."),
    Model("google/gemma-2-2b-it", "gemma2", 2, "gemma", "small",
          2.5, 5.0, 8192, 256000, "limited", True,
          ("classifier", "extractor"), "Legacy. Prefer gemma-3-1b-it."),
    Model("mistralai/Ministral-3B-Instruct-2410", "ministral", 3, "mrl-research", "small",
          4.0, 7.0, 131072, 131072, "good", True,
          ("research",), "MRL license blocks commercial."),
    Model("HuggingFaceTB/SmolLM2-1.7B-Instruct", "smollm2", 1.7, "apache-2.0", "tiny",
          2.5, 4.0, 8192, 49152, "limited", False,
          ("edge", "classifier"), "Apache 2.0 tiny alternate."),
)

BY_ID: dict[str, Model] = {m.id: m for m in MODELS}
PERMISSIVE_LICENSES = {"apache-2.0", "mit"}

DEFAULT_MODEL = "Qwen/Qwen2.5-3B-Instruct"

TIER_BY_USE: dict[str, str] = {
    "default": "Qwen/Qwen2.5-3B-Instruct",
    "chat": "Qwen/Qwen2.5-3B-Instruct",
    "agent": "Qwen/Qwen2.5-3B-Instruct",
    "healthcare": "Qwen/Qwen2.5-3B-Instruct",
    "finance": "Qwen/Qwen2.5-3B-Instruct",
    "legal": "Qwen/Qwen2.5-3B-Instruct",
    "code": "Qwen/Qwen2.5-Coder-7B-Instruct",
    "edge": "Qwen/Qwen2.5-0.5B-Instruct",
    "mobile": "Qwen/Qwen2.5-0.5B-Instruct",
    "wasm": "Qwen/Qwen2.5-0.5B-Instruct",
    "laptop": "Qwen/Qwen2.5-1.5B-Instruct",
    "classifier": "Qwen/Qwen2.5-1.5B-Instruct",
    "extractor": "Qwen/Qwen2.5-1.5B-Instruct",
    "quality": "Qwen/Qwen2.5-7B-Instruct",
    "long-context": "Qwen/Qwen2.5-7B-Instruct",
    "rag": "Qwen/Qwen2.5-7B-Instruct",
    "server": "Qwen/Qwen2.5-14B-Instruct",
    "high-stakes": "Qwen/Qwen2.5-14B-Instruct",
    "reasoning": "microsoft/Phi-3.5-mini-instruct",
}

# Device profile registry mirror. Trimmed to the fields the trainer needs.
DEVICES: dict[str, dict[str, Any]] = {
    "rtx-5090":     {"id": "rtx-5090",     "class": "training",  "arch": "blackwell",     "sm": "12.0", "vram_gb": 32, "fp4": True,  "fp8": True,  "bf16": True, "flash_attn": "fa3", "cuda_min": "12.8", "torch_min": "2.7"},
    "rtx-4090":     {"id": "rtx-4090",     "class": "training",  "arch": "ada-lovelace",  "sm": "8.9",  "vram_gb": 24, "fp4": False, "fp8": True,  "bf16": True, "flash_attn": "fa2", "cuda_min": "12.1", "torch_min": "2.4"},
    "rtx-3090":     {"id": "rtx-3090",     "class": "training",  "arch": "ampere",        "sm": "8.6",  "vram_gb": 24, "fp4": False, "fp8": False, "bf16": True, "flash_attn": "fa2", "cuda_min": "11.8", "torch_min": "2.2"},
    "a100-40gb":    {"id": "a100-40gb",    "class": "training",  "arch": "ampere",        "sm": "8.0",  "vram_gb": 40, "fp4": False, "fp8": False, "bf16": True, "flash_attn": "fa2", "cuda_min": "11.8", "torch_min": "2.2"},
    "a100-80gb":    {"id": "a100-80gb",    "class": "training",  "arch": "ampere",        "sm": "8.0",  "vram_gb": 80, "fp4": False, "fp8": False, "bf16": True, "flash_attn": "fa2", "cuda_min": "11.8", "torch_min": "2.2"},
    "h100-80gb":    {"id": "h100-80gb",    "class": "training",  "arch": "hopper",        "sm": "9.0",  "vram_gb": 80, "fp4": False, "fp8": True,  "bf16": True, "flash_attn": "fa3", "cuda_min": "12.4", "torch_min": "2.4"},
    "h200-141gb":   {"id": "h200-141gb",   "class": "training",  "arch": "hopper",        "sm": "9.0",  "vram_gb": 141, "fp4": False, "fp8": True, "bf16": True, "flash_attn": "fa3", "cuda_min": "12.4", "torch_min": "2.4"},
    "apple-m3-max": {"id": "apple-m3-max", "class": "training",  "arch": "apple-silicon", "sm": None,   "vram_gb": 64, "bf16": True,  "runtime": "mlx"},
    "apple-m2-pro": {"id": "apple-m2-pro", "class": "inference", "arch": "apple-silicon", "sm": None,   "vram_gb": 16, "bf16": True,  "runtime": "mlx"},
    "iphone-15-pro":{"id": "iphone-15-pro","class": "inference", "arch": "apple-silicon", "sm": None,   "vram_gb": 4,  "runtime": "mlc-llm"},
    "pixel-8-pro":  {"id": "pixel-8-pro",  "class": "inference", "arch": "arm64",         "sm": None,   "vram_gb": 3,  "runtime": "mediapipe"},
    "laptop-igpu":  {"id": "laptop-igpu",  "class": "inference", "arch": "x86_64",        "sm": None,   "vram_gb": 2,  "runtime": "directml"},
    "cpu-x86_64":   {"id": "cpu-x86_64",   "class": "inference", "arch": "x86_64",        "sm": None,   "vram_gb": 0, "cpu_ram_gb_min": 8, "runtime": "llama-cpp"},
    "wasm":         {"id": "wasm",         "class": "inference", "arch": "wasm32",        "sm": None,   "vram_gb": 0, "cpu_ram_gb_min": 1, "runtime": "transformers-js"},
}

TRAIN_DEFAULT_BY_DEVICE: dict[str, str] = {
    "rtx-5090": "Qwen/Qwen2.5-7B-Instruct",
    "rtx-4090": "Qwen/Qwen2.5-7B-Instruct",
    "rtx-3090": "Qwen/Qwen2.5-7B-Instruct",
    "a100-40gb": "Qwen/Qwen2.5-14B-Instruct",
    "a100-80gb": "Qwen/Qwen2.5-14B-Instruct",
    "h100-80gb": "Qwen/Qwen2.5-14B-Instruct",
    "h200-141gb": "Qwen/Qwen2.5-14B-Instruct",
    "apple-m3-max": "Qwen/Qwen2.5-7B-Instruct",
    "apple-m2-pro": "Qwen/Qwen2.5-3B-Instruct",
}

INFER_DEFAULT_BY_DEVICE: dict[str, str] = {
    "rtx-5090": "Qwen/Qwen2.5-7B-Instruct",
    "rtx-4090": "Qwen/Qwen2.5-7B-Instruct",
    "rtx-3090": "Qwen/Qwen2.5-7B-Instruct",
    "a100-40gb": "Qwen/Qwen2.5-14B-Instruct",
    "apple-m3-max": "Qwen/Qwen2.5-7B-Instruct",
    "apple-m2-pro": "Qwen/Qwen2.5-3B-Instruct",
    "iphone-15-pro": "Qwen/Qwen2.5-1.5B-Instruct",
    "pixel-8-pro": "google/gemma-2-2b-it",
    "laptop-igpu": "Qwen/Qwen2.5-1.5B-Instruct",
    "cpu-x86_64": "Qwen/Qwen2.5-1.5B-Instruct",
    "wasm": "Qwen/Qwen2.5-0.5B-Instruct",
}


def info(model_id: str) -> Model | None:
    return BY_ID.get(model_id)


def device(device_id: str) -> dict[str, Any] | None:
    return DEVICES.get(device_id)


def detect_local_device() -> dict[str, Any]:
    """Return {id, source, confidence} matching src/devices.js detectLocal()."""
    if os.environ.get("KOLM_DEVICE"):
        d = device(os.environ["KOLM_DEVICE"])
        if d:
            return {"id": d["id"], "source": "env", "confidence": 1.0}

    # Try nvidia-smi.
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,compute_cap",
             "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            line = out.stdout.strip().splitlines()[0]
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                name = parts[0]
                vram_mib = float(parts[1].replace(" MiB", ""))
                sm = parts[2]
                did = _match_gpu(name, vram_mib, sm)
                if did:
                    return {"id": did, "source": "nvidia-smi", "confidence": 0.95,
                            "raw": {"name": name, "vram_gb": round(vram_mib / 1024, 1), "sm": sm}}
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass

    # Fallback.
    return {"id": "cpu-x86_64", "source": "fallback", "confidence": 0.5}


def _match_gpu(name: str, vram_mib: float, sm: str) -> str | None:
    if "RTX 5090" in name: return "rtx-5090"
    if "RTX 4090" in name: return "rtx-4090"
    if "RTX 3090" in name: return "rtx-3090"
    if "H200" in name: return "h200-141gb"
    if "H100" in name: return "h100-80gb"
    if "A100" in name:
        return "a100-80gb" if vram_mib >= 70_000 else "a100-40gb"
    return None


def recommend(*, use: str = "default", vram_gb: float | None = None,
              permissive: bool = False, english_only: bool = False,
              tool_use: str | None = None, target_device: dict | None = None,
              train_device: dict | None = None) -> dict[str, Any]:
    """Score-and-pick a model. Mirror of src/models.js recommend()."""
    explicit = TIER_BY_USE.get(use)
    if target_device and vram_gb is None:
        vram_gb = target_device.get("vram_gb")

    scored = []
    for m in MODELS:
        s = 0.0
        if m.license == "apache-2.0": s += 0.30
        elif m.license == "mit": s += 0.28
        elif m.license == "gemma": s += 0.15
        elif m.license == "llama-community": s += 0.10
        if permissive and m.license not in PERMISSIVE_LICENSES: s -= 1.0

        if vram_gb is not None:
            if m.vram_gb_4bit > vram_gb: s -= 1.0
            else: s += 0.20 * (1 - (vram_gb - m.vram_gb_4bit) / max(vram_gb, 1))
        elif 2 <= m.params_b <= 4:
            s += 0.15

        if tool_use == "native" and m.tool_use == "native": s += 0.10
        elif m.tool_use in ("native", "good"): s += 0.05

        if not english_only and m.multilingual: s += 0.05
        if use in m.use_for: s += 0.20

        if target_device and not m.fits_on(target_device): s -= 1.0
        if train_device and not m.trains_on(train_device): s -= 1.0

        scored.append((m, round(s, 4)))

    scored.sort(key=lambda r: r[1], reverse=True)
    viable = [r for r in scored if r[1] > 0]
    pick = (viable or scored)[0][0]

    return {
        "pick": pick.id,
        "explicit_tier_pick": explicit,
        "top": [{"id": m.id, "score": s} for m, s in scored[:5]],
        "device_fit": pick.fits_on(target_device) if target_device else None,
        "device_train": pick.trains_on(train_device) if train_device else None,
    }


def resolve_base(*, tenant: str | None = None, use: str | None = None) -> str:
    """Tenant pin > KOLM_BASE_MODEL env > TIER_BY_USE > DEFAULT_MODEL."""
    if tenant:
        pinned = _get_pin(tenant)
        if pinned:
            return pinned
    if os.environ.get("KOLM_BASE_MODEL"):
        return os.environ["KOLM_BASE_MODEL"]
    if use and use in TIER_BY_USE:
        return TIER_BY_USE[use]
    return DEFAULT_MODEL


def _pin_path() -> Path:
    base = os.environ.get("KOLM_HOME") or os.path.join(
        os.environ.get("HOME") or os.environ.get("USERPROFILE") or ".", ".kolm")
    return Path(base) / "model-pins.json"


def _get_pin(tenant: str) -> str | None:
    p = _pin_path()
    if not p.exists():
        return None
    try:
        pins = json.loads(p.read_text(encoding="utf-8"))
        return pins.get(tenant)
    except (json.JSONDecodeError, OSError):
        return None


def set_pin(tenant: str, model_id: str) -> str:
    if model_id not in BY_ID:
        raise ValueError(f"unknown model: {model_id}")
    p = _pin_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    pins = {}
    if p.exists():
        try:
            pins = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pins = {}
    pins[tenant] = model_id
    p.write_text(json.dumps(pins, indent=2), encoding="utf-8")
    return model_id
