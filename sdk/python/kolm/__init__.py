"""
kolm - Python client for the kolm AI compiler.

Wraps the public HTTP API. The CLI (Node) is the canonical interface;
this package mirrors its surface for Python users.

Quick use::

    from kolm import Kolm

    k = Kolm(api_key="k_live_...")

    job = k.compile(
        task="answer support tickets in my voice",
        examples_path="./tickets.jsonl",
        base="qwen2.5-7b-instruct",
    )
    artifact_path = k.wait(job.id)            # downloads .kolm

    out = k.run(artifact_path, input="user can't log in")
    print(out.text)

Agent Security-Review audit + offline evidence verification::

    from kolm import AuditClient, verify_report

    a = AuditClient(api_key="ks_...")
    scan = a.scan(open("agent-logs.jsonl").read(), subject="support agents")

    # Verify the signed report OFFLINE - no server, no account, no shared secret.
    result = scan.verify()
    assert result.ok and result.tier1_signature and result.tier2_issuer
    print(result.key_fingerprint, result.issuer.status)
"""

from .client import Kolm, KolmError, CompileJob, RunResult
from .audit import (
    AuditClient,
    ScanResult,
    ReportSummary,
    Checkout,
    IssuerMatch,
    VerifyResult,
    verify_report,
    canonicalize,
    canonicalize_report,
    key_fingerprint_from_pem,
    issuer_provenance,
    load_keyring,
    default_keyring,
    AUDIT_REPORT_SCHEMA,
    AUDIT_REPORT_VERSION,
    ED25519_SPEC,
    ED25519_ALG,
)

__version__ = "0.3.0"
__all__ = [
    # compile/run product
    "Kolm",
    "KolmError",
    "CompileJob",
    "RunResult",
    # agent-security audit product
    "AuditClient",
    "ScanResult",
    "ReportSummary",
    "Checkout",
    "IssuerMatch",
    "VerifyResult",
    "verify_report",
    "canonicalize",
    "canonicalize_report",
    "key_fingerprint_from_pem",
    "issuer_provenance",
    "load_keyring",
    "default_keyring",
    "AUDIT_REPORT_SCHEMA",
    "AUDIT_REPORT_VERSION",
    "ED25519_SPEC",
    "ED25519_ALG",
]
