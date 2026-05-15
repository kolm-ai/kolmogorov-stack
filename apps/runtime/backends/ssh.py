"""
apps/runtime/backends/ssh.py

SSH backend. The user's own GPU box, accessible over SSH. We open a tunnel
to a kolm-serve process running on the remote and forward requests to its
local HTTP port. Cost is $0 (user owns the hardware) but we still record
wall time in the receipt for capacity planning.

Auth: KOLM_SSH_HOST + KOLM_SSH_USER + KOLM_SSH_PORT (default 22). Public-
key auth only; we never accept passwords.

Pricing: $0. Notes record the device class the user declared via
KOLM_SSH_GPU (free-form string; recorded verbatim in the receipt).
"""

from __future__ import annotations

import json
import os
import shutil
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote, _env_missing
from .local_cpu import _params_billion_from_artifact, _fallback_response


class SSHBackend(BackendAdapter):
    info = BackendInfo(
        name="remote-ssh",
        family="remote",
        description="Your own GPU box over SSH. Public-key auth only.",
        requires_env=["KOLM_SSH_HOST", "KOLM_SSH_USER"],
        requires_pip=[],
        docs_url="/compute#ssh",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        if not shutil.which("ssh"):
            return Detection(available=False, reason="ssh binary not on PATH")
        host = os.environ.get("KOLM_SSH_HOST", "")
        user = os.environ.get("KOLM_SSH_USER", "")
        return Detection(
            available=True,
            reason=f"ssh ready: {user}@{host}",
            device_name=os.environ.get("KOLM_SSH_GPU", "user-declared"),
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        gpu = os.environ.get("KOLM_SSH_GPU", "unknown")
        tps = self._declared_tps(gpu)
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 50.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=3.0,
            notes=f"{gpu} ~{scaled:.0f} tok/s (declared; $0 paid)",
        )

    def _declared_tps(self, gpu: str) -> float:
        g = gpu.upper()
        if "H100" in g: return 3800.0
        if "H200" in g: return 4400.0
        if "B200" in g: return 7500.0
        if "A100" in g: return 2400.0
        if "4090" in g: return 1800.0
        if "MI300" in g: return 3200.0
        return 1000.0

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        host = os.environ.get("KOLM_SSH_HOST", "")
        user = os.environ.get("KOLM_SSH_USER", "")
        port = os.environ.get("KOLM_SSH_PORT", "22")
        remote_port = os.environ.get("KOLM_SSH_REMOTE_PORT", "8000")
        local_port = os.environ.get("KOLM_SSH_LOCAL_PORT", "8765")

        if not (host and user):
            return _fallback_response(request, backend="ssh (host/user missing)")

        tunnel = _open_ssh_tunnel(user, host, port, local_port, remote_port)
        if not tunnel:
            return _fallback_response(request, backend="ssh (tunnel failed)")

        t0 = time.time()
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{local_port}/v1/chat/completions",
                data=json.dumps(request).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                response = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            response = _fallback_response(request, backend=f"ssh (error: {e})")
        finally:
            _close_ssh_tunnel(tunnel)

        wall = time.time() - t0
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "remote-ssh",
            "wall_seconds": wall,
            "price_usd": 0.0,
            "host": host,
        })
        return response


def _open_ssh_tunnel(user, host, port, local_port, remote_port):
    import subprocess

    args = [
        "ssh", "-fN",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-p", str(port),
        "-L", f"{local_port}:127.0.0.1:{remote_port}",
        f"{user}@{host}",
    ]
    try:
        proc = subprocess.Popen(args)
        proc.wait(timeout=10)
        return proc.pid if proc.returncode == 0 else None
    except Exception:
        return None


def _close_ssh_tunnel(pid):
    if not pid:
        return
    try:
        import os as _os
        _os.kill(pid, 15)
    except Exception:
        pass
