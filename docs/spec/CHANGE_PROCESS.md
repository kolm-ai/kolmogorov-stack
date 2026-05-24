# kolm format change process

STATUS: ACTIVE, 2026-05-24

This document describes how changes to the .kolm artifact format are
proposed, reviewed, and accepted. It applies to every published version of
the format from v1.0 onward.

The change process exists because the .kolm artifact format is a long-lived
trust surface. Customers and auditors need to know that a v1.0 artifact will
still verify in five years, and that any change to the format is debated in
public before it becomes mandatory.

The canonical specification this process governs lives at
`docs/spec/kolm-format-v1.0.md`. When `kolmspec.org` lands, the same text
will be mirrored at `https://kolmspec.org/v1.0/` and the kolm repository
copy will remain the source of truth.

## How to propose

Open an issue on the kolm repository with the title prefix `RFC: ` followed
by a short summary of the proposed change. The issue body MUST include:

- **Motivation** — the concrete problem the change solves. A reproducible
  example is required.
- **Wire-level diff** — exact JSON, byte layout, or zip entry changes.
  Reference the affected sections of `docs/spec/kolm-format-v1.0.md`.
- **Compatibility classification** — patch, minor, or major bump per the
  versioning policy below.
- **Reference implementation plan** — which of the three first-class SDKs
  (`sdk/c/kolm-format.h`, `sdk/python/kolm/format.py`,
  `sdk/rust/src/format.rs`) will gain support, and on what timeline.
- **Test vector plan** — which new fixtures will land under
  `tests/fixtures/format-v1/` (or `tests/fixtures/format-vN/` for major
  bumps), and what they exercise.

RFC issues are tagged `format-rfc` and pinned in the issues list until the
review window closes.

## Review window

Every RFC has a minimum 14-day review window from the day it is opened.
The window exists so external implementers (SDK authors who do not work at
kolm.ai) can read the proposal and surface objections before the change is
final.

During the window, anyone may comment on the issue. The format maintainers
commit to responding to every substantive comment within 72 hours.

A review window may be extended by the format maintainers if substantive
concerns are raised in the final 72 hours of the original window.
Extensions are announced in a top-level comment on the RFC issue and
SHOULD NOT exceed 14 additional days.

## Acceptance criteria

An RFC is accepted only when all of the following are true:

- **Two or more format maintainers** have signed off in the issue thread.
- **At least one new test vector** exists for the new behavior; the vector
  is committed to `tests/fixtures/format-vN/` and its sha256 is added to
  `tests/fixtures/format-v1/MANIFEST.sha256.txt`.
- **Reference implementation parity** exists across all three first-class
  SDKs (C, Python, Rust). Each SDK MUST have a passing test against the
  new vector before the RFC is merged.
- **No unresolved objections** from external implementers remain on the
  issue.
- **The proposed compatibility classification** is verified against the
  diff. A wire change is never accepted under a patch label.

Acceptance is recorded by a maintainer commenting `ACCEPTED` on the issue
and merging the spec PR that implements the change.

## Versioning policy

The format follows semantic versioning:

- **Patch** (1.0.0 -> 1.0.1) — spec clarifications only, no wire change. A
  patch bump never changes parser behavior. A patch RFC may shrink the
  review window to 7 days at maintainer discretion.
- **Minor** (1.0 -> 1.1) — new optional fields; v1.0 readers MUST still
  load v1.1 artifacts by ignoring unknown optional fields. The
  conditional-slot pattern (section 5 of the spec) MUST be honored so
  pre-feature artifacts stay byte-stable.
- **Major** (1.x -> 2.x) — parser break; v1 readers SHOULD warn and MAY
  refuse v2 artifacts. A major bump requires a migration note in
  `public/changelog.html`.

The compatibility classification proposed by the RFC author is reviewed
during the window. If the maintainers reclassify, the RFC is updated and
the 14-day window restarts from the reclassification timestamp.

## Required: two independent reference implementations

A format change is merged only when at least two of the three first-class
SDKs have updated implementations and passing tests against the new
vector. This is the cross-implementation interop gate — it surfaces
spec ambiguities that would otherwise ride to production hidden inside
the canonical (JavaScript) builder.

The third SDK MAY follow within one minor release window. A major bump
requires all three updated before the bump merges.

## How rejections work

An RFC is rejected when one of the following holds:

- The format maintainers reach consensus that the change is not in scope
  for the format (for example, a runtime-only concern that does not
  require a format change).
- A substantive objection from an external implementer remains unresolved
  at the end of the review window and the maintainers find it persuasive.
- The proposed compatibility classification cannot be honored (for
  example, a wire change cannot be expressed as a minor bump and the
  proposer cannot accept the major bump).

Rejections are recorded by a maintainer commenting `REJECTED` on the
issue with a written rationale. Rejected RFCs remain open and
searchable; a rejected RFC may be reopened by submitting a new RFC that
addresses the rejection rationale.

Rejection is not a blocking event for downstream work. The proposer may
implement the change in a fork or a vendor-specific extension; the
format spec simply will not adopt it without a fresh RFC and a fresh
review window.

## References

- Canonical spec: `docs/spec/kolm-format-v1.0.md`
- Test vector manifest: `tests/fixtures/format-v1/MANIFEST.sha256.txt`
- Canonical builder: `src/artifact.js`
- Reference SDKs: `sdk/c/kolm-format.h`, `sdk/python/kolm/format.py`,
  `sdk/rust/src/format.rs`
