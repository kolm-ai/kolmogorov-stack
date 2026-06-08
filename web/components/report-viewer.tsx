"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

/* ---------------------------------------------------------------------------
 * ReportViewer - reads the REAL signed report JSON (the same artifact the
 * verifier checks) and lays it out the way a buyer's reviewer reads it:
 * readiness rollup, the per-control verdict, the findings with their framework
 * crosswalk, and the signing metadata. No mock data - it renders whatever URL
 * it is pointed at. This is the read surface that sits beside the VerifyWidget.
 * ------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  asr: { id: string; name: string };
  frameworks: string[];
}
interface ControlRollup {
  id: string;
  name: string;
  status: string;
  findings: number;
}
interface FrameworkRollup {
  framework: string;
  controls_touched: number;
  findings: number;
  worst_severity: Severity;
}
interface Report {
  report_id: string;
  generated_at: string;
  subject: { name: string; source?: string; records?: number; events?: number };
  summary: {
    readiness_pct: number;
    total_findings: number;
    by_severity: Record<string, number>;
    assessed_controls: string[];
    controls: ControlRollup[];
  };
  findings: Finding[];
  frameworks: FrameworkRollup[];
  signature_ed25519: { key_fingerprint: string; signed_at: string };
}

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function sevClass(sev: Severity): string {
  return sev === "critical" || sev === "high"
    ? "border-void-edge bg-void-soft text-void"
    : sev === "medium"
      ? "border-line-2 text-ink-2"
      : "border-line text-ink-3";
}

export function ReportViewer({
  src = "/sample-audit-report.json",
}: {
  src?: string;
}) {
  const [report, setReport] = React.useState<Report | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((r: Report) => alive && setReport(r))
      .catch((e: unknown) =>
        alive ? setError(e instanceof Error ? e.message : "load failed") : null
      );
    return () => {
      alive = false;
    };
  }, [src]);

  if (error) {
    return (
      <p className="font-mono text-[13px] text-void">
        Could not load the report: {error}
      </p>
    );
  }
  if (!report) {
    return (
      <p className="font-mono text-[13px] text-ink-3">Loading the report…</p>
    );
  }

  const sevCounts = SEV_ORDER.filter(
    (s) => (report.summary.by_severity[s] ?? 0) > 0
  );

  return (
    <div className="grid gap-6">
      {/* header */}
      <Card className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
            Subject
          </p>
          <h3 className="font-sans text-[20px] font-semibold leading-tight text-ink">
            {report.subject.name}
          </h3>
          <p className="mt-1 font-mono text-[12px] text-ink-3">
            {report.report_id} · {report.subject.events ?? 0} events ·{" "}
            {report.subject.records ?? 0} records · source{" "}
            {report.subject.source ?? "n/a"}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="font-display text-[44px] font-extrabold leading-none tracking-[-0.03em] text-ink">
            {report.summary.readiness_pct}
            <span className="text-[20px] text-ink-3">% ready</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sevCounts.map((s) => (
              <Badge key={s} className={cn(sevClass(s))}>
                {report.summary.by_severity[s]} {s}
              </Badge>
            ))}
          </div>
        </div>
      </Card>

      {/* per-control verdict */}
      <div>
        <p className="eyebrow mb-3">Controls assessed</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {report.summary.controls.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] font-medium text-ink-3">
                  {c.id}
                </span>
                <Badge
                  variant={c.status === "pass" ? "verified" : "void"}
                  className="uppercase"
                >
                  {c.status}
                </Badge>
              </div>
              <p className="mt-2 font-sans text-[15px] font-semibold text-ink">
                {c.name}
              </p>
              <p className="mt-1 text-[13px] text-ink-3">
                {c.findings} finding{c.findings === 1 ? "" : "s"}
              </p>
            </Card>
          ))}
        </div>
      </div>

      {/* findings */}
      <div>
        <p className="eyebrow mb-3">Findings</p>
        <div className="grid gap-3">
          {report.findings.map((f) => (
            <Card key={f.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn("uppercase", sevClass(f.severity))}>
                  {f.severity}
                </Badge>
                <span className="ctrlid">
                  <b className="mr-1.5 text-ink">{f.asr.id}</b>
                  {f.asr.name}
                </span>
              </div>
              <p className="mt-2 font-sans text-[15px] font-semibold leading-snug text-ink">
                {f.title}
              </p>
              <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                {f.detail}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {f.frameworks.map((fr) => (
                  <span key={fr} className="ctrlid">
                    {fr}
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* framework crosswalk */}
      <div>
        <p className="eyebrow mb-3">Framework crosswalk</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {report.frameworks.map((fw) => (
            <Card key={fw.framework} className="p-4">
              <p className="font-sans text-[15px] font-semibold text-ink">
                {fw.framework}
              </p>
              <p className="mt-1 font-mono text-[12px] text-ink-3">
                {fw.controls_touched} controls · {fw.findings} findings · worst{" "}
                {fw.worst_severity}
              </p>
            </Card>
          ))}
        </div>
      </div>

      {/* signing metadata */}
      <Card ledger className="grid gap-2 p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-on-ink-3">
          Signature · Ed25519
        </p>
        <p className="break-all font-mono text-[12px] text-on-ink-2">
          key_fingerprint{" "}
          <b className="text-on-ink">
            {report.signature_ed25519.key_fingerprint}
          </b>
        </p>
        <p className="font-mono text-[12px] text-on-ink-2">
          signed_at{" "}
          <b className="text-on-ink">{report.signature_ed25519.signed_at}</b>
        </p>
      </Card>
    </div>
  );
}
