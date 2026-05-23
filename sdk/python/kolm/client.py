"""HTTP client for the kolm compile/run/verify API."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional, Union


DEFAULT_BASE = os.environ.get("KOLM_BASE", "https://kolm.ai")

# W723 — Streaming load. Best-effort import of the per-shard streaming
# loader from apps/runtime/. We do NOT make it a hard dependency: when
# the SDK is installed from a wheel that does not ship apps/runtime,
# stream=True falls back to an honest envelope.
_STREAMING_LOAD_FN = None
try:  # pragma: no cover - import-resolution side path
    _here = Path(__file__).resolve()
    # repo layout: <repo>/sdk/python/kolm/client.py + <repo>/apps/runtime/
    for ancestor in _here.parents:
        candidate = ancestor / "apps" / "runtime" / "streaming_load.py"
        if candidate.exists():
            if str(candidate.parent) not in sys.path:
                sys.path.insert(0, str(candidate.parent))
            from streaming_load import stream_artifact_layers as _saload  # type: ignore
            _STREAMING_LOAD_FN = _saload
            break
except Exception:  # pragma: no cover - intentionally swallow; honest fallback handles it
    _STREAMING_LOAD_FN = None


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
        # api_key is only required for network operations (compile/status/
        # wait). Local operations (run on a local .kolm, run stream=True,
        # verify --offline) work without one. We defer the error to the
        # first network call rather than raise at construction time.
        self.api_key = api_key or os.environ.get("KOLM_KEY")
        self.base = base.rstrip("/")
        self.cli = cli

    def _require_api_key(self, op: str) -> str:
        if not self.api_key:
            raise KolmError(401, f"missing api key for {op} (pass api_key= or set KOLM_KEY env)")
        return self.api_key

    # ----- HTTP -----

    def _http(self, method: str, path: str, body: Any = None) -> dict:
        api_key = self._require_api_key(f"{method} {path}")
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {api_key}")
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

    def run(
        self,
        artifact_path: str | os.PathLike,
        input: str = "",
        *,
        stream: bool = False,
    ) -> Union[RunResult, dict, Iterator[dict]]:
        """Run a .kolm artifact locally.

        Default (``stream=False``):
            Shells out to the Node CLI, returns a ``RunResult`` dataclass
            with the final response. Backward-compatible with v0.2.0.

            If the Node CLI is not installed, returns an honest-envelope
            ``dict`` instead of raising — so callers in test environments
            can detect the missing dependency without ``try/except``.

        W723 streaming (``stream=True``):
            Returns an iterator that yields ``{event, shard_index,
            total_shards, bytes_loaded, total_bytes, layer_names}`` events
            as each weight shard surfaces from the artifact. The engine
            can begin processing layer 0 the moment shard 0 arrives,
            instead of waiting for the full artifact to load.

            For remote artifacts (string starting with http:// or
            https://), streaming is not yet wired through the HTTP
            backend; the iterator yields a SINGLE honest-envelope dict
            ``{ok: False, error: 'streaming_remote_not_yet_implemented',
            hint: 'use local .kolm path'}`` and stops.
        """
        path_str = os.fspath(artifact_path)
        looks_remote = path_str.startswith("http://") or path_str.startswith("https://")

        if stream:
            return self._run_stream(path_str, looks_remote=looks_remote)

        # Non-streaming path: existing CLI-shelling behavior.
        cli = self._cli_or_none()
        if cli is None:
            return {
                "ok": False,
                "error": "cli_not_installed",
                "hint": "kolm CLI not installed; required for run. "
                "Run: npm i -g github:sneaky-hippo/kolm-stack",
            }
        artifact_resolved = Path(path_str).expanduser().resolve()
        r = subprocess.run(
            [cli, "run", str(artifact_resolved), "--in", input, "--json"],
            capture_output=True, text=True,
        )
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

    def _run_stream(self, path_str: str, *, looks_remote: bool) -> Iterator[dict]:
        """W723 streaming generator. See :meth:`run` docstring."""
        if looks_remote:
            yield {
                "ok": False,
                "error": "streaming_remote_not_yet_implemented",
                "hint": "use local .kolm path; remote HTTP streaming "
                "lands in a follow-up wave",
            }
            return

        if _STREAMING_LOAD_FN is None:
            yield {
                "ok": False,
                "error": "streaming_loader_unavailable",
                "hint": "apps/runtime/streaming_load.py is not importable "
                "from this install — ensure the kolm repo layout is intact",
            }
            return

        artifact_resolved = Path(path_str).expanduser().resolve()
        if not artifact_resolved.exists():
            yield {
                "ok": False,
                "error": "artifact_not_found",
                "hint": f"no such file: {artifact_resolved}",
            }
            return

        try:
            for ev in _STREAMING_LOAD_FN(str(artifact_resolved)):
                yield ev
        except Exception as e:  # StreamingLoadError + any I/O blow-up
            code = getattr(e, "code", "streaming_failed")
            hint = getattr(e, "hint", str(e))
            yield {"ok": False, "error": code, "hint": hint}

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

    # ----- W734: RAG-aware capture -----

    def capture_with_context(
        self,
        prompt: str,
        retrieved: list,
        response: str,
        namespace: str = "default",
    ) -> dict:
        """W734-3 helper: log a capture row WITH the retrieved chunks the
        upstream LLM was shown.

        ``retrieved`` is a list of ``{source, text, score?}`` dicts — one per
        chunk that landed in the LLM's context window. Each item must have a
        ``source`` (URL/document id) and ``text`` (the chunk content); ``score``
        is optional (the retriever's similarity score, when available).

        The list is JSON-encoded then base64-encoded and sent on the
        ``kolm-retrieved-context`` request header so structured chunks
        survive HTTP escaping. The server (W734-1) parses the header and
        persists the chunks on the capture row alongside prompt + response,
        letting the W734-2 training-data formatter prefix them as
        ``<RETRIEVED>`` blocks at distill time.

        Returns the server's JSON envelope (or raises ``KolmError`` on
        non-2xx). The server returns 400 with
        ``error: 'invalid_retrieved_context_header'`` if the encoded
        payload is malformed, so misconfigured callers fail loud.

        Example::

            client.capture_with_context(
                prompt="When did kolm.ai launch?",
                retrieved=[
                    {"source": "kolm.ai/changelog", "text": "Launched 2026-05", "score": 0.92},
                ],
                response="kolm.ai launched in May 2026.",
                namespace="customer-support",
            )
        """
        if not isinstance(prompt, str) or not prompt:
            raise KolmError(400, "capture_with_context: prompt (non-empty str) required")
        if not isinstance(response, str):
            raise KolmError(400, "capture_with_context: response (str) required")
        if not isinstance(retrieved, list):
            raise KolmError(400, "capture_with_context: retrieved must be a list of {source, text, score?} dicts")
        for i, item in enumerate(retrieved):
            if not isinstance(item, dict) or "source" not in item or "text" not in item:
                raise KolmError(400, f"capture_with_context: retrieved[{i}] must have 'source' and 'text' fields")

        import base64
        payload_json = json.dumps(retrieved, separators=(",", ":"))
        header_val = base64.b64encode(payload_json.encode("utf-8")).decode("ascii")

        api_key = self._require_api_key("POST /v1/capture/log")
        url = self.base + "/v1/capture/log"
        body = {
            "namespace": namespace,
            "items": [{"input": prompt, "output": response}],
            "provider": "manual",
        }
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Authorization", f"Bearer {api_key}")
        req.add_header("Content-Type", "application/json")
        # W734-3 header — base64 JSON array of {source, text, score?}.
        req.add_header("kolm-retrieved-context", header_val)
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

    # ----- CLI presence -----

    def _cli_or_none(self) -> Optional[str]:
        from shutil import which
        return which(self.cli)

    def _cli_or_raise(self, op: str) -> str:
        cli = self._cli_or_none()
        if not cli:
            raise KolmError(503, f"kolm CLI not installed; required for {op}. Run: npm i -g github:sneaky-hippo/kolm-stack")
        return cli


# W723 — expose ``Client`` as an alias for ``Kolm`` so callers using the
# generic name (``from kolm.client import Client``) work the same way. The
# canonical name remains ``Kolm`` (matches the brand and existing imports).
Client = Kolm
