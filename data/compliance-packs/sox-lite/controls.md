# SOX-lite controls documentation

> Control narrative + walk-through template for SOX 404 testing.
> Buyer's internal-audit / SOX-PMO team owns the final document.

## Control statement

**Control:** Disclosure-language classification model produces deterministic
labels under change control, evaluated against a held-out reference set,
with audit-trail evidence of every recompile and every prediction.

**Risk addressed:** Material misclassification of forward-looking statements,
historical results, or risk factors in MD&A drafts before public filing.

**Frequency:** Continuous (per inference) with monthly re-validation.

## Walk-through

1. **Inputs.** MD&A paragraph from draft filing, classified before review
   by Disclosure Committee.
2. **Processing.** kolm artifact `cidv1:sha256:<hex>` returns one of three
   labels. The artifact is pinned by CID; any change requires a new
   compile and a new change-control ticket.
3. **Outputs.** Label written to ticketing system + audit log. The audit
   log carries: input hash, CID, label, timestamp, user, receipt id.
4. **Reconciliation.** Quarterly: 10% sample re-labeled by senior
   Disclosure Committee member; agreement rate ≥ 0.95 required.

## ITGC dependencies

| ITGC                             | How kolm meets it                              |
| -------------------------------- | ---------------------------------------------- |
| Logical access                   | RBAC on /v1/run; named-user audit log         |
| Change management                | Recompile produces new CID; ticket required    |
| Computer operations              | TEE deploy supported; KOLM_AIRGAP=1 mode      |
| Program development              | Receipt chain proves training stages          |

## Testing procedures (auditor-facing)

| Test                                                           | Evidence                                  |
| -------------------------------------------------------------- | ----------------------------------------- |
| Verify CID matches manifest.hashes                             | `kolm inspect <artifact.kolm>`            |
| Verify receipt signature                                       | `kolm inspect <artifact.kolm> --verify strict` |
| Verify held-out eval re-runs deterministically                 | `kolm eval <cid>`                         |
| Verify access list                                             | /v1/account/team members + roles          |
| Verify recompile audit trail                                   | /v1/audit/log filtered to op=compile      |

## Deficiency triggers

- K-score regression > 0.02 between recompiles
- Held-out macro F1 < 0.88 in monthly re-eval
- Any single user with both "compile" and "approve disclosure" roles
- Audit log gap > 1 hour during reporting period
- Schema compliance < 1.000

Any of these is a deficiency to be remediated before the next attestation
period.

## Sign-off

| Role            | Name | Date |
| --------------- | ---- | ---- |
| Process Owner   |      |      |
| Internal Audit  |      |      |
| External Audit  |      |      |
