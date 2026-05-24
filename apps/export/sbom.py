#!/usr/bin/env python3
"""W763 — SBOM emitter (CycloneDX 1.5 + SPDX 2.3).

Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 569-574):
    [W763-1] SBOM for every .kolm artifact and every kolm release
    [W763-2] Pin all dependency versions with hash verification
    [W763-3] Snyk/Dependabot on every release
    [W763-4] /security/sbom.html published

Stdlib only — NO heavy deps. Same import-pattern contract as W740 importers
(apps/import/*.py). The Node-side src/sbom-emit.js carries the same logic;
this script is here so CI runners that don't have Node can generate SBOMs.

Inputs accepted (one or more):
    --manifest         kolm manifest.json (artifact dep block)
    --package-lock     npm package-lock.json
    --requirements     pip requirements.txt (hash pinning surfaced)
    --cargo-lock       Cargo.lock (TOML — minimal parser)

Output:
    JSON envelope on stdout
        { ok: true, version: 'w763-v1', format: <fmt>,
          component_count: <n>, source_files: [<paths>], sbom: <obj> }
    JSON envelope on stderr on failure (exit 3)

Streaming-friendly: each input file is read in one pass, components walked
without holding the whole SBOM in memory beyond the assembled list. For
very large package-lock.json (>50 MB) callers should pipe to jq downstream.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any

SBOM_VERSION = "w763-v1"
SBOM_FORMATS = ("cyclonedx-json", "spdx-json")

CYCLONEDX_SPEC = "1.5"
SPDX_VERSION = "SPDX-2.3"
CYCLONEDX_SCHEMA_URL = "http://cyclonedx.org/schema/bom-1.5.schema.json"
SPDX_SCHEMA_URL = "https://spdx.github.io/spdx-spec/v2.3/"


# =============================================================================
# Internal helpers
# =============================================================================

def _normalize_integrity(integrity: str | None) -> dict | None:
    """npm-style 'sha512-<b64>' → {alg:'SHA-512', content:<hex>}."""
    if not isinstance(integrity, str) or "-" not in integrity:
        return None
    alg, _, b64 = integrity.partition("-")
    alg_norm = alg.upper().replace("SHA", "SHA-", 1)
    try:
        hex_content = base64.b64decode(b64).hex()
    except (binascii.Error, ValueError):
        hex_content = "unknown"
    return {"alg": alg_norm, "content": hex_content}


def _components_from_lock(lock: dict) -> list[dict]:
    """package-lock.json v3 → CycloneDX component list."""
    if not isinstance(lock, dict):
        return []
    packages = lock.get("packages") or {}
    if not isinstance(packages, dict):
        return []
    out: list[dict] = []
    for pkg_path, meta in packages.items():
        if not pkg_path:  # root
            continue
        if not isinstance(meta, dict):
            continue
        version = meta.get("version")
        if not version:
            continue
        segments = [s for s in pkg_path.split("node_modules/") if s]
        last = segments[-1] if segments else ""
        name = last
        if not name.startswith("@") and "/" in name:
            name = name.split("/", 1)[0]
        if not name:
            continue
        purl = f"pkg:npm/{name}@{version}"
        component = {
            "type": "library",
            "bom-ref": purl,
            "name": name,
            "version": version,
            "purl": purl,
            "scope": "optional" if meta.get("dev") else "required",
        }
        h = _normalize_integrity(meta.get("integrity"))
        if h:
            component["hashes"] = [h]
        lic = meta.get("license")
        if isinstance(lic, str) and lic:
            component["licenses"] = [{"license": {"id": lic}}]
        out.append(component)
    return out


def _components_from_manifest(manifest: dict) -> list[dict]:
    """kolm artifact manifest → CycloneDX component list."""
    if not isinstance(manifest, dict):
        return []
    out: list[dict] = []
    seen: set[str] = set()

    def _push(name: str | None, version: str | None,
              hash_str: str | None, ecosystem: str | None) -> None:
        if not isinstance(name, str) or not name:
            return
        key = f"{name}@{version or 'unknown'}"
        if key in seen:
            return
        seen.add(key)
        eco = ecosystem or "npm"
        ver = version or "unknown"
        purl = f"pkg:{eco}/{name}@{ver}"
        c: dict[str, Any] = {
            "type": "library",
            "bom-ref": purl,
            "name": name,
            "version": ver,
            "purl": purl,
        }
        if isinstance(hash_str, str) and hash_str:
            alg = "SHA-256"
            content = hash_str
            if "-" in hash_str:
                a, _, h = hash_str.partition("-")
                alg = a.upper().replace("SHA", "SHA-", 1)
                try:
                    content = base64.b64decode(h).hex()
                except (binascii.Error, ValueError):
                    content = h or "unknown"
            c["hashes"] = [{"alg": alg, "content": content}]
        out.append(c)

    deps = manifest.get("deps")
    if isinstance(deps, list):
        for d in deps:
            if isinstance(d, dict):
                _push(d.get("name"), d.get("version"),
                      d.get("hash"), d.get("ecosystem"))
    bom = manifest.get("bom")
    if isinstance(bom, list):
        for d in bom:
            if isinstance(d, dict):
                _push(d.get("name"), d.get("version"),
                      d.get("hash"), d.get("ecosystem"))
    dependencies = manifest.get("dependencies")
    if isinstance(dependencies, dict):
        for name, version in dependencies.items():
            _push(name, version if isinstance(version, str) else None,
                  None, "npm")
    return out


_REQ_LINE_RE = re.compile(r"^([A-Za-z0-9_.\-\[\]]+)\s*(==|>=|<=|~=|!=)?\s*([^\s;]+)?")
_REQ_HASH_RE = re.compile(r"--hash=([a-z0-9]+):([a-fA-F0-9]+)")


def _components_from_requirements(text: str) -> tuple[list[dict], int, int]:
    """pip requirements.txt (hash-pinned or not) → CycloneDX component list."""
    if not isinstance(text, str):
        return [], 0, 0
    # Normalize line continuations.
    flat = re.sub(r"\\\s*\n", " ", text)
    lines = [
        ln.strip()
        for ln in flat.split("\n")
        if ln.strip() and not ln.strip().startswith("#")
    ]
    out: list[dict] = []
    hashed = 0
    unhashed = 0
    for line in lines:
        if line.startswith("-"):
            continue
        m = _REQ_LINE_RE.match(line)
        if not m:
            continue
        name = m.group(1)
        version = m.group(3)
        hashes: list[dict] = []
        for hm in _REQ_HASH_RE.finditer(line):
            alg = hm.group(1).upper().replace("SHA", "SHA-", 1)
            hashes.append({"alg": alg, "content": hm.group(2)})
        ver = version or "unknown"
        purl = f"pkg:pypi/{name}@{ver}"
        c: dict[str, Any] = {
            "type": "library",
            "bom-ref": purl,
            "name": name,
            "version": ver,
            "purl": purl,
        }
        if hashes:
            c["hashes"] = hashes
            hashed += 1
        else:
            c["properties"] = [{"name": "kolm:no_hash", "value": "true"}]
            unhashed += 1
        out.append(c)
    return out, hashed, unhashed


_CARGO_PKG_BLOCK_RE = re.compile(
    r'\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"'
    r'(?:[^\[]*?checksum\s*=\s*"([^"]+)")?',
    re.MULTILINE,
)


def _components_from_cargo_lock(text: str) -> list[dict]:
    """Cargo.lock (TOML) → CycloneDX component list. Minimal regex parse."""
    if not isinstance(text, str):
        return []
    out: list[dict] = []
    for m in _CARGO_PKG_BLOCK_RE.finditer(text):
        name = m.group(1)
        version = m.group(2)
        checksum = m.group(3)
        purl = f"pkg:cargo/{name}@{version}"
        c: dict[str, Any] = {
            "type": "library",
            "bom-ref": purl,
            "name": name,
            "version": version,
            "purl": purl,
        }
        if checksum:
            c["hashes"] = [{"alg": "SHA-256", "content": checksum}]
        out.append(c)
    return out


def _emit_cyclonedx(components: list[dict], root: dict | None = None) -> dict:
    return {
        "bomFormat": "CycloneDX",
        "specVersion": CYCLONEDX_SPEC,
        "serialNumber": "urn:uuid:" + str(uuid.uuid4()),
        "version": 1,
        "metadata": {
            "timestamp": datetime.datetime.now(datetime.timezone.utc)
            .isoformat().replace("+00:00", "Z"),
            "tools": [
                {"vendor": "kolm.ai", "name": "kolm-sbom-emit", "version": SBOM_VERSION},
            ],
            "component": root or {
                "type": "application",
                "name": "kolm-stack",
                "version": SBOM_VERSION,
            },
        },
        "components": components,
        "_schema_url": CYCLONEDX_SCHEMA_URL,
    }


def _emit_spdx(components: list[dict], doc_name: str = "kolm-stack-sbom") -> dict:
    packages = []
    for i, c in enumerate(components):
        pkg: dict[str, Any] = {
            "SPDXID": f"SPDXRef-Package-{i}",
            "name": c.get("name"),
            "versionInfo": c.get("version") or "NOASSERTION",
            "downloadLocation": c.get("purl") or "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": (
                ((c.get("licenses") or [{}])[0].get("license") or {}).get("id")
                or "NOASSERTION"
            ),
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
        }
        hashes = c.get("hashes")
        if isinstance(hashes, list) and hashes:
            pkg["checksums"] = [
                {
                    "algorithm": (h.get("alg") or "").replace("-", ""),
                    "checksumValue": h.get("content"),
                }
                for h in hashes
            ]
        packages.append(pkg)
    return {
        "spdxVersion": SPDX_VERSION,
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": doc_name,
        "documentNamespace": f"https://kolm.ai/sbom/{uuid.uuid4()}",
        "creationInfo": {
            "created": datetime.datetime.now(datetime.timezone.utc)
            .isoformat().replace("+00:00", "Z"),
            "creators": [f"Tool: kolm-sbom-emit-{SBOM_VERSION}"],
        },
        "packages": packages,
        "_schema_url": SPDX_SCHEMA_URL,
    }


# =============================================================================
# CLI
# =============================================================================

def _emit_envelope(format_: str, components: list[dict],
                   source_files: list[str], root_name: str | None = None) -> dict:
    if format_ == "cyclonedx-json":
        sbom = _emit_cyclonedx(
            components,
            root={"type": "application", "name": root_name or "kolm-stack",
                  "version": SBOM_VERSION},
        )
    else:
        sbom = _emit_spdx(components, doc_name=(root_name or "kolm-stack") + "-sbom")
    return {
        "ok": True,
        "version": SBOM_VERSION,
        "format": format_,
        "component_count": len(components),
        "source_files": source_files,
        "sbom": sbom,
    }


def _fail(error: str, hint: str = "") -> int:
    print(json.dumps({
        "ok": False,
        "error": error,
        "hint": hint,
        "version": SBOM_VERSION,
    }), file=sys.stderr)
    return 3


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Emit a CycloneDX or SPDX SBOM from kolm artifacts / lockfiles."
    )
    ap.add_argument("--manifest", help="kolm manifest.json")
    ap.add_argument("--package-lock", help="npm package-lock.json")
    ap.add_argument("--requirements", help="pip requirements.txt")
    ap.add_argument("--cargo-lock", help="Rust Cargo.lock")
    ap.add_argument(
        "--format",
        choices=list(SBOM_FORMATS),
        default="cyclonedx-json",
        help="SBOM format (default: cyclonedx-json)",
    )
    ap.add_argument("--output", "-o", help="write SBOM JSON to this path instead of stdout")
    args = ap.parse_args(argv[1:])

    if not (args.manifest or args.package_lock or args.requirements or args.cargo_lock):
        return _fail(
            "no_input",
            "pass at least one of --manifest / --package-lock / --requirements / --cargo-lock",
        )

    components: list[dict] = []
    source_files: list[str] = []
    root_name: str | None = None

    if args.manifest:
        p = Path(args.manifest)
        if not p.is_file():
            return _fail("manifest_not_found", f"path: {args.manifest}")
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError as e:
            return _fail("manifest_read_failed", str(e))
        try:
            manifest = json.loads(raw)
        except json.JSONDecodeError as e:
            return _fail("manifest_parse_failed", f"{type(e).__name__}: {e}")
        components.extend(_components_from_manifest(manifest))
        source_files.append(str(p.resolve()))
        root_name = manifest.get("name") or manifest.get("job_id") or root_name

    if args.package_lock:
        p = Path(args.package_lock)
        if not p.is_file():
            return _fail("package_lock_not_found", f"path: {args.package_lock}")
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError as e:
            return _fail("package_lock_read_failed", str(e))
        try:
            lock = json.loads(raw)
        except json.JSONDecodeError as e:
            return _fail("package_lock_parse_failed", f"{type(e).__name__}: {e}")
        components.extend(_components_from_lock(lock))
        source_files.append(str(p.resolve()))
        if not root_name:
            root_name = lock.get("name")

    if args.requirements:
        p = Path(args.requirements)
        if not p.is_file():
            return _fail("requirements_not_found", f"path: {args.requirements}")
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as e:
            return _fail("requirements_read_failed", str(e))
        comps, _hashed, _unhashed = _components_from_requirements(text)
        components.extend(comps)
        source_files.append(str(p.resolve()))

    if args.cargo_lock:
        p = Path(args.cargo_lock)
        if not p.is_file():
            return _fail("cargo_lock_not_found", f"path: {args.cargo_lock}")
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as e:
            return _fail("cargo_lock_read_failed", str(e))
        components.extend(_components_from_cargo_lock(text))
        source_files.append(str(p.resolve()))

    envelope = _emit_envelope(args.format, components, source_files, root_name)
    serialized = json.dumps(envelope, indent=2, sort_keys=False)
    if args.output:
        out = Path(args.output)
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(serialized + "\n", encoding="utf-8")
        except OSError as e:
            return _fail("output_write_failed", str(e))
        print(json.dumps({
            "ok": True,
            "version": SBOM_VERSION,
            "format": args.format,
            "component_count": len(components),
            "source_files": source_files,
            "output": str(out.resolve()),
        }))
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
