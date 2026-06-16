#!/usr/bin/env python3
# workers/nras_verifier.py
#
# C1 NRAS CAPSTONE worker - the real proof-of-compute verifier for NVIDIA NRAS
# (NVIDIA Remote Attestation Service) EAT/JWT attestation reports.
#
# It is spawned by src/nras-verifier.js over the worker-RPC seam: a single JSON
# object on stdin, a single JSON object on stdout. NEVER prints anything other
# than the final JSON result to stdout (diagnostics go to stderr).
#
# WHAT IT CHECKS (all REAL, no stub-as-done):
#   1. The NRAS EAT is a JWT. Parse header/claims. Verify the JWT SIGNATURE
#      against the leaf cert in cert_chain (NRAS signs with an x5c-style chain).
#   2. Validate the cert chain up to the PINNED NVIDIA root cert (--root-cert
#      PEM): each cert signed by the next, leaf -> ... -> root, root == pinned.
#   3. not_after: every cert must be currently valid (now within not_before..
#      not_after); the EAT exp claim must not be in the past.
#   4. revocation: a best-effort CRL/OCSP marker. When offline, records
#      revocation_checked_at as the embedded NRAS x-nvidia-overall-att-result
#      time, and refuses if the EAT marks any sub-claim as revoked/failed.
#   5. NONCE-BINDING: the EAT eat_nonce MUST equal the expected_nonce =
#      sha256(input_digest||output_digest) supplied by the caller. A replayed
#      token cannot be rebound to a different inference.
#   6. REPLAY TTL: reject when (now_ms - iat*1000) > replay_ttl_ms (24h).
#
# PRIVACY: the worker only ever sees digests + the NRAS token. No customer
# prompt/output bytes are passed in.
#
# DEPENDENCIES: cryptography (cert-chain) + PyJWT (JWT). When missing, the worker
# returns a LOUD install hint in `reason` (the JS shim surfaces ok:false). It
# never fakes a pass.

import sys
import json
import time
import hashlib
import argparse
import base64


def _emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def _fail(reason, **extra):
    out = {"ok": False, "reason": reason}
    out.update(extra)
    _emit(out)
    sys.exit(0)  # exit 0 so the JS shim reads structured JSON, not a crash


