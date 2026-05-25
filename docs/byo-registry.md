# BYO Registry — publishing .kolm artifacts outside the kolm.ai hub

kolm publishes to its own hub by default (`kolm publish foo.kolm`), but the
.kolm format is designed to round-trip through any object store. This page
documents the three most common BYO patterns. The artifact's signature +
receipt travel inside the zip — recipients can always verify provenance with
`kolm verify` regardless of how the bytes arrived.

## Why this works

A `.kolm` artifact is a signed zip:

```
foo.kolm
├── manifest.json        # model_id, base, quant, license, sizes
├── receipt.json         # build inputs, teacher refs, eval scores
├── signature            # ed25519 over (manifest || receipt || weights digest)
├── pubkey               # publisher's ed25519 public key
└── weights/             # pointer or embedded shards
```

The signature covers the contents, not the transport. You can move the bytes
through any registry, blob store, USB stick, or email attachment — `kolm
verify foo.kolm` only cares about what's inside.

---

## 1. Docker / OCI registry (GHCR, ECR, Docker Hub, Harbor)

Two flavors: ship the .kolm as a layer inside a wrapper image, or push it as
a bare OCI artifact with no image at all.

### 1a. Dockerfile wrapper (works with every registry, no extra CLI)

```dockerfile
# Dockerfile
FROM scratch
COPY foo.kolm /foo.kolm
LABEL org.opencontainers.image.title="my-distilled-7b"
LABEL org.opencontainers.image.source="https://github.com/my-org/my-models"
LABEL ai.kolm.artifact="true"
LABEL ai.kolm.format="kolm/v1"
```

Build and push:

```bash
docker buildx build \
  --platform linux/amd64 \
  --tag ghcr.io/my-org/my-distilled-7b:v1 \
  --push \
  .
```

Pull and extract on the consumer side:

```bash
docker create --name tmp ghcr.io/my-org/my-distilled-7b:v1
docker cp tmp:/foo.kolm ./foo.kolm
docker rm tmp
kolm verify ./foo.kolm
```

### 1b. ORAS — push the bare .kolm as an OCI artifact (no wrapper)

ORAS lets you push arbitrary files as OCI artifacts. No empty `FROM scratch`
image, no `docker cp` dance.

```bash
# Login to your registry once
oras login ghcr.io -u <user> -p <github-pat>

# Push the .kolm + its manifest as an OCI artifact
oras push ghcr.io/my-org/my-distilled-7b:v1 \
  --artifact-type application/vnd.kolm.artifact.v1+zip \
  foo.kolm:application/vnd.kolm.artifact.v1+zip \
  manifest.json:application/vnd.kolm.manifest.v1+json
```

Pull on the consumer side:

```bash
oras pull ghcr.io/my-org/my-distilled-7b:v1 -o ./
kolm verify ./foo.kolm
```

### Verifying after round-trip

```bash
kolm verify ./foo.kolm
# expected:
#   signature: ok (ed25519, pubkey 4f3b...)
#   receipt:   ok (build_id rcpt_8c2..., teachers: [claude-4.7, gpt-5])
#   manifest:  ok (model_id my-org/my-distilled-7b, quant int4)
```

**Note on `kolm import <oci-url>`:** today `kolm import` covers HF / GGUF /
safetensors model ingestion, *not* OCI-registry pulls of .kolm artifacts.
Use `oras pull` (or `docker cp` for the wrapper pattern) until native OCI
pull lands. The verify step is unchanged either way.

---

## 2. Hugging Face Hub

HF Hub stores arbitrary files in a git-LFS-backed repo. You can upload the
.kolm directly, but most HF consumers expect a flat directory of weights +
config — so eject first.

```bash
# Authenticate once
huggingface-cli login

# Eject the .kolm to a flat directory (weights/, manifest.json, receipt.json, signature)
kolm eject foo.kolm --out ./ejected-foo/

# Optional: keep a copy of the original .kolm alongside, so consumers can verify
cp foo.kolm ./ejected-foo/foo.kolm

# Create the repo and upload
huggingface-cli repo create my-distilled-7b --type model
huggingface-cli upload my-org/my-distilled-7b ./ejected-foo/
```

Pull on the consumer side:

```bash
huggingface-cli download my-org/my-distilled-7b --local-dir ./pulled/
kolm verify ./pulled/foo.kolm
```

Or use the ejected layout directly with kolm:

```bash
kolm run ./pulled/   # works against ejected directory, no zip needed
```

### Why eject?

