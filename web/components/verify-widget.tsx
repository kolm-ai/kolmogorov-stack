"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckIcon } from "@/components/icons";

/* ---------------------------------------------------------------------------
 * VerifyWidget - the live, in-page proof.
 *
 * This mounts the REAL browser verifier. It dynamically loads the shipped,
 * dependency-free ESM module `public/kolm-audit-verify.js` (copied verbatim
 * from the static site, byte-for-byte identical to the Node builder's
 * canonicalization) and runs ACTUAL WebCrypto Ed25519 verification on a signed
 * Agent Security-Review report - no upload, no kolm server in the trust path,
 * no canned "OK" lines.
 *
 *   tier 1  verifyAuditReport()  -> signature is valid AND the bytes are intact
 *   tier 2  issuerProvenance()   -> the signing key is one kolm publishes
 *
 * The "Tamper a field" control mutates one signed value and re-runs the SAME
 * verifier; the signature breaks and the seal reads VOID. That is the
 * falsifiable claim made physical.
 *
 * The webpackIgnore dynamic import keeps this a native browser import so
 * webpack does not try to bundle the public asset; the module is served from
 * /kolm-audit-verify.js at runtime. This is the exact mount point the
 * production cutover reuses - point `reportSrc` at any signed report URL.
 * ------------------------------------------------------------------------- */

interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
interface VerifyResult {
  ok: boolean;
  reason?: string;
  key_fingerprint?: string;
  checks: VerifyCheck[];
}
interface IssuerResult {
  recognized: boolean;
  kid: string | null;
  label: string | null;
  status: string | null;
  embedded_key?: string;
}
interface AuditVerifier {
  verifyAuditReport: (
    report: unknown,
    opts?: Record<string, unknown>
  ) => Promise<VerifyResult>;
  issuerProvenance: (report: unknown, keyring: unknown) => IssuerResult;
}

type Phase = "loading" | "verified" | "void" | "error";

const VERIFIER_URL = "/kolm-audit-verify.js";

async function loadVerifier(): Promise<AuditVerifier> {
  const url = VERIFIER_URL;
  // webpackIgnore: keep this a native dynamic import resolved by the browser
  // against the public/ asset, not a bundled module.
  const mod = (await import(/* webpackIgnore: true */ url)) as AuditVerifier;
  return mod;
}