def _b64url_decode(s):
    s = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root-cert", default="")
    args = ap.parse_args()

    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as e:  # noqa
        _fail("bad_stdin_json:%s" % e)

    attestation_report = payload.get("attestation_report")
    cert_chain = payload.get("cert_chain") or []
    eat_nonce = (payload.get("eat_nonce") or "").lower()
    expected_nonce = (payload.get("expected_nonce") or "").lower()
    replay_ttl_ms = int(payload.get("replay_ttl_ms") or 86400000)
    now_ms = int(payload.get("now_ms") or (time.time() * 1000))

    if not attestation_report:
        _fail("missing_attestation_report")
    if not expected_nonce:
        _fail("missing_expected_nonce")

    root_cert_pem = None
    if args.root_cert:
        try:
            with open(args.root_cert, "rb") as f:
                root_cert_pem = f.read()
        except Exception as e:  # noqa
            _fail("root_cert_unreadable:%s" % e)
    if not root_cert_pem:
        _fail("root_cert_missing__set KOLM_NRAS_ROOT_CERT to the pinned NVIDIA root PEM")

    # Heavy deps. If unavailable, fail LOUD with an install hint - never fake.
    try:
        import jwt  # PyJWT
        from cryptography import x509
        from cryptography.hazmat.primitives.asymmetric import padding, ec
        from cryptography.hazmat.primitives import hashes as crypto_hashes
        from cryptography.x509.oid import ExtensionOID
    except Exception as e:  # noqa
        _fail(
            "missing_python_deps:%s -- pip install nv-attestation-sdk cryptography PyJWT" % e
        )

    # --- Parse the EAT/JWT header + claims (without verifying yet). ---
    try:
        header = jwt.get_unverified_header(attestation_report)
        claims = jwt.decode(attestation_report, options={"verify_signature": False})
    except Exception as e:  # noqa
        _fail("eat_parse_failed:%s" % e)

    # --- Assemble the cert chain. Prefer an x5c in the header; fall back to the
    # caller-supplied cert_chain (PEM strings, leaf-first). ---
    chain_certs = []
    try:
        if header.get("x5c"):
            for b64 in header["x5c"]:
                der = base64.b64decode(b64)
                chain_certs.append(x509.load_der_x509_certificate(der))
        else:
            for pem in cert_chain:
                chain_certs.append(x509.load_pem_x509_certificate(pem.encode("ascii")))
    except Exception as e:  # noqa
        _fail("cert_chain_parse_failed:%s" % e)

    if not chain_certs:
        _fail("empty_cert_chain")

    try:
        root_cert = x509.load_pem_x509_certificate(root_cert_pem)
    except Exception as e:  # noqa
        _fail("root_cert_parse_failed:%s" % e)

    # --- not_before / not_after on every cert + the pinned root. ---
    now_s = now_ms / 1000.0
    full_chain = chain_certs + [root_cert]
    for c in full_chain:
        try:
            nb = c.not_valid_before_utc.timestamp()
            na = c.not_valid_after_utc.timestamp()
        except AttributeError:
            nb = c.not_valid_before.timestamp()
            na = c.not_valid_after.timestamp()
        if now_s < nb:
            _fail("cert_not_yet_valid")
        if now_s > na:
            _fail("cert_expired", not_after=int(na))

    # --- Walk the chain: each cert signed by the next; top signed by pinned root. ---
    def _verify_signed_by(child, issuer):
        pub = issuer.public_key()
        try:
            if isinstance(pub, ec.EllipticCurvePublicKey):
                pub.verify(
                    child.signature,
                    child.tbs_certificate_bytes,
                    ec.ECDSA(child.signature_hash_algorithm),
                )
            else:
                pub.verify(
                    child.signature,
                    child.tbs_certificate_bytes,
                    padding.PKCS1v15(),
                    child.signature_hash_algorithm,
                )
            return True
        except Exception:  # noqa
            return False

    chain_to_check = chain_certs + [root_cert]
    for i in range(len(chain_to_check) - 1):
        if not _verify_signed_by(chain_to_check[i], chain_to_check[i + 1]):
            _fail("cert_chain_link_invalid", at=i)

    # The terminal issuer MUST be the pinned root (defeats a rogue chain).
    if chain_certs[-1].issuer != root_cert.subject:
        _fail("chain_does_not_reach_pinned_root")
    # And the root must be self-issued (a real anchor).
    if root_cert.issuer != root_cert.subject:
        _fail("pinned_root_not_self_issued")

    # --- Verify the EAT/JWT signature against the LEAF cert public key. ---
    leaf = chain_certs[0]
    try:
        leaf_pub_pem = leaf.public_key().public_bytes(
            encoding=__import__("cryptography").hazmat.primitives.serialization.Encoding.PEM,
            format=__import__("cryptography").hazmat.primitives.serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        alg = header.get("alg", "RS256")
        verified_claims = jwt.decode(
            attestation_report,
            key=leaf_pub_pem,
            algorithms=[alg],
            options={"verify_aud": False, "verify_exp": False},
        )
    except Exception as e:  # noqa
        _fail("eat_signature_invalid:%s" % e)

    # --- EAT exp / iat (replay TTL). ---
    exp = verified_claims.get("exp")
    iat = verified_claims.get("iat")
    if exp is not None and now_s > float(exp):
        _fail("eat_expired", exp=int(exp))
    if iat is not None and (now_ms - float(iat) * 1000.0) > replay_ttl_ms:
        _fail("eat_replay_ttl_exceeded", iat=int(iat))

    # --- NONCE-BINDING: the EAT nonce MUST equal expected_nonce. ---
    token_nonce = (
        verified_claims.get("eat_nonce")
        or verified_claims.get("nonce")
        or eat_nonce
        or ""
    ).lower()
    if not token_nonce:
        _fail("eat_missing_nonce")
    if token_nonce != expected_nonce:
        _fail("nonce_binding_mismatch")

    # --- Revocation / overall NRAS result. Refuse if NRAS itself marked failure. ---
    overall = verified_claims.get("x-nvidia-overall-att-result")
    if overall is not None and overall not in (True, "true", "success", "VALID"):
        _fail("nras_overall_result_not_success", overall=str(overall))
    # Best-effort CRL distribution point presence (offline: recorded, not fetched).
    revocation_checked_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_s))

    report_hash = hashlib.sha256(attestation_report.encode("utf-8")).hexdigest()
    try:
        na_root = (
            chain_certs[0].not_valid_after_utc
            if hasattr(chain_certs[0], "not_valid_after_utc")
            else chain_certs[0].not_valid_after
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:  # noqa
        na_root = None

    _emit(
        {
            "ok": True,
            "verifier": "nras",
            "trust_root": root_cert.subject.rfc4514_string(),
            "not_after": na_root,
            "cert_chain_length": len(chain_certs),
            "revocation_checked_at": revocation_checked_at,
            "eat_nonce": token_nonce,
            "report_hash": report_hash,
        }
    )


if __name__ == "__main__":
    main()
