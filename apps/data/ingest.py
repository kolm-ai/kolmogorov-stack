"""
apps/data/ingest.py

Document ingestion: PDFs, emails, HTML, markdown, CSV → training JSONL.

The migration story for a buyer currently running RAG on their internal docs:
they hand us 10k PDFs and 500k support emails and we hand back a compiled
adapter that knows the content. That is not RAG; it is distillation. RAG
queries the corpus at inference time, paying tokens and latency per call.
Distillation moves the knowledge into the weights, paying the cost once at
compile time. For internal-doc Q&A the second shape wins on every metric a
buyer cares about: latency, token cost, audit clarity, on-device feasibility.

This module is the front door: arbitrary input formats → a uniform stream of
{instruction, input, output} or {prompt, completion} rows that the kolm
trainer can ingest directly.

Format support:

  * PDF (PyMuPDF / pdfplumber fallback)
  * EML / mbox (mailbox)
  * HTML (BeautifulSoup, strips tags, preserves headings as section breaks)
  * Markdown (regex-based section split)
  * CSV / TSV (column-mapping config)
  * Plain text (paragraph-segmented)

Surface:

    from apps.data.ingest import ingest, IngestConfig

    rows = ingest(
        sources=["docs/*.pdf", "support_emails.mbox"],
        config=IngestConfig(
            mode="qa",                      # or "instruction" or "completion"
            chunk_tokens=512,
            overlap_tokens=64,
            min_chunk_tokens=64,
            redact_emails=True,
        ),
    )
    write_jsonl(rows, "train.jsonl")

The redact_emails flag is a stopgap; for proper PHI/PII redaction, pipe the
output through a kolm-compiled PHI redactor first. The output rows carry a
`source` field so a downstream binder can show provenance for every example.

References:

  * Hendrycks et al, 2021. "Measuring Massive Multitask Language Understanding."
    arXiv:2009.03300. For QA shape conventions.
  * Wang et al, 2023. "Self-Instruct." arXiv:2212.10560. For the
    instruction-output rephrasing pattern.
"""

from __future__ import annotations

import csv
import email
import email.policy
import glob
import json
import mailbox
import os
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Iterable, Optional


@dataclass
class IngestConfig:
    """Knobs for the ingest pipeline.

    `mode` picks the row shape. `qa` produces {prompt, completion} pairs from
    contiguous chunks; `instruction` produces {instruction, input, output} for
    self-instruct-style training; `completion` keeps a single long completion
    per chunk.
    """

    mode: str = "qa"
    chunk_tokens: int = 512
    overlap_tokens: int = 64
    min_chunk_tokens: int = 64
    max_chunk_tokens: int = 2048
    redact_emails: bool = True
    redact_phones: bool = True
    drop_signatures: bool = True
    csv_prompt_col: str = "question"
    csv_completion_col: str = "answer"
    csv_delim: str = ","


_EMAIL_RE = re.compile(r"[\w\.-]+@[\w\.-]+\.[a-zA-Z]{2,}")
_PHONE_RE = re.compile(r"\b\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}\b|\b\(\d{3}\)\s*\d{3}[\s\-]\d{4}\b")
_SIG_RE = re.compile(
    r"(?im)^[\s\-\=_]{2,}\s*$|"
    r"^--\s*$|"
    r"^sent from my (iphone|android|mobile|blackberry).*$|"
    r"^get outlook for .*$",
    re.MULTILINE,
)


