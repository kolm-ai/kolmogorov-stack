# Procurement exports — turning a signed report into ingestible evidence

Every kolm Agent Security-Review produces **one** cryptographically signed
(Ed25519), offline-verifiable JSON report (`src/attestation-report-builder.js`).
That report already maps each finding to the controls an enterprise buyer's
review group cites: **SOC 2 TSC**, **ISO/IEC 42001**, **NIST AI RMF**,
**EU AI Act**, **OWASP LLM & Agentic Top 10**, **MITRE ATLAS**, and kolm's own
**ASR** readiness spine.

This page documents the export formatters (`src/framework-export.js`) that
reshape that single signed artifact into the file formats a procurement / GRC
team actually ingests — without ever re-signing or altering the signed payload.
Each export is a **read-only view** over the report and carries the report's
**key fingerprint + offline verify URL**, so any artifact can be traced back to,
and re-verified against, the signed source.

> The exports are a convenience layer for ingestion. The *authoritative*
> artifact is always the signed JSON report; verify it offline at the
> `verify_url` (browser, no upload, no account) or by POSTing it to
> `/v1/audit/report/verify`. A **trusted** verdict requires *both* a valid
> signature *and* a recognized issuer key.

---

## Formats at a glance

| `format=` | Formatter | Content-Type | File | What it is |
|---|---|---|---|---|
| `csv` | `toCSV` | `text/csv` | `<report_id>-findings.csv` | Findings × controls, RFC 4180. One row per (finding × mapped control). |
| `xlsx` | `toExcelXml` | `application/vnd.ms-excel` | `<report_id>.xls` | A real, openable Excel workbook (SpreadsheetML 2003 — no npm deps) with **Summary**, **Findings**, **Framework Crosswalk** sheets. |
| `drata` | `toDrata` | `application/json` | `<report_id>-drata.json` | Control-evidence payload shaped for Drata External Evidence. |
| `vanta` | `toVanta` | `application/json` | `<report_id>-vanta.json` | Control-evidence payload shaped for Vanta custom/external evidence. |
| `exec` | `toExecutiveSummaryMarkdown` | `text/markdown` | `<report_id>-executive-summary.md` | A crisp one-page executive summary. |
| `crosswalk` | `toFrameworkCrosswalk` | `text/markdown` | `<report_id>-framework-crosswalk.md` | A control-by-control crosswalk: ASR → framework matrix + per-framework detail. |

Each formatter returns `{ filename, contentType, body }`, is a **pure function
that never throws** (a malformed or partial envelope yields a valid, possibly
near-empty artifact rather than an exception), and never mutates the envelope.

---

## HTTP routes

Both routes serve the **same** export formatters; they differ only in how the
caller is authorized.

### Authenticated (the report owner)

```
GET /v1/audit/sessions/:id/export?format=csv|xlsx|drata|vanta|exec|crosswalk
Authorization: Bearer <ks_… key>
```

- Auth-gated and **tenant-fenced**: a session is only ever resolved within the
  owning tenant, so a cross-tenant id returns `404 session_not_found` (never a
  leak).
- `409 report_not_ready` if the session has not been run yet.
- `400 invalid_format` for an unknown `format`.
- Defaults to `csv` when `format` is omitted.

### Public (the shareable Trust link)

```
GET /v1/trust/:slug/export?format=csv|xlsx|drata|vanta|exec|crosswalk
```

- **No account required.** The `:slug` is an unguessable capability token
  (`crypto.randomBytes`); possession of the link is the grant — so a buyer can
  hand it to their procurement team and they can pull the artifacts directly.
- Resolves only for a **paid** audit slug or an **active / lapsed** Continuous
  subscription slug. A subscription that has not produced its first report yet
  returns `409 report_not_ready`; an unknown slug returns `404 not_found`.
- Served `Cache-Control: no-store`.

Example:

```bash
# CSV straight into a spreadsheet
curl -L "https://kolm.ai/v1/trust/<slug>/export?format=csv" -o findings.csv

# Excel workbook (Summary + Findings + Framework Crosswalk)
curl -L "https://kolm.ai/v1/trust/<slug>/export?format=xlsx" -o report.xls

# Drata / Vanta control-evidence JSON
curl -L "https://kolm.ai/v1/trust/<slug>/export?format=drata" -o drata.json
curl -L "https://kolm.ai/v1/trust/<slug>/export?format=vanta" -o vanta.json
```

