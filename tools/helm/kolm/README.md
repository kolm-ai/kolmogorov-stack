# kolm Helm chart

Kubernetes-native deployment for the [kolm.ai](https://kolm.ai) inference
runtime. Ships with an artifact-pulling init container, Prometheus metrics
scrape annotations, an HPA keyed on `inference_queue_depth`, and a
zero-downtime rolling-update strategy with a preStop drain hook.

Wave: **W824** (Kubernetes-native deployment, sub-items W824-1 through W824-6).

## Install

```sh
helm install kolm tools/helm/kolm \
  --set image.repository=ghcr.io/sneaky-hippo/kolm \
  --set image.tag=v1.0.0 \
  --set artifactRegistry.url=oci://ghcr.io/sneaky-hippo/artifacts \
  --set artifactRegistry.secretRef=kolm-registry-pull \
  --set artifactRegistry.artifactId=production-latest
```

Upgrade is rolling (maxSurge=1, maxUnavailable=0) so model swaps are
zero-downtime — `helm upgrade kolm tools/helm/kolm --set artifactRegistry.artifactId=production-v2`
will boot a fresh pod with the new artifact, wait for `/ready/deep` to flip
to 200, then drain the old pod via the `preStop` hook before SIGTERM.

## Uninstall

```sh
helm uninstall kolm
```

The PVC (when `persistence.enabled=true`) is intentionally **not** deleted
by `helm uninstall`. Drop it manually with
`kubectl delete pvc kolm-data` when you actually want the event-store wiped.

## Values reference

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/sneaky-hippo/kolm` | Container image repo. |
| `image.tag` | (Chart.AppVersion) | Container image tag. |
| `image.pullPolicy` | `IfNotPresent` | Standard pull policy. |
| `image.pullSecrets` | `[]` | imagePullSecrets list. |
| `replicaCount` | `2` | Initial replica count (HPA overrides). |
| `service.type` | `ClusterIP` | Service type. ClusterIP-only by design. |
| `service.port` | `3000` | Service-exposed port. |
| `service.targetPort` | `3000` | Container port. |
| `resources.requests.cpu` | `500m` | Per-pod CPU request. |
| `resources.requests.memory` | `1Gi` | Per-pod memory request. |
| `resources.limits.cpu` | `2` | Per-pod CPU limit. |
| `resources.limits.memory` | `4Gi` | Per-pod memory limit. |
| `persistence.enabled` | `true` | Mount a PVC at `KOLM_DATA_DIR`. |
| `persistence.size` | `10Gi` | PVC storage request. |
| `persistence.storageClass` | (cluster default) | StorageClass override. |
| `persistence.accessMode` | `ReadWriteOnce` | PVC access mode. |
| `persistence.mountPath` | `/var/lib/kolm` | Mount path inside the container. |
| `artifactRegistry.url` | `""` | OCI registry URL for `.kolm` artifacts. |
| `artifactRegistry.secretRef` | `""` | K8s Secret holding registry credentials. |
| `artifactRegistry.artifactId` | `production-latest` | Artifact id pulled at init. |
| `hpa.enabled` | `true` | Toggle the HPA. |
| `hpa.minReplicas` | `2` | HPA lower bound. |
| `hpa.maxReplicas` | `20` | HPA upper bound. |
| `hpa.targetQueueDepth` | `50` | Per-pod average inference queue depth target. |
| `rollingUpdate.maxSurge` | `1` | Rolling-update maxSurge. |
| `rollingUpdate.maxUnavailable` | `0` | Rolling-update maxUnavailable (zero-downtime). |
| `preStop.drainSeconds` | `15` | preStop drain delay before SIGTERM. |
| `terminationGracePeriodSeconds` | `60` | Kubelet grace period after SIGTERM. |
| `probes.readiness.path` | `/ready/deep` | W824-2 readiness path (artifact-aware). |
| `probes.liveness.path` | `/health` | Cheap liveness path. |
| `extraEnv` | `[]` | Extra env vars merged into the main container. |

## Endpoints

The chart wires three HTTP endpoints from the kolm runtime into Kubernetes:

* `GET /ready/deep` — readiness gate (W824-2). Returns **200** only when the
  `.kolm` artifact is loaded and warmed; returns **503** during init/cold-start.
  Bound to the readiness probe so traffic never lands on a cold pod.
* `GET /metrics/extended` — Prometheus exposition (W824-3). Aggregates from the
  event-store: `kolm_inferences_total`, `kolm_latency_seconds`,
  `kolm_fallback_rate`, `kolm_inference_queue_depth`.
* `GET /metrics` — pre-existing W730 endpoint, still scraped.

## Operating notes

* The deployment annotation `kolm.ai/artifact-id` changes whenever you
  `--set artifactRegistry.artifactId=...`. That mutation triggers a rolling
  restart automatically (no need to bump image.tag for an artifact swap).
* The Service is `ClusterIP` by design. Add your own Ingress or LoadBalancer
  in front — never expose an unauth'd `/v1/*` directly to the internet.
* Prometheus auto-scrape is enabled via pod annotations; configure your
  `prometheus-adapter` to expose `inference_queue_depth` as an External
  metric for the HPA to consume.

## Wave linkage

This chart is the deploy surface for the wave-cluster:

* **W824-1** — chart structure (this README + `Chart.yaml` + `values.yaml`).
* **W824-2** — `src/k8s-readiness.js` + `/ready/deep`.
* **W824-3** — `/metrics/extended` aggregator.
* **W824-4** — `templates/hpa.yaml` on `inference_queue_depth`.
* **W824-5** — `templates/deployment.yaml` initContainer.
* **W824-6** — `RollingUpdate` strategy + preStop drain hook.
