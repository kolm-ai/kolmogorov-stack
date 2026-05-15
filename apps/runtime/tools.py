"""
apps/runtime/tools.py

OpenAI-compatible tool / function calling, with model-native rendering and a
constrained-decode union schema fallback.

The OpenAI Chat Completions API accepts a `tools` field listing JSON-schema
function definitions; the model emits a `tool_calls` array with name + json
arguments. This module:

  1. Parses + validates a tools field.
  2. Renders it into the prompt in the format the target model expects
     (Qwen2.5, Llama 3.x, Hermes-2-Pro, generic JSON envelope).
  3. Builds a union JSON schema (one oneOf branch per tool plus an "answer"
     branch) that callers can feed to constrained.json_schema_processor to
     guarantee the model output parses.
  4. Parses the model's emission back into structured tool calls.

Why we re-implement this rather than rely on vLLM's built-in tool parsing:
  - vLLM's tool-parser registry varies per model; we need the same surface
    for all of them.
  - We want constrained decoding to back the call so the JSON always parses.
  - We need a deterministic envelope for receipt provenance.

Spec field on a kolm artifact:

    "serve": {
      "tools": {
        "format": "auto|qwen|llama|hermes|json_envelope",
        "tools": [ ... openai tool defs ... ],
        "tool_choice": "auto|required|none|{ \"type\":\"function\",\"function\":{\"name\":\"X\"}}",
        "parallel_tool_calls": false
      }
    }
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
import secrets
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


# ----- spec parsing -------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: Mapping[str, Any]  # JSON schema object

    @staticmethod
    def from_openai(tool: Mapping[str, Any]) -> "ToolSpec":
        if tool.get("type") != "function":
            raise ValueError(f"only 'function' tools supported, got type={tool.get('type')!r}")
        fn = tool.get("function") or {}
        name = fn.get("name")
        if not name or not isinstance(name, str):
            raise ValueError("tool.function.name is required and must be a string")
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$", name):
            raise ValueError(f"tool name {name!r} must match [A-Za-z_][A-Za-z0-9_]{{0,63}}")
        description = fn.get("description") or ""
        parameters = fn.get("parameters") or {"type": "object", "properties": {}}
        if not isinstance(parameters, Mapping):
            raise ValueError(f"tool.function.parameters must be an object, got {type(parameters).__name__}")
        return ToolSpec(name=name, description=str(description), parameters=dict(parameters))


def parse_tools_field(field: Any) -> list[ToolSpec]:
    if field is None:
        return []
    if isinstance(field, Mapping) and "tools" in field:
        field = field["tools"]
    if not isinstance(field, Sequence) or isinstance(field, (str, bytes)):
        raise ValueError("tools field must be a list of OpenAI-style tool definitions")
    out: list[ToolSpec] = []
    seen: set[str] = set()
    for i, raw in enumerate(field):
        if not isinstance(raw, Mapping):
            raise ValueError(f"tools[{i}] must be an object")
        spec = ToolSpec.from_openai(raw)
        if spec.name in seen:
            raise ValueError(f"duplicate tool name {spec.name!r}")
        seen.add(spec.name)
        out.append(spec)
    return out


# ----- union schema for constrained decoding ------------------------------


def union_schema(tools: Sequence[ToolSpec], *, allow_answer: bool = True) -> dict:
    """
    Build a JSON schema whose valid documents are either:
      { "tool": "NAME", "arguments": { ...matches tool's parameters... } }
    or, if allow_answer:
      { "answer": "<free-form string>" }

    Use this with constrained.json_schema_processor to guarantee the model
    emits a structurally valid envelope.
    """
    branches = []
    for t in tools:
        branches.append({
            "type": "object",
            "properties": {
                "tool": {"const": t.name},
                "arguments": t.parameters,
            },
            "required": ["tool", "arguments"],
            "additionalProperties": False,
        })
    if allow_answer:
        branches.append({
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        })
    if not branches:
        return {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}
    return {"oneOf": branches}


# ----- rendering into prompt formats --------------------------------------


def render_tool_prompt(tools: Sequence[ToolSpec], *, fmt: str = "auto", model_hint: Optional[str] = None) -> str:
    """
    Render the tool list into a string block that goes into the system /
    user prompt for the target model.

    fmt='auto' picks the format from model_hint substring match:
      - qwen      -> Qwen2.5 / Qwen3 <tool_call> XML
      - llama     -> Llama 3.1/3.2 <function=NAME>{...}</function>
      - hermes    -> Hermes-2-Pro <tool_call>...</tool_call> JSON
      - default   -> generic json_envelope: "respond with {\"tool\":...} or {\"answer\":...}"
    """
    if not tools:
        return ""
    fmt = (fmt or "auto").lower()
    if fmt == "auto":
        fmt = _autodetect_fmt(model_hint)

    if fmt == "qwen":
        return _render_qwen(tools)
    if fmt == "llama":
        return _render_llama(tools)
    if fmt == "hermes":
        return _render_hermes(tools)
    return _render_json_envelope(tools)


def _autodetect_fmt(model_hint: Optional[str]) -> str:
    h = (model_hint or "").lower()
    if "qwen" in h:
        return "qwen"
    if "llama" in h or "meta-llama" in h:
        return "llama"
    if "hermes" in h or "nous" in h:
        return "hermes"
    return "json_envelope"


def _render_json_envelope(tools: Sequence[ToolSpec]) -> str:
    lines = [
        "You can call one of the following tools, or answer directly.",
        "If you call a tool, respond with EXACTLY this JSON: {\"tool\": \"NAME\", \"arguments\": {...}}",
        "If you answer directly, respond with EXACTLY: {\"answer\": \"...\"}",
        "Do not emit any other text.",
        "",
        "Available tools:",
    ]
    for t in tools:
        lines.append(f"- {t.name}: {t.description}")
        lines.append(f"  parameters: {json.dumps(t.parameters, separators=(',', ':'))}")
    return "\n".join(lines)


def _render_qwen(tools: Sequence[ToolSpec]) -> str:
    """Qwen2.5 / Qwen3 tool_call format."""
    tool_lines = [
        "# Tools",
        "",
        "You may call one or more functions to assist with the user query.",
        "",
        "You are provided with function signatures within <tools></tools> XML tags:",
        "<tools>",
    ]
    for t in tools:
        tool_lines.append(json.dumps({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": dict(t.parameters),
            }
        }, separators=(",", ":")))
    tool_lines.append("</tools>")
    tool_lines.append("")
    tool_lines.append(
        "For each function call, return a json object with function name and arguments within "
        "<tool_call></tool_call> XML tags:"
    )
    tool_lines.append("<tool_call>")
    tool_lines.append('{"name": "<function-name>", "arguments": <args-json-object>}')
    tool_lines.append("</tool_call>")
    return "\n".join(tool_lines)


def _render_llama(tools: Sequence[ToolSpec]) -> str:
    """Llama 3.1/3.2 function-call format. The model emits
    <function=NAME>{json args}</function>."""
    lines = [
        "Environment: ipython",
        "Tools: " + ", ".join(t.name for t in tools),
        "",
        "When calling a tool, output: <function=NAME>{\"arg\": ...}</function>",
        "Available functions:",
    ]
    for t in tools:
        lines.append(json.dumps({
            "name": t.name,
            "description": t.description,
            "parameters": dict(t.parameters),
        }, separators=(",", ":")))
    return "\n".join(lines)


def _render_hermes(tools: Sequence[ToolSpec]) -> str:
    """Hermes-2-Pro tool_call format. Same as Qwen but slightly different system framing."""
    inner = "\n".join(
        json.dumps({"type": "function", "function": {
            "name": t.name, "description": t.description, "parameters": dict(t.parameters)
        }}, separators=(",", ":"))
        for t in tools
    )
    return (
        "You are a function calling AI model. You are provided with function signatures within "
        "<tools></tools> XML tags. You may call one or more functions to assist with the user "
        "query. Don't make assumptions about what values to plug into functions.\n"
        f"<tools>\n{inner}\n</tools>\n"
        "Use the following pydantic model json schema for each tool call you will make: "
        '{"properties": {"arguments": {"title": "Arguments", "type": "object"}, '
        '"name": {"title": "Name", "type": "string"}}, '
        '"required": ["arguments", "name"], "title": "FunctionCall", "type": "object"}\n'
        "For each function call return a json object with function name and arguments within "
        "<tool_call></tool_call> XML tags as follows:\n"
        "<tool_call>\n"
        '{"arguments": <args-dict>, "name": <function-name>}\n'
        "</tool_call>"
    )


# ----- parsing model outputs back into tool calls -------------------------


@dataclasses.dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: Mapping[str, Any]


@dataclasses.dataclass(frozen=True)
class ParsedResponse:
    answer: Optional[str]
    tool_calls: tuple[ToolCall, ...]
    raw: str

    @property
    def is_tool_call(self) -> bool:
        return bool(self.tool_calls)


def call_id() -> str:
    """OpenAI-shaped tool_call id: 'call_<24-hex>'."""
    return f"call_{secrets.token_hex(12)}"


def parse_envelope(text: str) -> ParsedResponse:
    """Parse a json_envelope-format reply: {"tool": ..., "arguments": ...}
    or {"answer": "..."}."""
    text = text.strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        # Try to recover the first balanced JSON object in the text.
        obj = _extract_first_json_object(text)
        if obj is None:
            return ParsedResponse(answer=text, tool_calls=(), raw=text)
    if not isinstance(obj, Mapping):
        return ParsedResponse(answer=text, tool_calls=(), raw=text)
    if "tool" in obj and isinstance(obj["tool"], str):
        args = obj.get("arguments") or {}
        if not isinstance(args, Mapping):
            args = {}
        return ParsedResponse(
            answer=None,
            tool_calls=(ToolCall(id=call_id(), name=obj["tool"], arguments=dict(args)),),
            raw=text,
        )
    if "answer" in obj and isinstance(obj["answer"], str):
        return ParsedResponse(answer=obj["answer"], tool_calls=(), raw=text)
    return ParsedResponse(answer=text, tool_calls=(), raw=text)


_QWEN_TOOL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)
_LLAMA_FN_RE = re.compile(r"<function=([A-Za-z_][A-Za-z0-9_]*)>(.*?)</function>", re.DOTALL)


def parse_native_tool_call(text: str, *, fmt: str) -> ParsedResponse:
    """Parse model-native tool-call syntax (qwen / llama / hermes)."""
    fmt = (fmt or "").lower()
    raw = text
    if fmt in ("qwen", "hermes"):
        calls: list[ToolCall] = []
        for m in _QWEN_TOOL_RE.finditer(text):
            try:
                obj = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            name = obj.get("name") or obj.get("function") or ""
            args = obj.get("arguments") or {}
            if isinstance(args, str):
                # Some Qwen tunes emit arguments as a stringified JSON.
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {"_raw": args}
            if name:
                calls.append(ToolCall(id=call_id(), name=name, arguments=dict(args)))
        if calls:
            # Anything outside the tool_call tags is residual prose; keep it as answer if present.
            residual = _QWEN_TOOL_RE.sub("", text).strip()
            return ParsedResponse(answer=residual or None, tool_calls=tuple(calls), raw=raw)
        return parse_envelope(text)

    if fmt == "llama":
        calls = []
        for m in _LLAMA_FN_RE.finditer(text):
            name = m.group(1)
            body = m.group(2).strip()
            try:
                args = json.loads(body) if body else {}
            except json.JSONDecodeError:
                args = {"_raw": body}
            calls.append(ToolCall(id=call_id(), name=name, arguments=dict(args)))
        if calls:
            residual = _LLAMA_FN_RE.sub("", text).strip()
            return ParsedResponse(answer=residual or None, tool_calls=tuple(calls), raw=raw)
        return parse_envelope(text)

    return parse_envelope(text)


def _extract_first_json_object(text: str) -> Optional[dict]:
    """Find the first balanced {...} in text and json.loads it. Returns None if nothing parses."""
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    blob = text[start : i + 1]
                    try:
                        return json.loads(blob)
                    except json.JSONDecodeError:
                        start = -1
    return None


# ----- tool_choice translation --------------------------------------------


def tool_choice_to_constraint(
    tool_choice: Any,
    tools: Sequence[ToolSpec],
) -> dict:
    """
    Translate an OpenAI-style tool_choice value into a union JSON schema that
    forces the right shape.

      "none"            -> answer-only schema
      "auto"            -> tools + answer
      "required"        -> tools only (no answer branch)
      {"type": "function", "function": {"name": "X"}}
                        -> exactly that tool, no answer
    """
    if tool_choice == "none":
        return {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        }
    if tool_choice == "auto" or tool_choice is None:
        return union_schema(tools, allow_answer=True)
    if tool_choice == "required":
        return union_schema(tools, allow_answer=False)
    if isinstance(tool_choice, Mapping):
        fn = (tool_choice.get("function") or {}).get("name")
        if fn:
            picked = [t for t in tools if t.name == fn]
            if not picked:
                raise ValueError(f"tool_choice refers to unknown tool {fn!r}")
            return union_schema(picked, allow_answer=False)
    raise ValueError(f"unrecognized tool_choice value: {tool_choice!r}")


# ----- receipt-friendly serialization -------------------------------------


def tool_calls_to_openai(calls: Iterable[ToolCall]) -> list[dict]:
    """Serialize ToolCall instances to OpenAI-shaped tool_calls list."""
    out = []
    for c in calls:
        out.append({
            "id": c.id,
            "type": "function",
            "function": {
                "name": c.name,
                "arguments": json.dumps(dict(c.arguments), separators=(",", ":")),
            },
        })
    return out


__all__ = [
    "ToolSpec",
    "ToolCall",
    "ParsedResponse",
    "parse_tools_field",
    "union_schema",
    "render_tool_prompt",
    "parse_envelope",
    "parse_native_tool_call",
    "tool_choice_to_constraint",
    "tool_calls_to_openai",
    "call_id",
]
