"""KolmLLM - LlamaIndex LLM that bridges to a kolm.ai compiled artifact.

Subprocess + HTTP transport. Mirrors ``kolm-langchain``. Surfaces the receipt
chain on ``self.last_receipt`` after every call.

The class extends ``llama_index.core.llms.LLM`` when installed; otherwise it
falls back to a minimal stand-in so the package can be imported and tested
without LlamaIndex.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from urllib import request as _urllib_request
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit


try:
    from llama_index.core.llms import LLM as _LlamaIndexLLM

    try:
        from pydantic import PrivateAttr as _PrivateAttr
    except Exception:  # pragma: no cover - depends on installed LlamaIndex stack
        _PrivateAttr = None  # type: ignore[assignment]

    _HAS_LLAMAINDEX = True
except Exception:  # pragma: no cover
    _HAS_LLAMAINDEX = False
    _PrivateAttr = None  # type: ignore[assignment]

    class _LlamaIndexLLM:  # type: ignore[no-redef]
        """Stand-in matching the LlamaIndex LLM surface this adapter exposes."""

        def __init__(self, **_: Any) -> None:
            pass


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
_SAFE_CHAT_ROLES = {"system", "user", "assistant", "tool"}


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


def _chat_message_part(message: Any) -> str:
    if isinstance(message, dict):
        raw_role = message.get("role", "user")
        raw_content = message.get("content", "")
    else:
        raw_role = getattr(message, "role", "user")
        raw_content = getattr(message, "content", message)
    role = str(raw_role or "user").strip().lower()
    if role not in _SAFE_CHAT_ROLES:
        role = "user"
    return f"{role.upper()}: {str(raw_content)}"


class KolmLLM(_LlamaIndexLLM):
    """LlamaIndex LLM backed by a ``.kolm`` artifact."""

    if _HAS_LLAMAINDEX and _PrivateAttr is not None:
        _artifact_path: Optional[str] = _PrivateAttr(default=None)
        _base_url: Optional[str] = _PrivateAttr(default=None)
        _api_key: Optional[str] = _PrivateAttr(default=None)
        _bin: str = _PrivateAttr(default=DEFAULT_KOLM_BIN)
        _timeout_s: float = _PrivateAttr(default=DEFAULT_TIMEOUT_S)
        _last_receipt: Optional[dict] = _PrivateAttr(default=None)
        _metadata: dict[str, Any] = _PrivateAttr(default_factory=dict)

    def __init__(
        self,
        artifact_path: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        bin_path: Optional[str] = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        context_window: int = 4096,
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
        try:
            checked_context = max(1, int(context_window))
        except (TypeError, ValueError):
            checked_context = 4096
        self._metadata = {
            "model_name": "kolm-artifact",
            "context_window": checked_context,
            "is_chat_model": False,
        }

    @property
    def last_receipt(self) -> Optional[dict]:
        return self._last_receipt

    @last_receipt.setter
    def last_receipt(self, value: Optional[dict]) -> None:
        self._last_receipt = value

    @property
    def metadata(self) -> dict[str, Any]:
        return self._metadata

    # LlamaIndex LLM contract: completion entry point.
    def complete(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        result = self._run(_require_prompt(prompt))
        self.last_receipt = result.receipt
        return {
            "text": result.text,
            "raw": {"receipt": result.receipt} if result.receipt else None,
        }

    # LlamaIndex LLM contract: chat entry point.
    def chat(self, messages: Iterable[Any], **kwargs: Any) -> dict[str, Any]:
        parts = [_chat_message_part(message) for message in messages]
        prompt = _require_prompt("\n\n".join(parts))
        result = self._run(prompt)
        self.last_receipt = result.receipt
        return {
            "message": {"role": "assistant", "content": result.text},
            "raw": {"receipt": result.receipt} if result.receipt else None,
        }

    def invoke_with_receipt(self, prompt: str) -> dict[str, Any]:
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
