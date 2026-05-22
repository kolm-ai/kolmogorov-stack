"""HTTP client for the kolm compile/run/verify API."""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional


DEFAULT_BASE = os.environ.get("KOLM_BASE", "https://kolm.ai")


class KolmError(Exception):
    """Raised when the kolm API returns a non-2xx response."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        super().__init__(f"kolm API error {status}: {body}")


@dataclass
class CompileJob:
    id: str
    status: str
    raw: dict


@dataclass
class RunResult:
    text: str
    receipt_path: Optional[Path]
    runtime_ms: Optional[int]
    raw: dict


class Kolm:
    """Thin wrapper over the public HTTP API.

    Compile / run / verify shell out to the Node CLI when present so the
    Python user gets the same signed artifacts as a CLI user. Pure-HTTP
    paths (status, list) hit the API directly.
    """

    def __init__(self, api_key: Optional[str] = None, base: str = DEFAULT_BASE, cli: str = "kolm"):
        self.api_key = api_key or os.environ.get("KOLM_KEY")
        if not self.api_key:
            raise KolmError(401, "missing api key (pass api_key= or set KOLM_KEY env)")
        self.base = base.rstrip("/")
        self.cli = cli

    # ----- HTTP -----

    def _http(self, method: str, path: str, body: Any = None) -> dict:
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.api_key}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = resp.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8"))
            except Exception:
                err = {"error": str(e)}
            raise KolmError(e.code, err) from None

    # ----- compile -----

    def compile(
        self,
        task: str,
        examples_path: str | os.PathLike,
        base: str = "qwen2.5-7b-instruct",
        recall: Optional[str] = None,
        recipe_pack_depth: Optional[int] = None,
    ) -> CompileJob:
        """Start a compile job. Returns a CompileJob whose .id can be polled.

        Shells out to the Node CLI when available (uploads examples, signs
        the artifact); falls back to direct HTTP for the job creation.
        """
        examples_path = Path(examples_path).expanduser().resolve()
        if not examples_path.exists():
            raise KolmError(400, f"examples not found: {examples_path}")
        cli = self._cli_or_none()
        if cli is not None:
            args = [cli, "compile", task, "--examples", str(examples_path), "--base", base, "--json"]
            if recall is not None:
                args += ["--recall", recall]
            if recipe_pack_depth is not None:
                args += ["--recipe-pack-depth", str(recipe_pack_depth)]
            r = subprocess.run(args, capture_output=True, text=True, env={**os.environ, "KOLM_KEY": self.api_key, "KOLM_BASE": self.base})
            if r.returncode != 0:
                raise KolmError(500, r.stderr.strip() or "cli failed")
            payload = json.loads(r.stdout)
            return CompileJob(id=payload["id"], status=payload.get("status", "queued"), raw=payload)
        body = {
            "task": task,
            "examples_uri": str(examples_path),
            "base": base,
        }
        if recall is not None:
            body["recall"] = recall
        if recipe_pack_depth is not None:
            body["recipe_pack_depth"] = recipe_pack_depth
        payload = self._http("POST", "/v1/compile", body)
        return CompileJob(id=payload["id"], status=payload.get("status", "queued"), raw=payload)

    def status(self, job_id: str) -> CompileJob:
        payload = self._http("GET", f"/v1/compile/{job_id}")
        return CompileJob(id=job_id, status=payload.get("status", "unknown"), raw=payload)

    def wait(self, job_id: str, *, poll_interval: float = 5.0, timeout: float = 1800.0, out_dir: str | os.PathLike = ".") -> Path:
        """Poll until the compile job finishes and download the .kolm.

        Returns the absolute path to the saved artifact.
        """
        start = time.time()
        while True:
            job = self.status(job_id)
            if job.status == "ready":
                break
            if job.status in ("failed", "rejected"):
                raise KolmError(409, f"compile {job.status}: {job.raw.get('error', job.raw)}")
            if time.time() - start > timeout:
                raise KolmError(408, f"compile timed out after {timeout}s")
            time.sleep(poll_interval)
        url = self.base + f"/v1/compile/{job_id}/.kolm"
        out_path = Path(out_dir).expanduser().resolve() / f"{job_id}.kolm"
        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Bearer {self.api_key}")
        with urllib.request.urlopen(req, timeout=300) as resp, open(out_path, "wb") as fp:
            while chunk := resp.read(64 * 1024):
                fp.write(chunk)
        return out_path

    # ----- run / verify -----

    def run(self, artifact_path: str | os.PathLike, input: str) -> RunResult:
        """Run a .kolm locally via the CLI. Requires the Node CLI installed."""
        cli = self._cli_or_raise("run")
        artifact_path = Path(artifact_path).expanduser().resolve()
        r = subprocess.run([cli, "run", str(artifact_path), "--in", input, "--json"], capture_output=True, text=True)
        if r.returncode != 0:
            raise KolmError(500, r.stderr.strip() or "cli run failed")
        payload = json.loads(r.stdout)
        receipt = payload.get("receipt_path")
        return RunResult(
            text=payload.get("output", ""),
            receipt_path=Path(receipt) if receipt else None,
            runtime_ms=payload.get("runtime_ms"),
            raw=payload,
        )

    def verify(self, artifact_path: str | os.PathLike, *, offline: bool = False) -> dict:
        """Verify the receipt chain on a .kolm. Returns the parsed report."""
        cli = self._cli_or_raise("verify")
        artifact_path = Path(artifact_path).expanduser().resolve()
        args = [cli, "verify", str(artifact_path), "--json"]
        if offline:
            args.append("--offline")
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode != 0:
            raise KolmError(500, r.stderr.strip() or "cli verify failed")
        return json.loads(r.stdout)

    # ----- CLI presence -----

    def _cli_or_none(self) -> Optional[str]:
        from shutil import which
        return which(self.cli)

    def _cli_or_raise(self, op: str) -> str:
        cli = self._cli_or_none()
        if not cli:
            raise KolmError(503, f"kolm CLI not installed; required for {op}. Run: npm i -g github:sneaky-hippo/kolm-stack")
        return cli