HF discovery, model cards, and `transformers`/`vllm` autoloaders all assume a
flat directory layout. Shipping the `.kolm` alone works for kolm consumers
but isolates you from the HF ecosystem. Shipping both gives you both
audiences without duplicating the actual weight bytes (HF git-LFS dedupes by
content hash).

### Verifying after round-trip

```bash
kolm verify ./pulled/foo.kolm
# OR, against the ejected dir:
kolm verify --from-dir ./pulled/
# both check the same ed25519 signature against the same content digest
```

---

## 3. Object stores (S3 / GCS / Azure Blob)

The simplest pattern. No registry semantics, no manifest format, no auth
flow beyond the cloud provider's native credentials. The artifact is just
bytes; the signature is inside the bytes.

### AWS S3

```bash
aws s3 cp foo.kolm s3://my-bucket/artifacts/my-distilled-7b/v1/foo.kolm

# Generate a signed pull URL (valid 1 hour)
aws s3 presign s3://my-bucket/artifacts/my-distilled-7b/v1/foo.kolm \
  --expires-in 3600
```

### Google Cloud Storage

```bash
gsutil cp foo.kolm gs://my-bucket/artifacts/my-distilled-7b/v1/foo.kolm

# Signed URL (valid 1 hour)
gsutil signurl -d 1h ~/.config/gcloud/key.json \
  gs://my-bucket/artifacts/my-distilled-7b/v1/foo.kolm
```

### Azure Blob

```bash
az storage blob upload \
  --account-name myaccount \
  --container-name artifacts \
  --name my-distilled-7b/v1/foo.kolm \
  --file foo.kolm

# Signed URL via SAS token (valid 1 hour)
az storage blob generate-sas \
  --account-name myaccount \
  --container-name artifacts \
  --name my-distilled-7b/v1/foo.kolm \
  --permissions r \
  --expiry $(date -u -d '1 hour' '+%Y-%m-%dT%H:%MZ') \
  --full-uri
```

### Pull on the consumer side

```bash
curl -fSL "<signed-url>" -o foo.kolm
kolm verify foo.kolm
```

That's the whole flow. No catalog, no manifest indirection — the bucket
prefix *is* your namespace, the object key *is* your version.

### Verifying after round-trip

```bash
kolm verify foo.kolm
# signature: ok
# receipt:   ok
# manifest:  ok
```

If the bytes were corrupted in transit, `kolm verify` exits non-zero with
`signature: bad` and prints the expected vs computed content digest.

---

## Choosing a pattern

| Pattern         | Best for                                | Auth                  | Discovery surface         |
|-----------------|-----------------------------------------|-----------------------|---------------------------|
| OCI registry    | Internal tools, k8s clusters, CI/CD     | Registry creds        | Tags, labels, OCI listing |
| Hugging Face    | Public release, ecosystem integration   | HF token              | Model card, search, likes |
| Object store    | Largest artifacts, signed-URL handoff   | Cloud IAM             | Bucket prefix conventions |

All three round-trip the same signature. Pick by audience and existing
infra — there is no kolm-side lock-in.

## What `kolm verify` actually checks

1. The zip parses and contains `manifest.json`, `receipt.json`, `signature`,
   `pubkey`.
2. `signature` is a valid ed25519 signature by `pubkey` over the canonical
   bytes of (`manifest.json` || `receipt.json` || weights content digest).
3. The weights content digest in the receipt matches the actual bytes in
   `weights/` (or the resolved pointer, for pointer-mode artifacts).
4. The `pubkey` is either pinned in the consumer's trust store
   (`~/.kolm/trusted-keys/`) or accompanied by a hub-signed attestation if
   pulled from kolm.ai.

For BYO transports, step 4 is your responsibility: distribute the publisher
pubkey out-of-band (your org's keybase, an HTTPS endpoint, a git repo with
signed commits) and pin it in consumers via `kolm trust add <pubkey>`.

## Caveats

- **`kolm import <oci-url>` is not yet implemented.** Use `oras pull` /
  `docker cp` / `curl` to fetch the bytes, then `kolm verify` and
  `kolm run` against the local file. Native OCI pull is on the roadmap.
- **Eject is one-way for ejected-only workflows.** Re-zipping an ejected
  directory recomputes content digests but does *not* re-sign — you need
  the original publisher's private key to produce a valid signature. For
  round-trips that need to stay signed, ship the original `.kolm` (which
  is exactly what the patterns above do).
- **Object stores have no content-type negotiation.** Set
  `Content-Type: application/vnd.kolm.artifact.v1+zip` on upload if you
  want browsers and CDN inspectors to recognize the format; it's not
  required for `kolm verify`.
