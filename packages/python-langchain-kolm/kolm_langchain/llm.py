"""KolmLLM - LangChain LLM that bridges to a kolm.ai compiled artifact.

Two transport modes:

1. **subprocess** - spawn ``kolm run <artifact_path> --json`` and write the
   prompt to stdin. The CLI returns a single JSON line on stdout containing
   ``text`` and ``receipt``.
2. **http** - POST ``{prompt}`` to ``{base_url}/v1/run/{artifact}`` with a
   Bearer token. Same response shape.

The class extends ``langchain_core.language_models.llms.LLM`` when LangChain
is installed. When it is not, a minimal stand-in is used so the adapter is
unit-testable in isolation.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib import request as _urllib_request
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit


try:
    from langchain_core.language_models.llms import LLM as _LangChainLLM

    try:
        from pydantic import PrivateAttr as _PrivateAttr
    except Exception:  # pragma: no cover - depends on installed LangChain stack
        _PrivateAttr = None  # type: ignore[assignment]

    _HAS_LANGCHAIN = True
except Exception:  # pragma: no cover - exercised only when LangChain absent
    _HAS_LANGCHAIN = False
    _PrivateAttr = None  # type: ignore[assignment]

    class _LangChainLLM:  # type: ignore[no-redef]
        """Minimal stand-in matching the LangChain LLM surface we depend on."""

        def __init__(self, **_: Any) -> None:
            pass

        def invoke(self, prompt: str, **kwargs: Any) -> str:
            return self._call(prompt, **kwargs)


DEFAULT_KOLM_BIN = "kolm"
DEFAULT_TIMEOUT_S = 30.0
MAX_TIMEOUT_S = 600.0
MAX_PROMPT_CHARS = 1_000_000
MAX_HTTP_ARTIFACT_CHARS = 512
MAX_SUBPROCESS_ARTIFACT_CHARS = 2048
MAX_STDERR_CHARS = 8192
MAX_STDOUT_CHARS = 2_000_000
MAX_HTTP_BODY_BYTES = 2_000_000
MAX_HTTP_ERROR_BYTES = 8192
MAX_ERROR_CHARS = 2000

# Back-compat export. Instances intentionally read KOLM_BIN during construction.
KOLM_BIN: str = os.environ.get("KOLM_BIN", DEFAULT_KOLM_BIN)

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SECRET_RES = (
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"\b(?:ks|kao)_[A-Za-z0-9._~+/=-]{8,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9._~+/=-]{8,}\b"),
    re.compile(r"\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{12,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
)


@dataclass
class _Result:
    text: str
    receipt: Optional[dict] = field(default_factory=lambda: None)


def _clean_error_text(value: Any) -> str:
    return _CONTROL_RE.sub(" ", str(value if value is not None else ""))


def _redact_secrets(value: Any, api_key: Optional[str] = None) -> str:
    text = _clean_error_text(value)
    if api_key:
        text = text.replace(str(api_key), "[redacted]")
    for pattern in _SECRET_RES:
        text = pattern.sub("[redacted]", text)
    return text


def _truncate(value: Any, max_chars: int = MAX_ERROR_CHARS) -> str:
    text = _clean_error_text(value)
    return text if len(text) <= max_chars else f"{text[:max_chars]}..."


def _normalize_timeout_s(value: Any) -> float:
    if value is None or value == "":
        return DEFAULT_TIMEOUT_S
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_S
    if not math.isfinite(seconds) or seconds <= 0:
        return DEFAULT_TIMEOUT_S
    return min(seconds, MAX_TIMEOUT_S)


def _normalize_base_url(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    parsed = urlsplit(str(value).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("KolmLLM: base_url must be a valid http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("KolmLLM: base_url must not include credentials")
    path = parsed.path.rstrip("/")
    normalized = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
    return normalized.rstrip("/")


def _require_prompt(prompt: Any) -> str:
    if not isinstance(prompt, str):
        raise TypeError("KolmLLM: prompt must be a string")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"KolmLLM: prompt exceeds {MAX_PROMPT_CHARS} characters")
    return prompt


def _require_bin_path(value: Any) -> str:
    binary = str(value or DEFAULT_KOLM_BIN).strip()
    if not binary or _CONTROL_RE.search(binary) or len(binary) > MAX_SUBPROCESS_ARTIFACT_CHARS:
        raise ValueError("KolmLLM: bin_path contains invalid characters")
    return binary


def _require_subprocess_artifact(value: Any) -> str:
    artifact = str(value or "").strip()
    if not artifact:
        raise ValueError("KolmLLM: artifact_path is required for subprocess mode")
    if len(artifact) > MAX_SUBPROCESS_ARTIFACT_CHARS or _CONTROL_RE.search(artifact):
        raise ValueError("KolmLLM: artifact_path contains invalid characters")
    return artifact


def _require_http_artifact(value: Any) -> str:
    artifact = str(value or "default").strip().replace("\\", "/")
    if not artifact:
        raise ValueError("KolmLLM: artifact_path must not be empty")
    if len(artifact) > MAX_HTTP_ARTIFACT_CHARS or _CONTROL_RE.search(artifact):
        raise ValueError("KolmLLM: artifact_path contains invalid characters")
    if ".." in artifact.split("/"):
        raise ValueError("KolmLLM: artifact_path must not traverse parent directories")
    return artifact


def _parse_runtime_output(raw: str) -> _Result:
    """Parse a kolm runtime stdout line. JSON preferred, plain text fallback."""
    if len(raw or "") > MAX_STDOUT_CHARS:
        raise RuntimeError(f"kolm runtime output exceeded {MAX_STDOUT_CHARS} characters")
    trimmed = (raw or "").strip()
    if not trimmed:
        return _Result(text="", receipt=None)
    if trimmed.startswith("{"):
        try:
            obj = json.loads(trimmed)
            text = obj.get("text") if isinstance(obj.get("text"), str) else obj.get("output", "")
            receipt = obj.get("receipt") or obj.get("audit")
            return _Result(text=text or "", receipt=receipt if isinstance(receipt, dict) else receipt)
        except json.JSONDecodeError:
            pass
    return _Result(text=trimmed, receipt=None)


def _read_limited_body(stream: Any, max_bytes: int = MAX_HTTP_BODY_BYTES) -> str:
    body = stream.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise RuntimeError(f"kolm http response exceeded {max_bytes} bytes")
    return body.decode("utf-8", errors="replace")


def _read_http_error_detail(error: HTTPError, api_key: Optional[str]) -> str:
    try:
        body = error.read(MAX_HTTP_ERROR_BYTES + 1)
    except Exception:
        body = b""
    if len(body) > MAX_HTTP_ERROR_BYTES:
        body = body[:MAX_HTTP_ERROR_BYTES]
    text = body.decode("utf-8", errors="replace")
    message = text
    try:
        obj = json.loads(text) if text.strip() else {}
        if isinstance(obj, dict):
            message = str(obj.get("error") or obj.get("message") or obj.get("detail") or text)
    except json.JSONDecodeError:
        pass
    return _truncate(_redact_secrets(message, api_key), MAX_ERROR_CHARS)


class KolmLLM(_LangChainLLM):
    """LangChain LLM backed by a ``.kolm`` artifact."""

    if _HAS_LANGCHAIN and _PrivateAttr is not None:
        _artifact_path: Optional[str] = _PrivateAttr(default=None)
        _base_url: Optional[str] = _PrivateAttr(default=None)
        _api_key: Optional[str] = _PrivateAttr(default=None)
        _bin: str = _PrivateAttr(default=DEFAULT_KOLM_BIN)
        _timeout_s: float = _PrivateAttr(default=DEFAULT_TIMEOUT_S)
        _last_receipt: Optional[dict] = _PrivateAttr(default=None)

    def __init__(
        self,
        artifact_path: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        bin_path: Optional[str] = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        **kwargs: Any,
    ) -> None:
        if not artifact_path and not base_url:
            raise ValueError(
                "KolmLLM: either artifact_path (subprocess) or base_url (HTTP) is required"
            )
        super().__init__(**kwargs)
        self._base_url = _normalize_base_url(base_url)
        self._artifact_path = (
            _require_http_artifact(artifact_path or "default")
            if self._base_url
            else _require_subprocess_artifact(artifact_path)
        )
        self._api_key = api_key or os.environ.get("KOLM_API_KEY")
        self._bin = _require_bin_path(bin_path or os.environ.get("KOLM_BIN") or DEFAULT_KOLM_BIN)
        self._timeout_s = _normalize_timeout_s(timeout_s)
        self._last_receipt = None

    @property
    def _llm_type(self) -> str:
        return "kolm"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {
            "artifact_path": self._artifact_path,
            "base_url": self._base_url,
            "bin": self._bin,
            "timeout_s": self._timeout_s,
        }

    @property
    def last_receipt(self) -> Optional[dict]:
        return self._last_receipt

    @last_receipt.setter
    def last_receipt(self, value: Optional[dict]) -> None:
        self._last_receipt = value

    def _call(
        self,
        prompt: str,
        stop: Optional[list[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> str:
        result = self._run(_require_prompt(prompt))
        self.last_receipt = result.receipt
        return result.text

    def invoke_with_receipt(self, prompt: str) -> dict[str, Any]:
        """Return both the text and the receipt chain."""
        result = self._run(_require_prompt(prompt))
        self.last_receipt = result.receipt
        return {"text": result.text, "receipt": result.receipt}

    def _run(self, prompt: str) -> _Result:
        checked = _require_prompt(prompt)
        if self._base_url:
            return self._call_http(checked)
        return self._call_subprocess(checked)

    def _call_subprocess(self, prompt: str) -> _Result:
        artifact = _require_subprocess_artifact(self._artifact_path)
        try:
            proc = subprocess.run(
                [self._bin, "run", artifact, "--json"],
                input=prompt,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self._timeout_s,
                check=False,
            )
        except FileNotFoundError as e:
            raise RuntimeError(f"kolm binary not found at {self._bin!r}") from e
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"kolm run timeout after {self._timeout_s}s") from e
        except OSError as e:
            detail = _truncate(_redact_secrets(e), MAX_ERROR_CHARS)
            raise RuntimeError(f"kolm run failed: {detail}") from e
        if proc.returncode != 0:
            stderr = _truncate(_redact_secrets(proc.stderr), MAX_STDERR_CHARS)
            raise RuntimeError(f"kolm run exited {proc.returncode}: {stderr}")
        return _parse_runtime_output(proc.stdout)

    def _call_http(self, prompt: str) -> _Result:
        assert self._base_url, "base_url required for HTTP mode"
        artifact = quote(_require_http_artifact(self._artifact_path or "default"), safe="")
        url = f"{self._base_url}/v1/run/{artifact}"
        payload = json.dumps({"prompt": prompt}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        req = _urllib_request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with _urllib_request.urlopen(req, timeout=self._timeout_s) as resp:
                body = _read_limited_body(resp)
        except HTTPError as e:
            detail = _read_http_error_detail(e, self._api_key)
            raise RuntimeError(f"kolm http {e.code}: {detail}") from e
        except URLError as e:
            detail = _truncate(_redact_secrets(getattr(e, "reason", e), self._api_key), MAX_ERROR_CHARS)
            raise RuntimeError(f"kolm http error: {detail}") from e
        try:
            obj = json.loads(body)
        except json.JSONDecodeError:
            return _Result(text=body, receipt=None)
        if not isinstance(obj, dict):
            return _Result(text="", receipt=None)
        text = obj.get("text") if isinstance(obj.get("text"), str) else obj.get("output", "")
        receipt = obj.get("receipt") or obj.get("audit")
        return _Result(text=text or "", receipt=receipt if isinstance(receipt, dict) else receipt)
