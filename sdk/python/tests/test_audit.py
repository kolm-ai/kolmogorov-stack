"""Tests for kolm.audit - the Agent Security-Review SDK + offline verifier.

Runnable two ways:

    python -m pytest sdk/python/tests/test_audit.py
    python sdk/python/tests/test_audit.py        # stdlib runner, no pytest needed

The canonicalization tests shell out to the REAL Node implementation
(``src/attestation-report-builder.js`` via ``_node_bridge.mjs``) and assert the
pure-Python ``canonicalize`` / ``canonicalize_report`` match it BYTE-FOR-BYTE.
Those specific tests are skipped (not failed) when ``node`` is unavailable; every
other test is pure Python and always runs.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Make `import kolm` work whether run via pytest from repo root or directly.
_HERE = Path(__file__).resolve()
_SDK_ROOT = _HERE.parents[1]          # sdk/python
_REPO_ROOT = _HERE.parents[3]         # repo root
if str(_SDK_ROOT) not in sys.path:
    sys.path.insert(0, str(_SDK_ROOT))

from kolm.audit import (  # noqa: E402
    AUDIT_REPORT_SCHEMA,
    ED25519_ALG,
    ED25519_SPEC,
    canonicalize,
    canonicalize_report,
    default_keyring,
    issuer_provenance,
    key_fingerprint_from_pem,
    verify_report,
    _js_number_to_string,
)

_FIXTURE = _HERE.parent / "fixtures" / "sample-report.json"
_BRIDGE = _HERE.parent / "_node_bridge.mjs"
_NODE = shutil.which("node")

# cryptography is a declared dependency; the signing helpers below need it.
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class SkipTest(Exception):
    """Raised to skip a test in the stdlib runner."""


# True only while the bare-`python` stdlib runner is driving (set in
# _run_standalone). Under pytest it stays False so _need_node() can use the real
# pytest.skip mechanism (an autouse fixture cannot catch a test body's
# exception, so skipping must happen from inside the test).
_STDLIB_RUNNER = False


def _need_node():
    if _NODE:
        return
    msg = "node not available - skipping byte-for-byte cross-check"
    if _STDLIB_RUNNER:
        raise SkipTest(msg)
    import pytest

    pytest.skip(msg)


def _node_bridge(mode: str, obj) -> bytes:
    """Run the real Node canonicalizer/verifier over ``obj`` and return raw bytes."""
    _need_node()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fp:
        json.dump(obj, fp, ensure_ascii=False)
        tmp = fp.name
    try:
        proc = subprocess.run(
            [_NODE, str(_BRIDGE), mode, tmp],
            capture_output=True,
            check=True,
        )
        return proc.stdout
    finally:
        os.unlink(tmp)


def _node_canon(obj) -> bytes:
    return _node_bridge("canon", obj)


def _node_canon_report(obj) -> bytes:
    return _node_bridge("canonreport", obj)


def _node_verify(obj) -> dict:
    return json.loads(_node_bridge("verify", obj).decode("utf-8"))


def _load_fixture() -> dict:
    with open(_FIXTURE, "r", encoding="utf-8") as fp:
        return json.load(fp)


def _ed25519_pem_keypair():
    priv = Ed25519PrivateKey.generate()
    priv_pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return priv, pub_pem


def _sign_envelope(envelope: dict, priv: Ed25519PrivateKey, pub_pem: str) -> dict:
    """Sign ``envelope`` the same way src/attestation-report-builder.js does."""
    canonical = canonicalize_report(envelope).encode("utf-8")
    raw_sig = priv.sign(canonical)
    sig_b64url = base64.urlsafe_b64encode(raw_sig).rstrip(b"=").decode("ascii")
    out = dict(envelope)
    out["signature_ed25519"] = {
        "spec": ED25519_SPEC,
        "alg": ED25519_ALG,
        "public_key": pub_pem,
        "key_fingerprint": key_fingerprint_from_pem(pub_pem),
        "signature": sig_b64url,
        "signed_at": envelope.get("generated_at"),
    }
    return out


# ---------------------------------------------------------------------------
# 1. Number formatting - JS JSON.stringify parity (the trickiest part).
# ---------------------------------------------------------------------------
def test_js_number_formatting_known_vectors():
    cases = {
        5: "5",
        -5: "-5",
        0: "0",
        5.0: "5",
        -3.25: "-3.25",
        0.5: "0.5",
        100.0: "100",
        57.88: "57.88",
        1e21: "1e+21",
        1e-7: "1e-7",
        0.0001: "0.0001",
        1e20: "100000000000000000000",
        -0.0: "0",
        123.456: "123.456",
        1000000.0: "1000000",
    }
    for value, expected in cases.items():
        got = _js_number_to_string(value)
        assert got == expected, f"_js_number_to_string({value!r}) = {got!r}, expected {expected!r}"
    # Non-finite -> 'null' (matches Number.isFinite ? ... : 'null').
    assert _js_number_to_string(float("nan")) == "null"
    assert _js_number_to_string(float("inf")) == "null"
    assert _js_number_to_string(float("-inf")) == "null"


def test_numbers_match_node_byte_for_byte():
    # Each number is a top-level JSON value; compare Python vs the real Node canon.
    for value in [5, -5, 0, 5.0, -3.25, 0.5, 100.0, 57.88, 1e21, 1e-7, 0.0001, 1e20, 123.456]:
        node = _node_canon(value)
        py = canonicalize(value).encode("utf-8")
        assert py == node, f"{value!r}: python {py!r} != node {node!r}"


# ---------------------------------------------------------------------------
# 2. Canonicalization - structural + string vectors vs the real Node code.
# ---------------------------------------------------------------------------
def test_canonicalize_vectors_match_node():
    vectors = [
        None,
        True,
        False,
        "",
        "hello",
        "café ☃ · / \\ \" \t \n \r   end",  # unicode, slash, ctrl
        "no/escape/for/slash",
        [],
        {},
        [1, 2, 3],
        [True, False, None, "x"],
        {"z": 1, "a": 2, "m": None, "b": [3, 2, 1]},
        {"nested": {"deep": {"k": [1, {"y": 2, "x": 1}]}}},
        # key-sort independence: same content, different insertion order.
        {"b": 1, "a": 2, "c": 3},
        {"c": 3, "a": 2, "b": 1},
        # numbers embedded in structure (incl. integer-valued float -> "5")
        {"pct": 0, "span": 57.88, "ratio": 0.5, "whole": 5.0},
        # the sample report's middot-bearing subject string
        {"name": "Helpwise · support & billing agents (demo)"},
    ]
    for v in vectors:
        node = _node_canon(v)
        py = canonicalize(v).encode("utf-8")
        assert py == node, f"canonicalize mismatch for {v!r}:\n  python={py!r}\n  node  ={node!r}"


def test_canonicalize_report_of_sample_matches_node_byte_for_byte():
    report = _load_fixture()
    node = _node_canon_report(report)
    py = canonicalize_report(report).encode("utf-8")
    assert py == node, "canonicalize_report(sample) diverges from Node"
    # Ground-truth byte length established by running the real module (10673
    # UTF-8 bytes; the report carries middot characters so byte length > char
    # length).
    assert len(py) == 10673, f"expected 10673 canonical bytes, got {len(py)}"


def test_signature_block_is_excluded_from_canonical():
    report = _load_fixture()
    with_sig = canonicalize_report(report)
    no_sig = canonicalize_report({k: v for k, v in report.items() if k != "signature_ed25519"})
    assert with_sig == no_sig


# ---------------------------------------------------------------------------
# 3. Key fingerprint - matches src/ed25519.js keyFingerprint() + the keyring.
# ---------------------------------------------------------------------------
def test_bundled_issuer_fingerprints_recompute():
    issuers = default_keyring()
    assert issuers, "bundled keyring should not be empty"
    by_kid = {i.get("kid"): i for i in issuers}
    assert "kolm-demo-2026" in by_kid and "kolm-prod-2026" in by_kid
    for iss in issuers:
        recomputed = key_fingerprint_from_pem(iss["public_key"])
        assert recomputed == iss["fingerprint"], (
            f"{iss.get('kid')}: recomputed {recomputed} != keyring {iss['fingerprint']}"
        )
    # Pin the demo fingerprint to the value the sample report claims.
    assert by_kid["kolm-demo-2026"]["fingerprint"] == "410302c93becdcc3a8091ef0c33c24ed"


# ---------------------------------------------------------------------------
# 4. verify_report - roundtrip on the committed fixture.
# ---------------------------------------------------------------------------
def test_verify_sample_report_roundtrip():
    report = _load_fixture()
    result = verify_report(report)
    assert result.tier1_signature is True, result.reason
    assert result.tier2_issuer is True, result.reason
    assert result.ok is True, result.reason
    assert result.key_fingerprint == "410302c93becdcc3a8091ef0c33c24ed"
    assert result.issuer is not None and result.issuer.kid == "kolm-demo-2026"
    assert result.issuer.status == "demo"
    assert result.reason is None


def test_verify_accepts_json_string_input():
    text = json.dumps(_load_fixture())
    result = verify_report(text)
    assert result.ok is True, result.reason


def test_verify_to_dict_shape():
    result = verify_report(_load_fixture())
    d = result.to_dict()
    for key in ("ok", "tier1_signature", "tier2_issuer", "key_fingerprint", "reason"):
        assert key in d, f"missing {key} in result dict"
    assert d["ok"] is True


def test_python_verify_agrees_with_node_on_sample():
    # The Python verifier and the real Node verifier reach the same tier-1 verdict.
    report = _load_fixture()
    py = verify_report(report)
    node = _node_verify(report)
    assert node["ok"] is True
    assert py.tier1_signature is True
    assert py.key_fingerprint == node["key_fingerprint"]


# ---------------------------------------------------------------------------
# 5. Tamper detection - any altered byte breaks tier-1.
# ---------------------------------------------------------------------------
def test_tamper_readiness_pct_breaks_signature():
    report = _load_fixture()
    report["summary"]["readiness_pct"] = 99  # forge a passing score
    result = verify_report(report)
    assert result.tier1_signature is False
    assert result.ok is False
    assert "does not verify" in (result.reason or "")


def test_tamper_remove_a_finding_breaks_signature():
    report = _load_fixture()
    report["findings"].pop()  # delete a finding
    result = verify_report(report)
    assert result.tier1_signature is False
    assert result.ok is False


def test_tamper_flip_tamper_evident_flag_breaks_signature():
    report = _load_fixture()
    report["summary"]["tamper_evident"] = True
    result = verify_report(report)
    assert result.tier1_signature is False


def test_tamper_signed_at_after_signing_is_caught():
    report = _load_fixture()
    # generated_at is signed; signed_at is not. Editing only the displayed
    # signed_at must be caught by the generated_at cross-check.
    report["signature_ed25519"]["signed_at"] = "2030-01-01T00:00:00.000Z"
    result = verify_report(report)
    assert result.tier1_signature is False
    assert "signed_at" in (result.reason or "")


def test_fingerprint_claim_mismatch_is_caught():
    report = _load_fixture()
    report["signature_ed25519"]["key_fingerprint"] = "0" * 32
    result = verify_report(report)
    assert result.tier1_signature is False
    assert "fingerprint" in (result.reason or "").lower()


def test_corrupt_signature_breaks_verification():
    report = _load_fixture()
    sig = report["signature_ed25519"]["signature"]
    # Flip a character (keep it base64url-legal) so the bytes decode but mismatch.
    flipped = ("A" if sig[0] != "A" else "B") + sig[1:]
    report["signature_ed25519"]["signature"] = flipped
    result = verify_report(report)
    assert result.tier1_signature is False
    assert result.ok is False


# ---------------------------------------------------------------------------
# 6. Issuer provenance (tier-2).
# ---------------------------------------------------------------------------
def test_unknown_issuer_makes_tier2_false():
    # Freshly-generated key is NOT in the bundled keyring. tier-1 passes (the
    # signature is self-consistent), tier-2 fails, so ok is False.
    priv, pub_pem = _ed25519_pem_keypair()
    envelope = {
        "schema": AUDIT_REPORT_SCHEMA,
        "report_version": "asr-report/0.1",
        "report_id": "asrr_test",
        "generated_at": "2026-06-09T00:00:00.000Z",
        "summary": {"readiness_pct": 42, "blocking_count": 0},
        "findings": [],
    }
    signed = _sign_envelope(envelope, priv, pub_pem)
    result = verify_report(signed)
    assert result.tier1_signature is True, result.reason
    assert result.tier2_issuer is False
    assert result.ok is False
    assert result.issuer is not None and result.issuer.recognized is False
    assert "not a recognized kolm issuer" in (result.reason or "")


def test_custom_keyring_recognizes_a_self_signed_key():
    priv, pub_pem = _ed25519_pem_keypair()
    envelope = {
        "schema": AUDIT_REPORT_SCHEMA,
        "generated_at": "2026-06-09T00:00:00.000Z",
        "summary": {"readiness_pct": 100},
    }
    signed = _sign_envelope(envelope, priv, pub_pem)
    keyring = {"issuers": [{"kid": "my-key", "label": "mine", "status": "production", "public_key": pub_pem}]}
    result = verify_report(signed, keyring=keyring)
    assert result.tier1_signature is True
    assert result.tier2_issuer is True
    assert result.ok is True
    assert result.issuer.kid == "my-key" and result.issuer.status == "production"


def test_node_accepts_a_python_signed_report():
    # Strongest byte-for-byte proof: a report SIGNED in pure Python verifies
    # under the real Node verifier - which only happens if Python's canonical
    # bytes equal Node's exactly.
    priv, pub_pem = _ed25519_pem_keypair()
    envelope = {
        "schema": AUDIT_REPORT_SCHEMA,
        "report_version": "asr-report/0.1",
        "report_id": "asrr_pysigned",
        "generated_at": "2026-06-09T12:34:56.000Z",
        "subject": {"name": "Python-signed · fleet", "records": 3, "events": 7},
        "summary": {"readiness_pct": 50, "total_findings": 1, "tamper_evident": False, "span_days": 57.88},
        "findings": [{"id": "x", "severity": "high", "frameworks": ["SOC 2 TSC CC6"]}],
    }
    signed = _sign_envelope(envelope, priv, pub_pem)
    node = _node_verify(signed)
    assert node["ok"] is True, node
    assert node["key_fingerprint"] == key_fingerprint_from_pem(pub_pem)


def test_issuer_provenance_demo_recognized():
    report = _load_fixture()
    match = issuer_provenance(report)
    assert match.recognized is True
    assert match.kid == "kolm-demo-2026"
    assert match.status == "demo"


# ---------------------------------------------------------------------------
# 7. Defensive / never-throws contract.
# ---------------------------------------------------------------------------
def test_verify_garbage_inputs_never_throw():
    for bad in [None, 123, [], "not json", '{"broken":', {"schema": "wrong"}, {}, {"schema": AUDIT_REPORT_SCHEMA}]:
        result = verify_report(bad)
        assert result.ok is False
        assert result.tier1_signature is False
        assert isinstance(result.reason, str) and result.reason


def test_unexpected_schema_rejected():
    result = verify_report({"schema": "some-other-schema", "signature_ed25519": {}})
    assert result.ok is False
    assert "schema" in (result.reason or "")


# ---------------------------------------------------------------------------
# Stdlib runner (so `python tests/test_audit.py` works without pytest).
# ---------------------------------------------------------------------------
def _run_standalone() -> int:
    global _STDLIB_RUNNER
    _STDLIB_RUNNER = True
    tests = sorted(
        (name, obj)
        for name, obj in globals().items()
        if name.startswith("test_") and callable(obj)
    )
    passed = failed = skipped = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except SkipTest as e:
            print(f"  SKIP  {name}: {e}")
            skipped += 1
        except Exception as e:  # noqa: BLE001
            import traceback
            print(f"  FAIL  {name}: {e}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_standalone())