---

## CSV (`format=csv`) — findings × controls

RFC 4180: fields are comma-separated, records are CRLF-separated, and any field
containing a comma, double-quote, CR or LF is wrapped in double-quotes with
inner quotes doubled. One **row per (finding × mapped control)** — a finding
mapped to *N* framework controls produces *N* rows, so the file pivots cleanly
in any spreadsheet. A finding with no framework mapping still emits one row; a
clean report (no findings) emits the header plus a single posture row.

Columns:

```
report_id, subject, generated_at, tier,
finding_id, severity, pillar, asr_id, asr_name,
title, detail, framework, control_id, control_label,
remediation_priority, remediation_action,
verify_url, key_fingerprint
```

**Import into Excel / Google Sheets:** open directly, or *Data → From Text/CSV*.
For non-ASCII subjects in Excel, import as UTF-8 (or use the `xlsx` export, which
needs no encoding choice).

---

## Excel workbook (`format=xlsx`) — SpreadsheetML 2003

A real, openable `.xls` workbook emitted as Microsoft **SpreadsheetML 2003**
XML (the `<?mso-application progid="Excel.Sheet"?>`-prefixed format). It is built
with **no npm dependency** and opens in Excel, LibreOffice and Google Sheets.
Three sheets:

- **Summary** — report metadata, the headline numbers (readiness, deal-blocking
  count, tamper-evident trail), the ASR control-status table (with the
  not-assessed controls disclosed), and the Ed25519 signature block.
- **Findings** — one row per finding: severity, pillar, ASR, title, detail,
  the mapped frameworks, and the remediation priority + action.
- **Framework Crosswalk** — one row per implicated framework control:
  framework, control, what it covers, finding count, worst severity.

All cell values are XML-escaped and illegal-in-XML control characters are
stripped, so a hostile log value can never produce a broken workbook.

**Import:** double-click the file, or in Excel *File → Open*. Excel may show a
"the file format and extension don't match" prompt — that is expected for
SpreadsheetML; choose *Yes* to open.

---

## Drata (`format=drata`) and Vanta (`format=vanta`) — control evidence

Both emit a documented, generic **control-evidence** JSON (`$schema:
"kolm-control-evidence/1"`) shaped for the named GRC tool's evidence-import
surface. Each builds one list of per-control records from three sources in the
signed report:

1. The **ASR spine** — the controls actually assessed (ASR-1/2/3), carrying
   their real `pass` / `attention` / `blocking` status (including PASS controls).
2. The **not-assessed** ASR controls (ASR-4/5/6) — disclosed explicitly with
   their reason and a `NOT_ASSESSED` status, so the scope is never overstated.
3. Every **implicated framework control** from the report's per-framework
   rollup (SOC 2 / ISO / NIST / EU / OWASP / MITRE), with a status derived from
   the worst severity touching that control.

> **Mapping note (read this).** These payloads are a *clean, documented generic
> control-evidence shape* using each tool's conventional field names and status
> vocabulary. They are not a claim of a specific private API contract. Import via
> the tool's external/custom-evidence API or attach each record to its control
> by code; if your tenant's import schema differs, the generic shape below maps
> field-for-field. Contact `dev@kolm.ai` if you want a tenant-specific shape.

### Shared status mapping

| kolm control status | Drata `status` | Vanta `status` |
|---|---|---|
| pass | `PASSED` | `OK` |
| attention | `NEEDS_ATTENTION` | `NEEDS_ATTENTION` |
| blocking / fail | `FAILED` | `FAILING` |
| not assessed | `NOT_ASSESSED` | `NOT_ASSESSED` |

### Drata payload shape

