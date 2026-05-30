# Kolm BYOC — Kubernetes deploy in under an hour

Run the Kolm gateway on a Kubernetes cluster **you** control. State (the
receipts ledger, tenant DB) and the **receipt signing key** live on a
persistent volume, so upgrades and pod restarts never invalidate previously
issued receipts. kolm.ai never touches this runtime.

You have two equivalent paths:

- **Path A — Helm** (fastest; one command).
- **Path B — Terraform** (declarative; wraps the same chart).

Either way the gateway ends up serving `/v1/health` and `/v1/*` on port 8080,
backed by a PVC mounted at `KOLM_DATA_DIR` (`/var/lib/kolm`). The Ed25519
signing key persists under `KOLM_DATA_DIR/keys` on that same volume.

---

## 0. Prerequisites (~10 min)

| Tool       | Version  | Check                  |
| ---------- | -------- | ---------------------- |
| kubectl    | >= 1.25  | `kubectl version`      |
| Helm       | >= 3.10  | `helm version`         |
| Terraform  | >= 1.5   | `terraform version` (Path B only) |
| A cluster  | any      | `kubectl get nodes`    |

You also need:

- A reachable **gateway image** (default `ghcr.io/sneaky-hippo/kolm-gateway`).
  For air-gapped clusters, mirror it into your own registry and override
  `image.repository` / `image.tag`.
- A **StorageClass** that can provision a `ReadWriteOnce` volume
  (`kubectl get storageclass` — most managed clusters ship a default).

### Generate the receipt signing secret (do this once)

This secret is the **root of trust** for receipt verification (the code reads
it as `RECIPE_RECEIPT_SECRET`; the chart injects it under that name). It must be
at least 32 characters and not look like a placeholder, or the gateway refuses
to sign receipts in production. `openssl rand -hex 32` satisfies both. Keep it
safe; losing it means previously issued receipts can no longer be verified.

```bash
export RECEIPT_SECRET="$(openssl rand -hex 32)"
echo "$RECEIPT_SECRET"   # store this in your secrets manager
```

---

## Path A — Helm (~15 min)

From the repo root:

```bash
helm upgrade --install kolm ./deploy/helm/kolm \
  --namespace kolm --create-namespace \
  --set secrets.receiptSecret="$RECEIPT_SECRET" \
  --set persistence.size=10Gi \
  --wait --timeout 10m
```

Optional flags:

| Flag                                         | Purpose                                  |
| -------------------------------------------- | ---------------------------------------- |
| `--set image.tag=<tag>`                      | Pin a specific gateway build.            |
| `--set persistence.storageClass=<sc>`        | Choose a non-default StorageClass.       |
| `--set service.type=LoadBalancer`            | Expose externally via a cloud LB.        |
| `--set gateway.publicUrl=https://kolm.acme`  | URL advertised inside receipts.          |
| `--set byoc.enrollToken=<token>`             | POST an attestation to kolm.ai on boot.  |
| `--set secrets.existingSecret=<name>`        | Use a Secret you manage (Vault/ESO/…).   |

### Verify

```bash
kubectl -n kolm rollout status deploy/kolm
kubectl -n kolm port-forward svc/kolm 8080:80 &
curl -fsS http://127.0.0.1:8080/v1/health     # -> {"ok":true,...}
```

Done. Skip to **Persistence & upgrades**.

---

## Path B — Terraform (~20 min)

The Terraform module at `deploy/terraform` wraps the same Helm chart.

```bash
cd deploy/terraform
terraform init
terraform apply \
  -var "receipt_secret=$RECEIPT_SECRET" \
  -var "kubeconfig=$HOME/.kube/config" \
  -var "persistence_size=10Gi"
```

Common variables (see `main.tf` for the full list):

| Variable             | Default                               | Purpose                       |
| -------------------- | ------------------------------------- | ----------------------------- |
| `receipt_secret`     | —                                     | Signing secret (required).    |
| `existing_secret`    | `""`                                  | Use a pre-made Secret instead.|
| `namespace`          | `kolm`                                | Target namespace.             |
| `image_tag`          | chart appVersion                      | Pin a gateway build.          |
| `storage_class`      | cluster default                       | PVC StorageClass.             |
| `service_type`       | `ClusterIP`                           | `NodePort` / `LoadBalancer`.  |
| `public_url`         | `""`                                  | URL advertised in receipts.   |
| `byoc_enroll_token`  | `""`                                  | Attest back to kolm.ai.       |

