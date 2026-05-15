// HIPAA Safe Harbor §164.514(b)(2) — 18 identifier categories.
//
// Order matters: longer / more specific patterns must run first so we
// do not partially redact a longer span. Each entry is { name, tag, regex }.
// The tag is the replacement; the name is the audit-log category.

export const PHI_PATTERNS = [
  // Insurer-labeled policy IDs first so SSN does not steal them.
  { name: "policy_named", tag: "[POLICY]",
    regex: /\b(?:BCBS|HUM|UHC|AETNA|CIGNA|KAISER|MEDICARE|MEDICAID)[\s\-]*[A-Z0-9][A-Z0-9\-]{2,18}/gi },
  { name: "policy_member", tag: "[POLICY]",
    regex: /\b(?:Member ID|member id|Member|member|Policy|policy|Group|group)\s*[:#]?\s*[A-Z0-9][A-Z0-9\-]{3,18}/g },

  // SWIFT-style + URLs + emails — high-specificity, run early.
  { name: "email",     tag: "[EMAIL]",   regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: "url",       tag: "[URL]",     regex: /\bhttps?:\/\/[^\s)]+/gi },

  // VIN — exactly 17 alphanums.
  { name: "vin",       tag: "[VIN]",     regex: /\b[A-HJ-NPR-Z0-9]{17}\b/g },

  // SSN — only after policy patterns have consumed BCBS-991-22-3344 etc.
  { name: "ssn",       tag: "[SSN]",     regex: /(?<![A-Z\-])\b\d{3}-\d{2}-\d{4}\b(?![A-Z\-])/g },

  // MRN — label-bounded.
  { name: "mrn",       tag: "[MRN]",     regex: /\bMRN[:\s#-]*[A-Z0-9][A-Z0-9\-]{3,15}/gi },

  // Account / member numeric — label-bounded.
  { name: "account",   tag: "[ACCT]",    regex: /\b(?:acct|account)[:\s#-]*[A-Z0-9][A-Z0-9\-]{2,12}/gi },
  { name: "member_id", tag: "[ID]",      regex: /\bmember\s+(?!ID|id)[A-Z0-9][A-Z0-9\-]{3,15}/gi },

  // IPs.
  { name: "ip",        tag: "[IP]",      regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },

  // Device identifiers.
  { name: "device",    tag: "[DEVICE]",  regex: /\b(?:Device|device)\s+(?:serial\s+)?[A-Z]{1,4}[-]?\d{3,10}/g },

  // Phones.
  { name: "phone",     tag: "[PHONE]",   regex: /\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },

  // Geographic — city + state + zip (run before plain zip).
  { name: "geo_full",  tag: "[GEO]",     regex: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\s+(?:St|St\.|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Lane|Ln|Dr|Drive|Way|Pkwy|Parkway),?\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g },
  { name: "geo_city",  tag: "[GEO]",     regex: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g },
  { name: "geo_zip",   tag: "[GEO]",     regex: /\b\d{5}(?:-\d{4})?\b/g },

  // Dates — full forms first, then long-form, then "Month D YYYY",
  // then a defensive trailing year.
  { name: "date_iso",  tag: "[DATE]",    regex: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g },
  { name: "date_us",   tag: "[DATE]",    regex: /\b\d{1,2}\/\d{1,2}\/(?:19|20)?\d{2}\b/g },
  { name: "date_long", tag: "[DATE]",    regex: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(?:19|20)\d{2}\b/gi },
  { name: "date_year_after",  tag: "[DATE]", regex: /\b(?:from|on|in|since|until)\s+((?:19|20)\d{2})\b/gi },

  // Names — bias toward precision over recall. We catch the cases that
  // are unambiguously a person's name (titled, initialed, label-bounded)
  // and accept that the LoRA-tier upgrade catches the rest. Auditor copy
  // explicitly documents this tradeoff in evidence.md.
  { name: "name_titled", tag: "[NAME]",
    regex: /\b(?:Dr|Mr|Mrs|Ms)\.?\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g },
  { name: "name_initial", tag: "[NAME]",
    regex: /\b[A-Z]\.\s*[A-Z][a-z]+\b/g },
  { name: "name_intro",  tag: "[NAME]",
    regex: /\b(?:Patient|Member|patient is|this is)\s*:?\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/g },
  { name: "name_between", tag: "[NAME]",
    regex: /\b(?:between|with|signed by)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/gi },
  { name: "name_signoff", tag: "[NAME]",
    regex: /\b(?:Surgeon|Pharmacist|Rep|Teller|Nurse|Notify):\s*([A-Z]\.?\s*[A-Z][a-z]+(?:,\s*[A-Z][a-zA-Z]+)?)/g },
  // Comma-rule name: "Firstname Lastname, DOB" / "Firstname Lastname (acct"
  // — these are the high-signal punctuation slots clinical text uses.
  { name: "name_comma",  tag: "[NAME]",
    regex: /\b([A-Z][a-z]+\s+[A-Z][a-z]+)(?=\s*[,(]\s*(?:DOB|MRN|acct|account|member|policy|group|insurance|aged|age|y\/o))/gi },
  // Greeting: "Hi/Dear NAME"
  { name: "name_greet",  tag: "[NAME]",
    regex: /\b(?:Hi|Dear|Hello)\s+(?:Dr\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g },
];

/**
 * Run patterns in order against `text`. Returns the redacted text plus a
 * list of redactions for the audit log: { name, tag, length }.
 */
export function redact(text) {
  if (typeof text !== "string") return { text: "", redactions: [] };
  let working = text;
  const redactions = [];
  for (const pat of PHI_PATTERNS) {
    pat.regex.lastIndex = 0;
    working = working.replace(pat.regex, (match, captured) => {
      // If the pattern uses a label-prefix capture group, replace only the
      // captured span; otherwise replace the whole match. This keeps the
      // human-readable label words intact ("Patient", "Member ID", etc).
      if (typeof captured === "string" && match !== captured) {
        const idx = match.indexOf(captured);
        redactions.push({ name: pat.name, tag: pat.tag, length: captured.length });
        return match.slice(0, idx) + pat.tag + match.slice(idx + captured.length);
      }
      redactions.push({ name: pat.name, tag: pat.tag, length: match.length });
      return pat.tag;
    });
  }
  // Collapse adjacent identical tags (e.g. [NAME][NAME]) into one.
  working = working.replace(/(\[[A-Z]+\])(\s*\1)+/g, "$1");
  return { text: working, redactions };
}
