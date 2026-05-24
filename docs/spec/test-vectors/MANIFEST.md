# Format v1.0 test vector manifest

STATUS: PLACEHOLDER, 2026-05-24

This manifest lists the conformance test vectors for the kolm format v1.0. Binary fixtures live under `tests/fixtures/format-v1/` in the repo. Expected sha256 values are placeholders until the v1.0 status moves from DRAFT to ACTIVE; see `docs/spec/kolm-format-v1.0.md` for the spec.

| Fixture                                              | Expected sha256 | Status  |
| ---------------------------------------------------- | --------------- | ------- |
| fixtures/format-v1/minimal.kolm                      | PENDING         | PENDING |
| fixtures/format-v1/with-attestation.kolm             | PENDING         | PENDING |
| fixtures/format-v1/with-output-schema.kolm           | PENDING         | PENDING |
| fixtures/format-v1/with-confidential-compute.kolm    | PENDING         | PENDING |
| fixtures/format-v1/with-multimodal.kolm              | PENDING         | PENDING |

When a fixture is generated, replace its row with the canonical sha256 (hex) and update the status to ACTIVE. The conformance test suite reads this manifest and fails fast on any row still marked PENDING.