export function VerifyWidget({
  reportSrc = "/sample-audit-report.json",
  keyringSrc = "/keys/kolm-issuers.json",
  className,
}: {
  reportSrc?: string;
  keyringSrc?: string;
  className?: string;
}) {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [result, setResult] = React.useState<VerifyResult | null>(null);
  const [issuer, setIssuer] = React.useState<IssuerResult | null>(null);
  const [subject, setSubject] = React.useState<string>("");
  const [tampered, setTampered] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const verifierRef = React.useRef<AuditVerifier | null>(null);
  const reportRef = React.useRef<Record<string, unknown> | null>(null);
  const keyringRef = React.useRef<unknown>(null);

  const run = React.useCallback(async (report: Record<string, unknown>) => {
    const verifier = verifierRef.current;
    if (!verifier) return;
    const res = await verifier.verifyAuditReport(report);
    const iss = verifier.issuerProvenance(report, keyringRef.current);
    setResult(res);
    setIssuer(iss);
    setPhase(res.ok ? "verified" : "void");
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [verifier, report, keyring] = await Promise.all([
          loadVerifier(),
          fetch(reportSrc).then((r) => r.json()),
          fetch(keyringSrc).then((r) => r.json()),
        ]);
        if (!alive) return;
        verifierRef.current = verifier;
        reportRef.current = report;
        keyringRef.current = keyring;
        const subj =
          (report?.subject as { name?: string } | undefined)?.name ?? "report";
        setSubject(subj);
        await run(report);
      } catch (err) {
        if (!alive) return;
        setPhase("error");
        setResult({
          ok: false,
          reason:
            err instanceof Error ? err.message : "could not load the verifier",
          checks: [],
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [reportSrc, keyringSrc, run]);

  const onTamper = React.useCallback(async () => {
    if (!reportRef.current) return;
    setBusy(true);
    try {
      // Deep clone the signed report and inflate the readiness score. The
      // signature covers the canonical bytes, so this single mutation must
      // break tier-1 verification.
      const clone = JSON.parse(JSON.stringify(reportRef.current)) as Record<
        string,
        unknown
      >;
      const summary = (clone.summary ?? {}) as Record<string, unknown>;
      summary.readiness_pct = 100;
      clone.summary = summary;
      setTampered(true);
      await run(clone);
    } finally {
      setBusy(false);
    }
  }, [run]);

  const onReset = React.useCallback(async () => {
    if (!reportRef.current) return;
    setBusy(true);
    try {
      setTampered(false);
      await run(reportRef.current);
    } finally {
      setBusy(false);
    }
  }, [run]);

  return (
    <div
      className={cn(
        "rounded-lg border bg-paper-2 p-5 shadow-[0_18px_50px_-34px_rgba(14,19,16,0.32)]",
        phase === "void" ? "border-void-edge" : "border-line",
        className
      )}
      aria-live="polite"
      data-verify-widget
      data-src={reportSrc}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="livedot inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-accent-text">
          Live · runs in your browser
        </span>
        {phase === "verified" && <Badge variant="verified">Verified</Badge>}
        {phase === "void" && <Badge variant="void">Void</Badge>}
        {phase === "loading" && <Badge>Verifying…</Badge>}
        {phase === "error" && <Badge variant="void">Unavailable</Badge>}
      </div>

      <p className="mt-4 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-3">
        Subject
      </p>
      <p className="font-sans text-[15px] font-medium text-ink">{subject}</p>

      {/* the verdict line */}
      <div className="mt-4 rounded-md border border-line bg-paper-sink p-4">
        {phase === "loading" && (
          <p className="font-mono text-[13px] text-ink-2">
            Loading the verifier and the signed report…
          </p>
        )}
        {phase === "verified" && (
          <p className="font-mono text-[13px] text-ink">
            Ed25519 signature checks. The bytes are intact.
          </p>
        )}
        {phase === "void" && (
          <p className="font-mono text-[13px] text-void">
            VOID — {result?.reason ?? "the signature does not verify."}
          </p>
        )}
        {phase === "error" && (
          <p className="font-mono text-[13px] text-void">
            {result?.reason}
          </p>
        )}

        {result && result.checks.length > 0 && (
          <ul className="mt-3 grid gap-1.5">
            {result.checks.map((c) => (
              <li
                key={c.name}
                className="flex items-start gap-2 font-mono text-[12px] text-ink-2"
              >
                <CheckIcon
                  className={cn(
                    "mt-[3px] h-3.5 w-3.5 flex-none",
                    c.ok ? "text-[var(--accent)]" : "text-void"
                  )}
                />
                <span>
                  <b className="font-semibold text-ink">{c.name}</b>
                  {c.detail ? ` — ${c.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* issuer provenance (tier 2) */}
      {issuer && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <span className="font-mono uppercase tracking-[0.14em]">Issuer</span>
          {issuer.recognized ? (
            <Badge variant="default">
              {issuer.label ?? issuer.kid ?? "recognized"}
              {issuer.status ? ` · ${issuer.status}` : ""}
            </Badge>
          ) : (
            <Badge variant="void">unrecognized key</Badge>
          )}
          {result?.key_fingerprint && (
            <code className="break-all font-mono text-[11px] text-ink-2">
              {result.key_fingerprint}
            </code>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!tampered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onTamper}
            disabled={phase === "loading" || phase === "error" || busy}
          >
            Tamper a field
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={busy}
          >
            Reset the report
          </Button>
        )}
        <Button asChild variant="ghost" size="sm">
          <a href={reportSrc} download>
            Download the JSON
          </a>
        </Button>
      </div>

      <p className="mt-3 text-center text-[12px] text-ink-3">
        Try to break it. <b className="text-ink-2">Inflate the score</b> and the
        seal reads VOID. Real Ed25519, no account, no upload.
      </p>
    </div>
  );
}