```jsonc
{
  "$schema": "kolm-control-evidence/1",
  "format": "drata-external-evidence",
  "source": {
    "vendor": "kolm.ai",
    "product": "Agent Security-Review",
    "report_id": "asrr_…",
    "report_schema": "kolm-audit-report-1",
    "report_version": "asr-report/0.1",
    "spec_version": "asr-audit/0.1",
    "generated_at": "2026-…Z",
    "subject": "Acme Inc",
    "tier": "report",
    "watermark": false
  },
  "verification": {
    "algorithm": "ed25519",
    "spec": "kolm-ed25519-v1",
    "key_fingerprint": "…",
    "signed_at": "2026-…Z",
    "verify_url": "https://kolm.ai/verify",
    "offline_verifiable": true,
    "instructions": "Re-verify the source report …"
  },
  "summary": {
    "readiness_pct": 0,
    "blocking_count": 6,
    "total_findings": 6,
    "tamper_evident": false,
    "by_severity": { "critical": 0, "high": 6, "medium": 0, "low": 0, "info": 0 }
  },
  "evidence": [
    {
      "name": "Agent Security-Review - SOC 2 TSC CC6",
      "framework": "SOC 2 TSC",
      "control": "CC6",
      "controlName": "Logical access controls / least privilege",
      "status": "FAILED",
      "severity": "high",
      "evidenceType": "automated",
      "collectedAt": "2026-…Z",
      "sourceUrl": "https://kolm.ai/verify",
      "description": "… - N finding(s) from the kolm signed Agent Security-Review report.",
      "findings": [ { "id": "over-permission", "severity": "high", "title": "…" } ]
    }
    // … one per ASR + implicated framework control
  ],
  "caveats": [ "…" ],
  "mapping_note": "…"
}
```

### Vanta payload shape

```jsonc
{
  "$schema": "kolm-control-evidence/1",
  "format": "vanta-custom-evidence",
  "source": { /* same as Drata */ },
  "verification": { /* same as Drata */ },
  "summary": { /* same as Drata */ },
  "controls": [
    {
      "framework": "SOC 2 TSC",
      "controlId": "CC6",
      "controlName": "Logical access controls / least privilege",
      "status": "FAILING",
      "severity": "high",
      "findingsCount": 2,
      "findings": [ { "id": "over-permission", "severity": "high", "title": "…" } ],
      "evidenceUrl": "https://kolm.ai/verify",
      "collectedAt": "2026-…Z"
    }
    // … one per ASR + implicated framework control
  ],
  "caveats": [ "…" ],
  "mapping_note": "…"
}
```

**Import into Drata:** create/locate the control, then attach the evidence via
*External Evidence* (API or UI) using each item's `control` + `status`; the
`sourceUrl` points reviewers back to the offline verifier.

**Import into Vanta:** attach each `controls[]` record as custom/external
evidence on the matching control via the Integrations/custom-evidence API; the
`evidenceUrl` is the offline verifier.

---

## Executive summary (`format=exec`)

A crisp one-page Markdown brief for a deal sponsor: subject + report id + tier,
a plain-language verdict, an at-a-glance metrics table, the control-status table
(with not-assessed controls disclosed), the top findings, the priority
remediation, the scope & limitations, and the verification line (fingerprint +
offline verify URL). Paste into a deal room, a Notion page, or a PDF print.

---

## Framework crosswalk (`format=crosswalk`)

A control-by-control crosswalk in Markdown, in two parts:

1. **ASR control coverage** — a matrix with one row per ASR control and one
   column per buyer framework; each cell lists the framework control ids
   implicated **by findings in this run** (a blank cell means no finding touched
   that framework for that control), plus the control's status and finding count.
2. **Framework control detail** — one row per implicated framework control:
   framework, control, what it covers, finding count, worst severity.

This is the artifact a reviewer uses to confirm "your ASR-1 least-privilege
finding maps to SOC 2 CC6, ISO/IEC 42001 A.9, NIST MANAGE-1/MAP-2, EU AI Act
Art.14, OWASP LLM08/ASI, …".

---

## The control-evidence schema (`kolm-control-evidence/1`)

The internal record every Drata/Vanta item is derived from:

```jsonc
{
  "framework": "SOC 2 TSC",            // framework display name (or "ASR (kolm Agent Security Readiness)")
  "controlId": "CC6",                  // control id within that framework
  "controlName": "…",                  // human label / what it covers
  "status": "pass|attention|fail|not_assessed",
  "severity": "high|medium|low|null",  // worst severity touching the control, or null
  "findingsCount": 2,
  "findings": [ { "id": "…", "severity": "…", "title": "…" } ]
}
```

Drata re-keys `controlId → control`, `status →` the Drata vocabulary, and wraps
it as an `evidence[]` item; Vanta keeps `controlId` and uses the Vanta status
vocabulary in a `controls[]` array. Both carry `source`, `verification`,
`summary`, `caveats`, and a `mapping_note` so the import is self-describing.

---

## Contact

Questions about a tenant-specific import shape: `dev@kolm.ai`.