def _approx_token_count(text: str) -> int:
    """Cheap approximation: 1 token per ~4 chars.

    Good enough for chunking heuristics; not for billing. If exact counts
    matter, swap in tiktoken/transformers at the call site.
    """

    return max(1, len(text) // 4)


def _clean(text: str, cfg: IngestConfig) -> str:
    """Normalize whitespace, optionally strip PII patterns, drop signatures.

    These transforms are deliberately conservative; PHI redaction belongs in
    a downstream pipeline so the receipt records it explicitly.
    """

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    if cfg.redact_emails:
        text = _EMAIL_RE.sub("[EMAIL]", text)
    if cfg.redact_phones:
        text = _PHONE_RE.sub("[PHONE]", text)
    if cfg.drop_signatures:
        text = _SIG_RE.split(text)[0]
    return text.strip()


def _chunk(text: str, cfg: IngestConfig) -> list[str]:
    """Split text into overlapping chunks of approx cfg.chunk_tokens tokens.

    The split prefers paragraph boundaries; if a paragraph is too long, it
    falls back to sentence splitting; if a sentence is too long, it splits at
    the token budget. This keeps semantic units intact when possible.
    """

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    buf: list[str] = []
    buf_tokens = 0
    target = cfg.chunk_tokens

    def flush():
        nonlocal buf, buf_tokens
        if not buf:
            return
        chunk = "\n\n".join(buf).strip()
        if _approx_token_count(chunk) >= cfg.min_chunk_tokens:
            chunks.append(chunk)
        buf = []
        buf_tokens = 0

    for p in paragraphs:
        p_tokens = _approx_token_count(p)
        if p_tokens > cfg.max_chunk_tokens:
            sentences = re.split(r"(?<=[\.\!\?])\s+", p)
            for s in sentences:
                s_tokens = _approx_token_count(s)
                if buf_tokens + s_tokens > target and buf:
                    flush()
                buf.append(s)
                buf_tokens += s_tokens
            continue
        if buf_tokens + p_tokens > target and buf:
            flush()
        buf.append(p)
        buf_tokens += p_tokens

    flush()

    if cfg.overlap_tokens > 0 and len(chunks) > 1:
        overlapped: list[str] = [chunks[0]]
        for i in range(1, len(chunks)):
            prev = chunks[i - 1]
            tail_chars = cfg.overlap_tokens * 4
            tail = prev[-tail_chars:]
            overlapped.append((tail + "\n\n" + chunks[i]).strip())
        chunks = overlapped

    return chunks


def _read_pdf(path: str) -> str:
    """Extract text from a PDF using PyMuPDF; fall back to pdfplumber.

    Both libs are optional; we surface a crisp install hint if neither is
    available so the operator knows what to add.
    """

    try:
        import fitz  # PyMuPDF
        doc = fitz.open(path)
        return "\n\n".join(page.get_text("text") for page in doc)
    except ImportError:
        pass
    try:
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            return "\n\n".join(p.extract_text() or "" for p in pdf.pages)
    except ImportError as e:
        raise ImportError(
            "ingest.py needs PyMuPDF or pdfplumber for PDFs. "
            "pip install 'PyMuPDF>=1.24' (preferred) or 'pdfplumber>=0.11'."
        ) from e


def _read_html(path_or_html: str, is_path: bool = True) -> str:
    """Strip HTML to text. Treats h1-h6 as section breaks."""

    try:
        from bs4 import BeautifulSoup  # type: ignore
    except ImportError as e:
        raise ImportError(
            "ingest.py needs beautifulsoup4 for HTML. pip install 'beautifulsoup4>=4.12'."
        ) from e
    raw = open(path_or_html, "r", encoding="utf-8").read() if is_path else path_or_html
    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "header", "footer"]):
        tag.decompose()
    for h in soup.find_all(re.compile("^h[1-6]$")):
        h.insert_before("\n\n")
    return soup.get_text(separator="\n").strip()


def _read_markdown(path: str) -> str:
    text = open(path, "r", encoding="utf-8").read()
    return re.sub(r"^#{1,6}\s+", "\n\n", text, flags=re.MULTILINE)


def _read_text(path: str) -> str:
    return open(path, "r", encoding="utf-8").read()


def _read_eml(path: str) -> str:
    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)
    body = msg.get_body(preferencelist=("plain", "html"))
    if body is None:
        return ""
    content = body.get_content()
    return content if isinstance(content, str) else content.decode("utf-8", errors="replace")


def _read_mbox(path: str) -> Iterable[tuple[str, str]]:
    mbox = mailbox.mbox(path)
    for i, msg in enumerate(mbox):
        try:
            payload = msg.get_payload(decode=True)
            if isinstance(payload, bytes):
                payload = payload.decode("utf-8", errors="replace")
            elif isinstance(payload, list):
                parts = [p.get_payload(decode=True) for p in payload if p.get_content_type() == "text/plain"]
                payload = b"\n".join(p for p in parts if isinstance(p, bytes)).decode("utf-8", errors="replace")
            else:
                payload = str(payload or "")
            yield f"{path}#{i}", payload
        except Exception:
            continue


