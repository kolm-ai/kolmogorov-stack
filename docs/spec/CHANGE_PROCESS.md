# kolm format change process

STATUS: ACTIVE, 2026-05-24

This document describes how changes to the .kolm artifact format are proposed, reviewed, and accepted. It applies to every published version of the format from v1.0 onward.

The change process exists because the .kolm artifact format is a long-lived trust surface. Customers and auditors need to know that a v1.0 artifact will still verify in five years, and that any change to the format is debated in public before it becomes mandatory.

## How to propose

Open an issue on the kolm repository with the title prefix `RFC: ` followed by a short summary of the proposed change. The issue body MUST include:

- Motivation - the concrete problem the change solves.
- Wire-level diff - exact JSON, byte layout, or zip entry changes.
- Compatibility classification - patch, minor, or major bump per the versioning policy.
- Reference implementation plan - which SDKs (C, Python, Rust) will gain support and on what timeline.
- Test vector plan - which new fixtures will land under `tests/fixtures/format-v1/` (or vN for major bumps).

RFC issues are tagged `format-rfc` and pinned in the issues list until the review window closes.

## Review window

Every RFC has a minimum 14-day review window from the day it is opened. The window exists so external implementers (SDK authors who do not work at kolm.ai) can read the proposal and surface objections before the change is final.

During the window, anyone may comment on the issue. The format maintainers commit to responding to every substantive comment within 72 hours.

A review window may be extended by the format maintainers if substantive concerns are raised in the final 72 hours of the original window. Extensions are announced in a top-level comment on the RFC issue and SHOULD NOT exceed 14 additional days.

## Acceptance criteria

An RFC is accepted only when all of the following are true:

- Two or more format maintainers have signed off in the issue thread.
- At least one new test vector exists for the new behavior; the vector is committed to `tests/fixtures/format-vN/` and its sha256 is added to the test vector manifest.
- Reference implementation parity exists across all three first-class SDKs (C, Python, Rust). Each SDK MUST have a passing test against the new vector before the RFC is merged.
- No unresolved objections from external implementers remain on the issue.
- The proposed compatibility classification (patch, minor, or major) is verified against the diff; a wire change is never accepted under a patch label.

Acceptance is recorded by a maintainer commenting `ACCEPTED` on the issue and merging the spec PR that implements the change.

## Versioning policy

The format follows semantic versioning. The full policy lives in `docs/spec/kolm-format-v1.0.md` section 4. A summary:

- Patch (1.0.0 -> 1.0.1) - spec clarifications only, no wire change.
- Minor (1.0 -> 1.1) - new optional fields; v1.0 readers still load v1.1 artifacts.
- Major (1.x -> 2.x) - parser break; v1 readers SHOULD warn and MAY refuse v2 artifacts.

The compatibility classification proposed by the RFC author is reviewed during the window. If the maintainers reclassify, the RFC is updated and the 14-day window restarts from the reclassification timestamp.

## How rejections work

An RFC is rejected when one of the following holds:

- The format maintainers reach consensus that the change is not in scope for the format (for example, a runtime-only concern that does not require a format change).
- A substantive objection from an external implementer remains unresolved at the end of the review window and the maintainers find it persuasive.
- The proposed compatibility classification cannot be honored (for example, a wire change cannot be expressed as a minor bump and the proposer cannot accept the major bump).

Rejections are recorded by a maintainer commenting `REJECTED` on the issue with a written rationale. Rejected RFCs remain open and searchable; a rejected RFC may be reopened by submitting a new RFC that addresses the rejection rationale.

Rejection is not a blocking event for downstream work. The proposer may implement the change in a fork or a vendor-specific extension; the format spec simply will not adopt it without a fresh RFC and a fresh review window.
