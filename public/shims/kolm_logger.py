"""kolm Evidence-Grade Logging Shim (Python 3, standard library only).

Drop this into any agent runtime to record each action as a tamper-evident,
hash-chained AuditEvent. The output of .to_jsonl() is ingested DIRECTLY by
kolm's runAudit(): a vendor export carrying an intact hash chain lifts your
evidence grade from tier C (asserted) to tier B (hash-verified). No network
calls, no kolm account needed to produce the log - you self-lift.

What tier B requires, and what this shim guarantees:
  - every record carries a chain `hash`
  - every record after the first carries a `prev_hash` referencing the
    previous record's `hash` (the genesis record has no prev_hash)
  - identity (key_id + agent) and a usable timestamp on every record
kolm's audit-trail analyzer verifies the chain order-independently: a link is
intact when its prev_hash references a hash present in the trail. Keep the
records together (any order) and the chain verifies.

Caveats: this shim records what your code tells it. It does not intercept
traffic, so it evidences the calls you log, not calls you forget to log. kolm
maps these records to standards and reports what the chain shows; it does not
certify behaviour the log never exercised.
"""

import hashlib
import json
import re
from datetime import datetime, timezone

# Field keys inside tool-call arguments that name an egress destination. kolm's
# ingest reads these to turn a generic "called a tool" into a data-egress
# signal, so naming the destination here makes the egress dimension testable.
_HOST_ARG_KEYS = ["url", "endpoint", "uri", "host", "hostname", "base_url", "to", "recipient", "webhook"]
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*://([^/?#]+)", re.IGNORECASE)


def _canonical(value):
    """Deterministic JSON: keys sorted, compact separators, so the hash is stable."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256_hex(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _iso_ts(ts):
    if ts is None:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(ts, datetime):
        return ts.isoformat()
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return str(ts)


def _dest_from_args(args):
    if not isinstance(args, dict):
        return None
    for k in _HOST_ARG_KEYS:
        v = args.get(k)
        if isinstance(v, str) and v.strip() != "":
            m = _SCHEME_RE.match(v)
            return (m.group(1) if m else v).strip().lower()
    return None


class KolmLogger:
    """A logger bound to one agent identity.

    Args:
        key_id: per-agent credential / API-key id (required for attribution;
                tier B needs identity on every event).
        agent:  human-readable agent / service name.
        grants: scopes this agent's credential holds, e.g.
                ["tool:lookup_policy", "tool:send_email"].
        model:  model slug recorded on each action (optional).
    """

    def __init__(self, key_id=None, agent=None, grants=None, model=None):
        self.key_id = str(key_id) if key_id is not None else None
        self.agent = str(agent) if agent is not None else None
        self.grants = [str(g) for g in grants] if isinstance(grants, (list, tuple)) else None
        self.model = str(model) if model is not None else None
        self._records = []
        self._prev_hash = None  # None on the genesis record

    def record(self, tool, args=None, host=None, ts=None, grants=None,
               has_sensitive=False, redacted=False):
        """Record one agent action. Returns the record's chain hash.

        Args:
            tool: tool / function name invoked (required).
            args: tool arguments dict (scanned for an egress host).
            host: explicit egress host (overrides args).
            ts:   timestamp - ISO string, epoch ms int, or datetime (defaults to now).
            grants: per-call grant override (defaults to constructor grants).
            has_sensitive: sensitive content present in the call.
            redacted: redaction applied before egress.
        """
        tool = str(tool) if tool is not None else None
        if isinstance(args, dict):
            arg_obj = args
        elif args is not None:
            arg_obj = {"value": args}
        else:
            arg_obj = {}
        dest = str(host) if host is not None else _dest_from_args(arg_obj)
        iso = _iso_ts(ts)
        call_grants = [str(g) for g in grants] if isinstance(grants, (list, tuple)) else self.grants

        # The OpenAI-chat record shape kolm's ingest absorbs. Grants live on
        # request.tools (what the agent MAY call); the actual call lives on
        # response.choices[].message.tool_calls (what it DID).
        if call_grants:
            tool_defs = [{"type": "function", "function": {"name": re.sub(r"^tool:", "", g, flags=re.IGNORECASE)}}
                         for g in call_grants]
        elif tool:
            tool_defs = [{"type": "function", "function": {"name": tool}}]
        else:
            tool_defs = []

        idx = len(self._records)
        request_id = "kl_%d_%s" % (
            idx,
            _sha256_hex(iso + "|" + (tool or "") + "|" + _canonical(arg_obj))[:12],
        )

        record = {
            "request_id": request_id,
            "timestamp": iso,
            "key_id": self.key_id,
            "user": self.agent,
            "model": self.model,
            "request": {"model": self.model, "tools": tool_defs, "messages": []},
            "prev_hash": self._prev_hash,
        }

        if tool:
            call_args = dict(arg_obj)
            if dest is not None:
                call_args["host"] = dest
            record["response"] = {
                "model": self.model,
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_%d" % idx,
                            "type": "function",
                            "function": {"name": tool, "arguments": _canonical(call_args)},
                        }],
                    },
                }],
            }

        if has_sensitive:
            record["has_sensitive"] = True
        if redacted:
            record["redacted"] = True

        # The chain link: hash this record's stable content, point prev_hash at
        # the previous link. kolm verifies the link by presence in the trail.
        link_hash = _sha256_hex(_canonical({
            "request_id": record["request_id"],
            "timestamp": record["timestamp"],
            "key_id": record["key_id"],
            "user": record["user"],
            "tool": tool,
            "args": arg_obj,
            "host": dest,
            "prev_hash": record["prev_hash"],
        }))
        record["hash"] = link_hash
        self._prev_hash = link_hash
        self._records.append(record)
        return link_hash

    def records(self):
        """All records captured so far (defensive copy)."""
        return [dict(r) for r in self._records]

    def to_jsonl(self):
        """Newline-delimited records - feed DIRECTLY to runAudit()."""
        return "\n".join(json.dumps(r, sort_keys=True, separators=(",", ":")) for r in self._records)


def create_logger(key_id=None, agent=None, grants=None, model=None):
    """Factory form: create_logger(key_id=..., agent=..., grants=[...])."""
    return KolmLogger(key_id=key_id, agent=agent, grants=grants, model=model)