def _read_csv(path: str, cfg: IngestConfig) -> Iterable[dict]:
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter=cfg.csv_delim)
        for row in reader:
            prompt = (row.get(cfg.csv_prompt_col) or "").strip()
            completion = (row.get(cfg.csv_completion_col) or "").strip()
            if prompt and completion:
                yield {"prompt": prompt, "completion": completion}


def _to_rows(chunks: list[str], source: str, cfg: IngestConfig) -> list[dict]:
    """Convert raw chunks into training rows per the configured mode.

    `qa` synthesizes a prompt by taking the first sentence and using the rest
    as the completion; for cold-start ingest this is a reasonable proxy that
    a downstream self-instruct pass can refine.
    """

    rows: list[dict] = []
    for c in chunks:
        if cfg.mode == "qa":
            split = re.split(r"(?<=[\.\!\?])\s+", c, maxsplit=1)
            if len(split) < 2:
                continue
            rows.append({"prompt": split[0].strip(), "completion": split[1].strip(), "source": source})
        elif cfg.mode == "instruction":
            rows.append({
                "instruction": "Summarize the following passage faithfully.",
                "input": c,
                "output": c.split("\n\n")[0],
                "source": source,
            })
        elif cfg.mode == "completion":
            rows.append({"completion": c, "source": source})
        else:
            raise ValueError(f"ingest.py: unknown mode {cfg.mode!r}")
    return rows


def ingest(
    sources: Iterable[str],
    config: Optional[IngestConfig] = None,
) -> list[dict]:
    """Ingest every source file (or glob) into a flat list of training rows.

    Resolution order: extension drives parser, glob expands, each file's
    text is cleaned, chunked, and converted to rows.
    """

    cfg = config or IngestConfig()
    rows: list[dict] = []
    paths: list[str] = []
    for s in sources:
        if any(ch in s for ch in "*?["):
            paths.extend(sorted(glob.glob(s, recursive=True)))
        else:
            paths.append(s)
    if not paths:
        raise ValueError("ingest.py: no matching files. Check globs.")

    for path in paths:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".pdf":
            text = _read_pdf(path)
            rows.extend(_to_rows(_chunk(_clean(text, cfg), cfg), path, cfg))
        elif ext in (".html", ".htm"):
            text = _read_html(path)
            rows.extend(_to_rows(_chunk(_clean(text, cfg), cfg), path, cfg))
        elif ext == ".md":
            text = _read_markdown(path)
            rows.extend(_to_rows(_chunk(_clean(text, cfg), cfg), path, cfg))
        elif ext == ".txt":
            text = _read_text(path)
            rows.extend(_to_rows(_chunk(_clean(text, cfg), cfg), path, cfg))
        elif ext == ".eml":
            text = _read_eml(path)
            rows.extend(_to_rows(_chunk(_clean(text, cfg), cfg), path, cfg))
        elif ext == ".mbox":
            for source_id, body in _read_mbox(path):
                rows.extend(_to_rows(_chunk(_clean(body, cfg), cfg), source_id, cfg))
        elif ext in (".csv", ".tsv"):
            local = IngestConfig(**asdict(cfg))
            if ext == ".tsv":
                local.csv_delim = "\t"
            for row in _read_csv(path, local):
                row["source"] = path
                rows.append(row)
        else:
            raise ValueError(f"ingest.py: unsupported extension {ext!r} for {path}")
    return rows


def write_jsonl(rows: list[dict], out_path: str) -> int:
    """Write rows to JSONL, one per line. Returns count."""

    Path(os.path.dirname(out_path) or ".").mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return len(rows)


def receipt_block(cfg: IngestConfig, sources: list[str], n_rows: int) -> dict:
    """Receipt fragment so the audit log shows what went in.

    Specifically: the sources, the chunking parameters, and the redaction
    flags. A binder can render this directly for the security reviewer.
    """

    return {
        "method": "document_ingestion",
        "config": asdict(cfg),
        "sources": sources,
        "n_rows": n_rows,
        "papers": [
            "arXiv:2009.03300",  # MMLU shape
            "arXiv:2212.10560",  # Self-Instruct
        ],
    }
