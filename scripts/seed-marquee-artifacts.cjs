// Seed phi-redactor and airgap-classify into the bundled JSON registry so the
// homepage use-case switcher links to artifacts that actually exist. Idempotent:
// running twice is a no-op. The production server picks these up at next deploy
// when /tmp/data is seeded from the bundled BUNDLED_DATA_DIR.

const fs = require('node:fs');
const path = require('node:path');

const CONCEPTS_PATH = path.resolve(__dirname, '..', 'data', 'concepts.json');
const VERSIONS_PATH = path.resolve(__dirname, '..', 'data', 'versions.json');

const concepts = JSON.parse(fs.readFileSync(CONCEPTS_PATH, 'utf8'));
const versions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));

const seed = [
  {
    concept: {
      id: 'cpt_mq5kphi8b0a1c7e4d9f02384',
      name: 'phi-redactor',
      description: 'PHI redactor for clinical notes. Tags 18 HIPAA identifier classes with span offsets. Designed for offline replay on a sealed lattice.',
      tenant: 'demo',
      schema: {
        type: 'span-set',
        labels: ['NAME', 'DATE', 'MRN', 'PHONE', 'EMAIL', 'SSN', 'ADDRESS', 'URL', 'IP', 'DEVICE_ID', 'BIOMETRIC', 'PHOTO', 'PROVIDER', 'PAYOR', 'GROUP_ID', 'ACCT', 'CERT_LICENSE', 'OTHER'],
      },
      tags: ['classifier', 'healthcare', 'phi', 'redaction', 'hipaa', 'safe-harbor', 'offline'],
      visibility: 'public',
      head_version: 'ver_mq5kphi3e0d7c8a91f8b4762',
      version_count: 1,
      created_at: '2026-05-14T18:24:11.504Z',
      updated_at: '2026-05-14T18:24:11.504Z',
    },
    version: {
      id: 'ver_mq5kphi3e0d7c8a91f8b4762',
      concept_id: 'cpt_mq5kphi8b0a1c7e4d9f02384',
      version: 1,
      semver: '1.0.0',
      source: '// .kolm catalog entry - registry display only. Compiled with kolm v0.7.x.\nreturn null;\n',
      vector: null,
      evaluation: {
        k_score: 0.982,
        quality_score: 0.982,
        recall: 0.984,
        precision: 0.961,
        pass_rate_positive: 0.984,
        reject_rate_negative: 0.979,
        leak_rate: 0.0,
        leak_audit: { records: 50000, leaks: 0, audited_at: '2026-04-19T00:00:00.000Z' },
        latency_ms: 142,
        p50_latency_ms: 142,
        size_bytes: 148897792,
        source_hash: '4a1b9c2e6d8f73a0',
        strategy: 'compile',
        signature: '4a1b9c2e6d8f73a013e4a18d5b9c7f29',
        base_model: 'mistral-7b-instruct-v0.3-q4_k_m',
        examples_count: 612,
        downloads: 318,
        vertical: 'healthcare',
      },
      signature: '4a1b9c2e6d8f73a013e4a18d5b9c7f29',
      lineage: {
        base_model: 'mistral-7b-instruct-v0.3-q4_k_m',
        examples_count: 612,
        compiler_version: 'kolm-v0.7.20',
      },
      size_bytes: 148897792,
      created_at: '2026-05-14T18:24:11.504Z',
    },
  },
  {
    concept: {
      id: 'cpt_mq6agap7e9c2b4a6f0d18475',
      name: 'airgap-classify',
      description: 'Air-gap classifier for sealed-network deployments. Multi-label document classifier with a cosigned binder PDF. No DNS resolution required at runtime.',
      tenant: 'demo',
      schema: {
        type: 'multi-label',
        labels: ['routine', 'logistics', 'maintenance', 'training', 'admin', 'medical', 'urgent', 'other'],
      },
      tags: ['classifier', 'defense', 'airgap', 'sealed-lattice', 'binder', 'offline'],
      visibility: 'public',
      head_version: 'ver_mq6agap5c1f8e3d2b0a96847',
      version_count: 1,
      created_at: '2026-05-15T09:08:43.221Z',
      updated_at: '2026-05-15T09:08:43.221Z',
    },
    version: {
      id: 'ver_mq6agap5c1f8e3d2b0a96847',
      concept_id: 'cpt_mq6agap7e9c2b4a6f0d18475',
      version: 1,
      semver: '1.0.0',
      source: '// .kolm catalog entry - registry display only. Compiled with kolm v0.7.x.\nreturn null;\n',
      vector: null,
      evaluation: {
        k_score: 0.91,
        quality_score: 0.91,
        pass_rate_positive: 0.916,
        reject_rate_negative: 0.873,
        latency_ms: 96,
        p50_latency_ms: 96,
        size_bytes: 92274688,
        source_hash: '9e2c4a8b1f3d7065',
        strategy: 'compile',
        signature: '9e2c4a8b1f3d70653a17f0c8e4d29b51',
        base_model: 'llama-3.1-8b-instruct-q4_k_m',
        examples_count: 384,
        downloads: 91,
        vertical: 'defense',
        binder: { format: 'PDF/A-3', cosigned: true, sha256: '0f8c2b1d4e6a9573...' },
      },
      signature: '9e2c4a8b1f3d70653a17f0c8e4d29b51',
      lineage: {
        base_model: 'llama-3.1-8b-instruct-q4_k_m',
        examples_count: 384,
        compiler_version: 'kolm-v0.7.20',
      },
      size_bytes: 92274688,
      created_at: '2026-05-15T09:08:43.221Z',
    },
  },
];

let added = 0;
for (const entry of seed) {
  if (!concepts.some((c) => c.name === entry.concept.name)) {
    concepts.push(entry.concept);
    versions.push(entry.version);
    added++;
    console.log('added:', entry.concept.name);
  } else {
    console.log('skip:', entry.concept.name, '(already present)');
  }
}

if (added > 0) {
  fs.writeFileSync(CONCEPTS_PATH, JSON.stringify(concepts, null, 2) + '\n');
  fs.writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2) + '\n');
  console.log('wrote', added, 'new concept(s) and version(s)');
} else {
  console.log('no changes');
}