### Verify

```bash
terraform output health_check     # prints the exact curl command
```

To remove everything: `terraform destroy`.

---

## Persistence & upgrades (why redeploys are non-destructive)

- The chart provisions one PVC, mounted at `KOLM_DATA_DIR` (`/var/lib/kolm`).
- The signing key (`KOLM_ED25519_KEY_STORE`, default `/var/lib/kolm/keys`) is a
  **subpath of the same volume**, so signing keys persist across pod
  replacement. `fsGroup: 1000` lets the non-root `node` user write the volume.
- The Deployment uses the `Recreate` strategy because the PVC is
  `ReadWriteOnce` — a single pod owns the volume at a time. Upgrades stop the
  old pod, then start the new one against the **same** data and keys.

Upgrade to a new gateway build with no data loss:

```bash
# Helm
helm upgrade kolm ./deploy/helm/kolm --reuse-values --set image.tag=<new-tag>

# Terraform
terraform apply -var "image_tag=<new-tag>" -var "receipt_secret=$RECEIPT_SECRET"
```

> Keep `persistence.enabled=true` (the default). With it disabled the data dir
> is an `emptyDir` and **you lose receipts + the signing key on every restart**.

---

## Exposing the gateway

- **Internal only:** default `ClusterIP`; reach it from other pods at
  `http://kolm.kolm.svc.cluster.local`.
- **Cloud LB:** `--set service.type=LoadBalancer`, then
  `kubectl -n kolm get svc kolm` for the external IP.
- **Ingress/TLS:** front the Service with your own Ingress controller +
  cert-manager. Set `gateway.publicUrl` to the public hostname so receipts
  carry the right URL.

---

## Scaling

The default is a single replica (one pod owns the RWO volume). To run multiple
replicas, point `KOLM_DATA_DIR` at a shared store: provision an RWX volume
(e.g. EFS / Filestore / Azure Files), set
`persistence.accessModes={ReadWriteMany}`, switch the Deployment strategy
inputs accordingly, and raise `replicaCount`. Validate receipt-ledger
concurrency for your workload before scaling out.

---

## Rotating the signing secret

1. Generate a new secret: `openssl rand -hex 32`.
2. Helm: `helm upgrade kolm ./deploy/helm/kolm --reuse-values --set secrets.receiptSecret=<new>`
   (a checksum annotation rolls the pod automatically).
3. Receipts signed with the old secret stay verifiable only if you retain the
   old secret out of band — keep an archive of retired signing secrets.

---

## Uninstall

```bash
# Helm
helm uninstall kolm -n kolm

# Terraform
cd deploy/terraform && terraform destroy
```

> The PVC may be retained depending on your StorageClass reclaim policy. Delete
> it explicitly if you want to discard state:
> `kubectl -n kolm delete pvc kolm-data`.

The default Helm release name `kolm` collapses the resource names to `kolm`
(Deployment, Service) and `kolm-data` (PVC); a different release name prefixes
them as `<release>-kolm`.

---

## Troubleshooting

| Symptom                                   | Fix                                                            |
| ----------------------------------------- | ------------------------------------------------------------- |
| `secrets.receiptSecret is required`       | Pass `--set secrets.receiptSecret=...` or `secrets.existingSecret`. |
| Pod `Pending`, PVC unbound                | No default StorageClass — set `persistence.storageClass`.     |
| `CrashLoopBackOff`                        | `kubectl -n kolm logs deploy/kolm` — usually a bad/missing secret. |
| Readiness never passes                    | Confirm the image serves `GET /v1/health` on `gateway.port` (8080). |
| Pod can't write `KOLM_DATA_DIR`           | Keep `podSecurityContext.fsGroup: 1000` so the volume is group-writable by the non-root `node` user. |
| Two pods stuck on one volume during upgrade | Expected with RWO — the `Recreate` strategy serializes it.  |
