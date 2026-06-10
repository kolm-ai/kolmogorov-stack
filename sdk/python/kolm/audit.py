"""Agent Security-Review audit client + offline evidence-report verifier.

This module is the Python surface for kolm.ai's *Agent Security-Review* product:
a vendor uploads agent logs (JSONL) and receives an Ed25519-signed, offline-
verifiable evidence report mapped to SOC 2 / ISO 42001 / NIST AI RMF / EU AI Act /
OWASP / MITRE.

Two halves live here:

  * :class:`AuditClient` - a thin, typed HTTP wrapper over the audit API
    (``scan`` / ``reports`` / ``buy_report`` / ``subscribe`` / ``trust``). It
    speaks the same dialect as :class:`kolm.client.Kolm`: stdlib ``urllib``,
    ``Bearer`` auth, per-request timeouts, and :class:`kolm.client.KolmError`
    raised verbatim on any non-2xx response.

  * :func:`verify_report` - THE CROWN JEWEL. It reproduces the Node/browser
    canonicalization (``src/attestation-report-builder.js`` /
    ``public/kolm-audit-verify.js``) **byte-for-byte in pure Python**, verifies
    the Ed25519 signature **fully offline** with the `cryptography` library
    (no kolm server, no account, no shared secret), then checks issuer
    provenance against a bundled copy of ``kolm-issuers.json``. A buyer can
    confirm a kolm report was signed by the holder of the embedded key and has
    not been altered since - in three lines of Python, on an air-gapped box.

Canonicalization contract (MUST stay byte-identical to the Node + browser
implementations):

  * Recursive, key-sorted, whitespace-free JSON.
  * ``null`` -> ``null``; booleans -> ``true`` / ``false``.
  * Numbers via ECMAScript ``Number::toString`` (the algorithm ``JSON.stringify``
    uses), reproduced in :func:`_js_number_to_string`. Integer-valued floats lose
    their decimal point (``5.0`` -> ``5``), exponents drop their leading zero
    (``1e-7`` not ``1e-07``), matching V8.
  * Strings via ``json.dumps(s, ensure_ascii=False)`` - identical to
    ``JSON.stringify`` for every BMP string (raw non-ASCII, ``/`` unescaped,
    control chars as ``\\uXXXX`` / ``\\n`` / ``\\t`` ...).
  * Object keys sorted by Unicode code point. The audit-report schema keys are
    all ASCII, for which code-point order equals the UTF-16 code-unit order V8
    sorts by; the two diverge only for astral-plane (surrogate-pair) keys, which
    a well-formed report never carries.
  * The ``signature_ed25519`` block is excluded (a signature cannot cover
    itself). Ed25519 signs the UTF-8 bytes of the canonical string.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from .client import KolmError

# The `cryptography` library is a hard dependency for offline verification (see
# pyproject.toml). Import is guarded so the HTTP surface (scan/reports/...) still
# works in an environment that, for whatever reason, lacks it - in that case
# verify_report() returns a non-throwing ok=False with an explicit reason rather
# than blowing up, mirroring how the browser verifier degrades when a runtime
# lacks native Ed25519 (it says so plainly instead of faking a pass).
try:  # pragma: no cover - exercised by the dependency being present/absent
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    _CRYPTOGRAPHY_AVAILABLE = True
    _CRYPTOGRAPHY_IMPORT_ERROR = ""
except Exception as _e:  # pragma: no cover - only when cryptography is missing
    _CRYPTOGRAPHY_AVAILABLE = False
    _CRYPTOGRAPHY_IMPORT_ERROR = str(_e)
    InvalidSignature = Exception  # type: ignore[assignment,misc]
    serialization = None  # type: ignore[assignment]
    Ed25519PublicKey = None  # type: ignore[assignment,misc]


# Schema / spec markers - mirror src/attestation-report-builder.js +
# public/kolm-audit-verify.js. A report whose `schema` is set MUST equal
# AUDIT_REPORT_SCHEMA, and its signature block MUST use ED25519_SPEC / ED25519_ALG.
AUDIT_REPORT_SCHEMA = "kolm-audit-report-1"
AUDIT_REPORT_VERSION = "asr-report/0.1"
ED25519_SPEC = "kolm-ed25519-v1"
ED25519_ALG = "ed25519"

DEFAULT_BASE = os.environ.get("KOLM_BASE", "https://kolm.ai")

# Bundled copy of public/keys/kolm-issuers.json. Shipping it inside the wheel is
# what makes tier-2 (issuer provenance) work with zero network: the verifier can
# answer "is this embedded key one kolm publishes?" entirely offline.
_BUNDLED_KEYRING_PATH = Path(__file__).resolve().parent / "kolm-issuers.json"

__all__ = [
    "AUDIT_REPORT_SCHEMA",
    "AUDIT_REPORT_VERSION",
    "ED25519_SPEC",
    "ED25519_ALG",
    "AuditClient",
    "ScanResult",
    "ReportSummary",
    "Checkout",
    "IssuerMatch",
    "VerifyResult",
    "canonicalize",
    "canonicalize_report",
    "key_fingerprint_from_pem",
    "issuer_provenance",
    "load_keyring",
    "default_keyring",
    "verify_report",
]


# ===========================================================================
# Canonicalization - byte-identical to the Node + browser implementations.
# ===========================================================================
def _js_number_to_string(value: Union[int, float]) -> str:
    """Serialize a number exactly as JavaScript's ``JSON.stringify`` would.

    Reproduces the ECMAScript ``Number::toString`` algorithm (ECMA-262, the one
    ``JSON.stringify`` delegates to for finite numbers):

      * Python ``int`` -> base-10 string. JavaScript holds JSON integers as
        IEEE-754 doubles and prints integers exactly up to 2**53; real audit
        reports carry only small counts/percentages, so ``str(int)`` is exact.
      * Non-finite floats (``nan`` / ``inf``) -> ``"null"`` (matches
        ``canonicalize``'s ``Number.isFinite ? ... : 'null'``).
      * Finite floats -> shortest round-trip digits (Python's ``repr`` and V8
        both emit the shortest representation), reformatted per ECMA-262: an
        integer-valued float drops its decimal point, the exponent has no
        leading zero, very large/small magnitudes use exponential form at the
        same thresholds V8 uses.
    """
    # bool is an int subclass - callers handle it before reaching here, but guard
    # so a stray bool never serializes as "1"/"0".
    if isinstance(value, bool):  # pragma: no cover - defensive
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)

    # float from here on.
    if value != value:  # NaN
        return "null"
    if value in (float("inf"), float("-inf")):
        return "null"
    if value == 0:
        # JS prints both 0 and -0 as "0".
        return "0"

    negative = value < 0.0
    av = -value if negative else value

    # Decimal(repr(av)) preserves the shortest round-trip digits Python's repr
    # produced, without re-introducing binary->decimal noise. as_tuple() then
    # gives us the exact (digits, exponent) we need for the ECMA branches.
    from decimal import Decimal

    digits_tuple, exp = Decimal(repr(av)).as_tuple()[1:]
    digits = list(digits_tuple)
    # Strip trailing zeros to obtain the minimal significant-digit string `s` and
    # its exponent (so value == int(s) * 10**exp, with no trailing zero in s).
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    s = "".join(str(d) for d in digits)
    k = len(s)            # number of significant digits
    n = exp + k           # position of the decimal point (ECMA-262 `n`)

    if k <= n <= 21:
        out = s + "0" * (n - k)
    elif 0 < n <= 21:
        out = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + s
    else:
        # Exponential form. Exponent magnitude printed with no leading zeros,
        # signed '+' / '-' - exactly JS ("1e+21", "1e-7").
        e = n - 1
        mantissa = s if k == 1 else s[0] + "." + s[1:]
        out = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"

    return "-" + out if negative else out


def canonicalize(value: Any) -> str:
    """Canonical JSON for one value - byte-identical to the Node ``canonicalize``.

    Recursive, key-sorted, whitespace-free. ``None`` -> ``null``; ``dict`` keys
    are sorted; ``list`` order is preserved. See the module docstring for the
    full contract.
    """
    if value is None:
        return "null"
    # bool MUST be checked before int (bool is an int subclass in Python).
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number_to_string(value)
    if isinstance(value, str):
        # json.dumps(..., ensure_ascii=False) == JSON.stringify for any BMP
        # string: raw non-ASCII, '/' left unescaped, control chars escaped the
        # same way (\b \t \n \f \r, else \uXXXX lowercase).
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, Mapping):
        # Keys are coerced to strings (JS object keys are always strings - it
        # does String(key)) and sorted by Unicode code point; values that are
        # None are KEPT (JS keeps null, drops only `undefined`, which Python has
        # no analog of). Sort on the stringified key while preserving the
        # original key for lookup, so a non-string key never raises here.
        items = sorted(((str(k), k) for k in value.keys()), key=lambda kv: kv[0])
        return (
            "{"
            + ",".join(
                json.dumps(sk, ensure_ascii=False) + ":" + canonicalize(value[ok])
                for sk, ok in items
            )
            + "}"
        )
    # Anything else (e.g. a stray object) is not part of a well-formed envelope.
    return "null"


# The four envelope keys the Ed25519 signature does NOT cover, excluded byte-for-
# byte in lockstep with canonicalizeReport() in src/attestation-report-builder.js
# and public/kolm-audit-verify.js:
#   - signature_ed25519: a signature cannot sign itself.
#   - timestamp_evidence + log_checkpoint: detached evidence (RFC 3161 TSA /
#     append-only witness) attached AFTER signing; each references the signed
#     digest, so it binds to the report without being covered by the signature.
#   - co_signatures: named-reviewer Ed25519 blocks added AFTER the primary
#     signature, each over THIS same canonical payload.
# Excluding only signature_ed25519 made every real report (the builder always
# attaches log_checkpoint) fail Python verification while Node/browser passed.
_DETACHED_REPORT_FIELDS = (
    "signature_ed25519",
    "timestamp_evidence",
    "log_checkpoint",
    "co_signatures",
)


def canonicalize_report(envelope: Mapping[str, Any]) -> str:
    """Canonical bytes-as-string the Ed25519 signature covers.

    The four detached fields (``signature_ed25519`` plus the post-signing
    ``timestamp_evidence``, ``log_checkpoint``, and ``co_signatures`` blocks) are
    excluded, matching
    ``const { signature_ed25519, timestamp_evidence, log_checkpoint, co_signatures, ...rest } = envelope``
    on the Node and browser sides.
    """
    if not isinstance(envelope, Mapping):
        raise TypeError("canonicalize_report: envelope must be a mapping/object")
    rest = {k: v for k, v in envelope.items() if k not in _DETACHED_REPORT_FIELDS}
    return canonicalize(rest)


# ===========================================================================
# Key fingerprint + issuer provenance.
# ===========================================================================
def _pem_to_der(pem: str) -> bytes:
    """Strip PEM armor + whitespace and base64-decode the SPKI body."""
    if not isinstance(pem, str):
        raise ValueError("public_key must be a PEM string")
    body = []
    for line in pem.splitlines():
        s = line.strip()
        if not s or s.startswith("-----"):
            continue
        body.append(s)
    b64 = "".join(body)
    if not b64:
        raise ValueError("no key body found in PEM")
    return base64.b64decode(b64)


def key_fingerprint_from_pem(public_key_pem: str) -> str:
    """SHA-256 over the SPKI DER bytes, first 32 hex chars (128-bit).

    Byte-identical to ``src/ed25519.js`` ``keyFingerprint()`` and the browser
    ``keyFingerprintFromPem()``: hash the raw DER (not the PEM text), so
    whitespace / line-ending variants of the same key share a fingerprint.
    Prefers `cryptography` (canonical re-encode of the SPKI) and falls back to
    hashing the decoded PEM body directly when the library is absent.
    """
    if _CRYPTOGRAPHY_AVAILABLE:
        pub = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
        der = pub.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    else:  # pragma: no cover - only without cryptography
        der = _pem_to_der(public_key_pem)
    return hashlib.sha256(der).hexdigest()[:32]


def _normalize_pem(pem: Any) -> str:
    """Whitespace-insensitive PEM identity (line endings must not change it)."""
    return "".join(str("" if pem is None else pem).split())


@dataclass
class IssuerMatch:
    """Outcome of a tier-2 issuer-provenance lookup.

    ``recognized`` is True when the report's embedded signing key matches an
    issuer in the keyring. ``status`` distinguishes a ``"production"`` evidence
    signer from a ``"demo"`` key (the public sample report is signed by the demo
    key) - a consumer that requires production-issued evidence should assert
    ``status == "production"``.
    """

    recognized: bool
    kid: Optional[str] = None
    label: Optional[str] = None
    status: Optional[str] = None
    embedded_key: Optional[str] = None


def load_keyring(
    keyring: Union[None, str, os.PathLike, Mapping[str, Any], Sequence[Mapping[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Normalize a keyring argument into a list of issuer dicts.

    Accepts: ``None`` (the bundled ``kolm-issuers.json``); a path to a JSON file
    (``{"issuers": [...]}`` or a bare ``[...]``); a mapping with an ``issuers``
    list; or a bare sequence of issuer dicts. Each issuer must carry a
    ``public_key`` PEM string; malformed entries are dropped.
    """
    if keyring is None:
        return default_keyring()
    if isinstance(keyring, (str, os.PathLike)):
        with open(keyring, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        return _issuers_from(data)
    if isinstance(keyring, Mapping):
        return _issuers_from(keyring)
    if isinstance(keyring, Sequence):
        return _issuers_from(list(keyring))
    raise TypeError("keyring must be None, a path, a mapping, or a sequence of issuers")


def _issuers_from(data: Any) -> List[Dict[str, Any]]:
    raw = data.get("issuers") if isinstance(data, Mapping) else data
    if not isinstance(raw, list):
        return []
    return [i for i in raw if isinstance(i, Mapping) and isinstance(i.get("public_key"), str)]


def default_keyring() -> List[Dict[str, Any]]:
    """The issuer list bundled with the SDK (offline tier-2 provenance source)."""
    try:
        with open(_BUNDLED_KEYRING_PATH, "r", encoding="utf-8") as fp:
            return _issuers_from(json.load(fp))
    except Exception:
        return []


def issuer_provenance(
    report: Mapping[str, Any],
    keyring: Union[None, str, os.PathLike, Mapping[str, Any], Sequence[Mapping[str, Any]]] = None,
) -> IssuerMatch:
    """Does the report's embedded signing key belong to a known kolm issuer?

    Pure, synchronous PEM comparison - never throws. This is tier-2 of the trust
    model: tier-1 proves "signed by the holder of the embedded key, untampered";
    tier-2 proves "and that key is one kolm publishes". Without it, a forger
    could re-sign an edited report with their OWN key and pass tier-1 alone.
    """
    try:
        block = report.get("signature_ed25519") if isinstance(report, Mapping) else None
        pem = block.get("public_key") if isinstance(block, Mapping) else None
        if not isinstance(pem, str) or not pem:
            return IssuerMatch(recognized=False)
        target = _normalize_pem(pem)
        for iss in load_keyring(keyring):
            if _normalize_pem(iss.get("public_key")) == target:
                return IssuerMatch(
                    recognized=True,
                    kid=iss.get("kid"),
                    label=iss.get("label"),
                    status=iss.get("status"),
                    embedded_key=pem,
                )
        return IssuerMatch(recognized=False, embedded_key=pem)
    except Exception:  # pragma: no cover - never throw across the verify boundary
        return IssuerMatch(recognized=False)


# ===========================================================================
# verify_report - the crown jewel. Offline, two-tier, never throws.
# ===========================================================================
@dataclass
class VerifyResult:
    """Verdict of :func:`verify_report`.

    Fields:
        ok: tier-1 AND tier-2 - the "trusted" verdict. A report is trusted when
            its signature checks out *and* the signing key is a recognized kolm
            issuer. A consumer that only checks ``tier1_signature`` would accept
            a forgery re-signed with a rogue key; check ``ok``.
        tier1_signature: the Ed25519 signature verifies against the canonical
            payload and the report is internally consistent (schema, fingerprint,
            ``signed_at`` vs ``generated_at``) - "signed by the holder of the
            embedded key, untampered since".
        tier2_issuer: the embedded public key matches an issuer in the keyring.
        key_fingerprint: the fingerprint independently recomputed from the
            embedded ``public_key`` bytes (``None`` if the key could not be read).
        reason: ``None`` on full success; otherwise the first failure, in plain
            terms.
        issuer: tier-2 details (kid / label / status) when an issuer matched.
        checks: an ordered human-readable trace of each step (for diagnostics).
    """

    ok: bool
    tier1_signature: bool
    tier2_issuer: bool
    key_fingerprint: Optional[str] = None
    reason: Optional[str] = None
    issuer: Optional[IssuerMatch] = None
    checks: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Plain-dict view (the ``{ok, tier1_signature, tier2_issuer, ...}`` shape)."""
        return {
            "ok": self.ok,
            "tier1_signature": self.tier1_signature,
            "tier2_issuer": self.tier2_issuer,
            "key_fingerprint": self.key_fingerprint,
            "reason": self.reason,
            "issuer": (
                None
                if self.issuer is None
                else {
                    "recognized": self.issuer.recognized,
                    "kid": self.issuer.kid,
                    "label": self.issuer.label,
                    "status": self.issuer.status,
                }
            ),
            "checks": list(self.checks),
        }


def _b64url_decode(s: str) -> bytes:
    """Decode an unpadded base64url string (Node's ``Buffer.toString('base64url')``)."""
    t = str(s).replace("-", "+").replace("_", "/")
    t += "=" * (-len(t) % 4)
    return base64.b64decode(t)


def verify_report(
    envelope: Union[str, Mapping[str, Any]],
    keyring: Union[None, str, os.PathLike, Mapping[str, Any], Sequence[Mapping[str, Any]]] = None,
) -> VerifyResult:
    """Verify a signed audit report **fully offline**. Never raises.

    Reproduces the exact bytes the report was signed over (:func:`canonicalize_report`,
    byte-identical to the Node signer + browser verifier), checks the Ed25519
    signature with `cryptography` (no server, no account), then checks issuer
    provenance against ``keyring`` (default: the bundled ``kolm-issuers.json``).

    Args:
        envelope: the signed report - a parsed object (mapping) or a JSON string.
        keyring: tier-2 issuer source. ``None`` uses the bundled keyring; or pass
            a path, a ``{"issuers": [...]}`` mapping, or a list of issuer dicts.

    Returns:
        :class:`VerifyResult` with ``ok = tier1_signature and tier2_issuer``.

    Example::

        from kolm.audit import verify_report
        import json

        # Always read the report as UTF-8: the signed canonical may contain
        # non-ASCII, and a platform-default encoding (e.g. cp1252 on Windows)
        # would corrupt those bytes and fail tier-1 verification.
        with open("agent-security-report.json", encoding="utf-8") as fp:
            report = json.load(fp)
        result = verify_report(report)
        if result.ok:
            print("trusted kolm evidence:", result.issuer.status, result.key_fingerprint)
        else:
            print("NOT trusted:", result.reason)
    """
    checks: List[str] = []

    def fail(reason: str, *, tier1: bool = False, fp: Optional[str] = None) -> VerifyResult:
        return VerifyResult(
            ok=False, tier1_signature=tier1, tier2_issuer=False,
            key_fingerprint=fp, reason=reason, checks=checks,
        )

    # Accept a JSON string for convenience (the buyer often has a file's text).
    if isinstance(envelope, str):
        try:
            envelope = json.loads(envelope)
        except Exception as e:
            return fail(f"input is not valid JSON: {e}")
    if not isinstance(envelope, Mapping):
        return fail("report must be a JSON object")

    schema = envelope.get("schema")
    if schema is not None and schema != AUDIT_REPORT_SCHEMA:
        return fail(f"unexpected schema: {schema} (expected {AUDIT_REPORT_SCHEMA})")
    checks.append(f"schema ok: {schema or '(none)'}")

    block = envelope.get("signature_ed25519")
    if not isinstance(block, Mapping):
        return fail("report has no signature_ed25519 block")
    checks.append(f"signature block present (alg={block.get('alg')} spec={block.get('spec')})")

    spec = block.get("spec")
    if spec is not None and spec != ED25519_SPEC:
        return fail(f"unexpected signature spec: {spec}")
    alg = block.get("alg")
    if alg is not None and alg != ED25519_ALG:
        return fail(f"unexpected signature alg: {alg}")

    public_key = block.get("public_key")
    if not isinstance(public_key, str) or not public_key:
        return fail("signature block missing public_key")
    signature = block.get("signature")
    if not isinstance(signature, str) or not signature:
        return fail("signature block missing signature")

    if not _CRYPTOGRAPHY_AVAILABLE:
        # Mirror the browser verifier: when the crypto primitive is unavailable,
        # say so plainly rather than fake a pass. The signature was NOT checked.
        return fail(
            "cryptography library unavailable; signature was NOT checked "
            f"(pip install cryptography). underlying: {_CRYPTOGRAPHY_IMPORT_ERROR}"
        )

    # 1. Rebuild the exact signed bytes.
    try:
        canonical = canonicalize_report(envelope)
    except Exception as e:
        return fail(f"cannot canonicalize report: {e}")
    canonical_bytes = canonical.encode("utf-8")
    checks.append(f"canonical payload rebuilt: {len(canonical_bytes)} bytes")

    # 2. Independently recompute the fingerprint and load the key.
    try:
        pub = serialization.load_pem_public_key(public_key.encode("utf-8"))
    except Exception as e:
        return fail(f"cannot read public_key: {e}")
    if not isinstance(pub, Ed25519PublicKey):
        return fail("embedded public_key is not an Ed25519 key")
    try:
        fp = key_fingerprint_from_pem(public_key)
    except Exception as e:
        return fail(f"cannot derive key fingerprint: {e}")

    claimed_fp = block.get("key_fingerprint")
    if claimed_fp is not None and str(claimed_fp) != fp:
        return fail(
            f"key_fingerprint claim ({str(claimed_fp)[:12]}...) does not match "
            f"public_key bytes ({fp[:12]}...)",
            fp=fp,
        )
    checks.append(f"key fingerprint matches public_key: {fp}")

    # 3. The real Ed25519 verification.
    try:
        sig_bytes = _b64url_decode(signature)
    except Exception as e:
        return fail(f"cannot decode signature: {e}", fp=fp)
    try:
        pub.verify(sig_bytes, canonical_bytes)
    except InvalidSignature:
        return fail("Ed25519 signature does not verify against the canonical payload", fp=fp)
    except Exception as e:
        return fail(f"Ed25519 verification raised: {e}", fp=fp)
    checks.append("Ed25519 signature valid")

    # 4. signed_at consistency. block.signed_at is NOT covered by the signature
    # (it lives in the excluded block); generated_at IS. signReport sets them
    # equal, so a mismatch means the displayed timestamp was edited after signing.
    block_signed_at = block.get("signed_at")
    generated_at = envelope.get("generated_at")
    if (
        block_signed_at is not None
        and generated_at is not None
        and str(block_signed_at) != str(generated_at)
    ):
        return fail(
            "signed_at does not match the signed generated_at "
            "(timestamp altered after signing)",
            tier1=False,
            fp=fp,
        )
    checks.append(f"signed_at matches signed generated_at: {generated_at}")

    # Tier 1 fully established.
    tier1 = True

    # 5. Tier 2 - issuer provenance against the keyring.
    issuer = issuer_provenance(envelope, keyring)
    if issuer.recognized:
        checks.append(
            f"issuer recognized: kid={issuer.kid} status={issuer.status}"
        )
    else:
        checks.append("issuer NOT recognized in keyring")

    ok = tier1 and issuer.recognized
    reason = None
    if not ok:
        reason = (
            "signature is valid but the signing key is not a recognized kolm "
            "issuer (tier-2 provenance failed); a tampered report can be re-signed "
            "with a rogue key - require a recognized issuer before trusting"
        )
    return VerifyResult(
        ok=ok,
        tier1_signature=tier1,
        tier2_issuer=issuer.recognized,
        key_fingerprint=fp,
        reason=reason,
        issuer=issuer,
        checks=checks,
    )


# ===========================================================================
# AuditClient - typed HTTP wrapper over the audit API.
# ===========================================================================
@dataclass
class ScanResult:
    """Result of :meth:`AuditClient.scan` - a one-shot signed evidence report."""

    id: Optional[str]
    report_id: Optional[str]
    signed: bool
    key_fingerprint: Optional[str]
    summary: Dict[str, Any]
    report: Optional[Dict[str, Any]]
    verify_url: Optional[str]
    raw: Dict[str, Any]

    def verify(self, keyring: Any = None) -> VerifyResult:
        """Verify this scan's embedded signed report offline (the crown jewel)."""
        if not self.report:
            return VerifyResult(
                ok=False, tier1_signature=False, tier2_issuer=False,
                reason="scan returned no signed report (sign=False or no signer configured)",
            )
        return verify_report(self.report, keyring)


@dataclass
class ReportSummary:
    """One row of :meth:`AuditClient.reports` - a report this tenant owns."""

    id: str
    report_id: Optional[str]
    subject: Optional[str]
    readiness_pct: Optional[float]
    blocking_count: Optional[int]
    tier: Optional[str]
    paid: bool
    public_slug: Optional[str]
    trust_url: Optional[str]
    source: Optional[str]
    created_at: Optional[str]
    raw: Dict[str, Any]


@dataclass
class Checkout:
    """A checkout link from :meth:`AuditClient.buy_report` / :meth:`subscribe`."""

    url: Optional[str]
    source: Optional[str]
    already_paid: bool
    trust_url: Optional[str]
    raw: Dict[str, Any]


class AuditClient:
    """Typed HTTP client for the kolm Agent Security-Review audit API.

    Args:
        api_key: Bearer token (``ks_...``). Required for the authed surface
            (``scan`` / ``reports`` / ``buy_report`` / ``subscribe``); falls back
            to ``KOLM_API_KEY`` / ``KOLM_KEY`` env vars. The public surface
            (``trust`` / :meth:`verify_online`) needs no key.
        base: API base URL. Defaults to ``https://kolm.ai`` (or ``KOLM_BASE``).
        timeout: per-request timeout in seconds (default 60).

    Non-2xx responses raise :class:`kolm.client.KolmError` verbatim - the SDK
    never sugars away an upstream error.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base: str = DEFAULT_BASE,
        timeout: float = 60.0,
    ) -> None:
        self.api_key = (
            api_key
            or os.environ.get("KOLM_API_KEY")
            or os.environ.get("KOLM_KEY")
        )
        self.base = base.rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Low-level HTTP
    # ------------------------------------------------------------------
    def _require_api_key(self, op: str) -> str:
        if not self.api_key:
            raise KolmError(401, f"missing api key for {op} (pass api_key= or set KOLM_API_KEY env)")
        return self.api_key

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Any] = None,
        *,
        params: Optional[Mapping[str, Any]] = None,
        auth: bool = True,
        expect: str = "json",
    ) -> Any:
        url = self.base + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method.upper())
        req.add_header("Accept", "application/json" if expect == "json" else "*/*")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if auth:
            req.add_header("Authorization", f"Bearer {self._require_api_key(f'{method} {path}')}")
        elif self.api_key:
            # Harmless on public routes; lets the server attribute the call.
            req.add_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read()
                if expect == "bytes":
                    return payload
                text = payload.decode("utf-8") if payload else ""
                if expect == "text":
                    return text
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed: Any = json.loads(raw)
            except Exception:
                parsed = raw
            raise KolmError(e.code, parsed) from None
        except urllib.error.URLError as e:
            raise KolmError(0, {"error": f"network error: {e.reason}"}) from None

    # ------------------------------------------------------------------
    # Audit surface
    # ------------------------------------------------------------------
    def scan(
        self,
        logs: Union[str, Sequence[Any], Mapping[str, Any]],
        subject: str = "Agent fleet",
        *,
        source: Optional[str] = None,
        retention_days: Optional[int] = None,
        sign: bool = True,
        persist: bool = True,
    ) -> ScanResult:
        """One-shot: upload agent logs, get back a signed evidence report.

        ``POST /v1/audit/scan``. ``logs`` may be JSONL text, a list of record
        dicts (or JSON-line strings), or a single record dict. The returned
        :class:`ScanResult` carries the signed envelope inline; verify it offline
        with ``result.verify()`` - no second round trip, no server trust needed.

        Args:
            logs: the agent activity export to analyze.
            subject: human label for the fleet under review (shown on the report).
            source: optional provenance tag (e.g. ``"litellm"``, ``"langfuse"``).
            retention_days: declared log-retention window (mapped to EU AI Act
                Art.12); clamped server-side to a sane range.
            sign: when False, skip Ed25519 signing and return only the summary.
            persist: when False, do not store a session row (the report is still
                returned inline but is not later fetchable / purchasable).
        """
        body: Dict[str, Any] = {"logs": logs, "subject": subject, "sign": sign, "persist": persist}
        if source is not None:
            body["source"] = source
        if retention_days is not None:
            body["retention_days"] = retention_days
        resp = self._request("POST", "/v1/audit/scan", body)
        return ScanResult(
            id=resp.get("id"),
            report_id=resp.get("report_id"),
            signed=bool(resp.get("signed")),
            key_fingerprint=resp.get("key_fingerprint"),
            summary=resp.get("summary") or {},
            report=resp.get("report"),
            verify_url=resp.get("verify_url"),
            raw=resp,
        )

    def reports(self) -> List[ReportSummary]:
        """List every audit/report this tenant owns (scan previews + paid).

        ``GET /v1/audit/reports``. Returns the dashboard rows. The purchasable-
        products / billing-readiness payload is available on each row's ``raw``
        and on the underlying response via :meth:`reports_raw`.
        """
        resp = self._request("GET", "/v1/audit/reports")
        rows = resp.get("reports") if isinstance(resp, Mapping) else None
        out: List[ReportSummary] = []
        for row in rows or []:
            if not isinstance(row, Mapping):
                continue
            out.append(
                ReportSummary(
                    id=row.get("id"),
                    report_id=row.get("report_id"),
                    subject=row.get("subject"),
                    readiness_pct=row.get("readiness_pct"),
                    blocking_count=row.get("blocking_count"),
                    tier=row.get("tier"),
                    paid=bool(row.get("paid")),
                    public_slug=row.get("public_slug"),
                    trust_url=row.get("trust_url"),
                    source=row.get("source"),
                    created_at=row.get("created_at"),
                    raw=dict(row),
                )
            )
        return out

    def reports_raw(self) -> Dict[str, Any]:
        """The raw ``GET /v1/audit/reports`` envelope (``reports`` + ``billing``)."""
        return self._request("GET", "/v1/audit/reports")

    def buy_report(self, audit_id: str) -> Checkout:
        """Start the one-time purchase of the Signed Readiness Report for an audit.

        ``POST /v1/audit/report/checkout`` with ``{audit_id}``. The audit must
        belong to the caller and already have a (watermarked) report. If it is
        already paid, ``Checkout.already_paid`` is True and ``trust_url`` carries
        the shareable link.
        """
        if not audit_id:
            raise KolmError(400, {"error": "audit_id required"})
        resp = self._request("POST", "/v1/audit/report/checkout", {"audit_id": audit_id})
        return Checkout(
            url=resp.get("url"),
            source=resp.get("source"),
            already_paid=bool(resp.get("already_paid")),
            trust_url=resp.get("trust_url"),
            raw=resp,
        )

    def subscribe(self, plan: str) -> Checkout:
        """Subscribe to Continuous re-attestation.

        ``POST /v1/audit/continuous/checkout`` with ``{plan}``. ``plan`` is
        ``"starter"`` or ``"growth"``.
        """
        p = str(plan or "").lower()
        if p not in ("starter", "growth"):
            raise KolmError(400, {"error": 'plan must be "starter" or "growth"'})
        resp = self._request("POST", "/v1/audit/continuous/checkout", {"plan": p})
        return Checkout(
            url=resp.get("url"),
            source=resp.get("source"),
            already_paid=bool(resp.get("already_paid")),
            trust_url=resp.get("trust_url"),
            raw=resp,
        )

    def trust(self, slug: str, *, format: str = "json") -> Union[Dict[str, Any], str, bytes]:
        """Fetch a public Trust link's report (no auth, no account).

        ``GET /v1/trust/:slug``. ``format`` is ``"json"`` (default - returns the
        parsed signed envelope, which you can hand straight to
        :func:`verify_report`), ``"html"`` (returns the rendered report string),
        or ``"pdf"`` (returns the PDF bytes).
        """
        fmt = str(format or "json").lower()
        if not slug:
            raise KolmError(400, {"error": "slug required"})
        if fmt == "json":
            return self._request("GET", f"/v1/trust/{urllib.parse.quote(slug)}", params={"format": "json"}, auth=False)
        if fmt == "html":
            return self._request("GET", f"/v1/trust/{urllib.parse.quote(slug)}", params={"format": "html"}, auth=False, expect="text")
        if fmt == "pdf":
            return self._request("GET", f"/v1/trust/{urllib.parse.quote(slug)}", params={"format": "pdf"}, auth=False, expect="bytes")
        raise KolmError(400, {"error": 'format must be "json", "html", or "pdf"'})

    # ------------------------------------------------------------------
    # Verification
    # ------------------------------------------------------------------
    def verify_report(
        self,
        envelope: Union[str, Mapping[str, Any]],
        keyring: Any = None,
    ) -> VerifyResult:
        """Verify a signed report OFFLINE (delegates to :func:`verify_report`).

        No network, no account - this is the killer feature. Provided as a method
        for discoverability; identical to the module-level function.
        """
        return verify_report(envelope, keyring)

    def verify_online(self, envelope: Mapping[str, Any]) -> Dict[str, Any]:
        """Verify a report via the PUBLIC server endpoint (no auth).

        ``POST /v1/audit/report/verify``. Returns ``{ok, trusted, verify, issuer}``.
        Prefer the offline :meth:`verify_report` for true zero-trust verification;
        this exists for callers who want the server's verdict as a cross-check.
        """
        return self._request("POST", "/v1/audit/report/verify", {"report": envelope}, auth=False)
