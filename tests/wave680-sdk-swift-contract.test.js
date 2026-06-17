import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function assertAscii(rel) {
  const text = read(rel);
  assert.doesNotMatch(text, /[^\x00-\x7F]/, `${rel} must stay ASCII-clean for package consumers`);
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 60000,
  });
}

const swift = () => read('packages/sdk-swift/Sources/Kolm/Kolm.swift');

test('W680 Swift SDK exposes the documented configuration API and token bounds', () => {
  const source = swift();
  assertAscii('packages/sdk-swift/Sources/Kolm/Kolm.swift');
  assertAscii('packages/sdk-swift/README.md');
  assertAscii('packages/sdk-swift/Package.swift');

  assert.match(source, /public typealias Configuration = KolmConfiguration/);
  assert.match(source, /public enum KolmLimits/);
  assert.match(source, /public static let defaultMaxTokens = 256/);
  assert.match(source, /public static let maxTokens = 32768/);
  assert.match(source, /fileprivate let MAX_TOKENS = KolmLimits\.maxTokens/);
  assert.match(source, /public func predict\(_ text: String, maxTokens: Int = KolmLimits\.defaultMaxTokens\) throws -> KolmOutput/);
  assert.match(source, /let safeMaxTokens = try normalizeMaxTokens\(maxTokens\)/);
  assert.match(source, /backend\.generate\(prompt: text, maxTokens: safeMaxTokens\)/);
  assert.match(source, /throw KolmError\.invalidInput\("maxTokens must be between 1 and/);

  const readme = read('packages/sdk-swift/README.md');
  assert.match(readme, /from: "0\.2\.6"/);
  assert.match(readme, /Kolm\.Configuration\.shared\.verify = \.strict/);
  assert.match(readme, /Kolm\.Configuration\.shared\.secret = Data/);
});

test('W680 Swift SDK rejects unsafe artifact paths before parsing proof files', () => {
  const source = swift();
  assert.match(source, /isSafeBundleArtifactName/);
  assert.match(source, /trimmingCharacters\(in: \.whitespacesAndNewlines\)/);
  assert.match(source, /trimmed\.contains\("\/"\)/);
  assert.match(source, /trimmed\.contains\("\\\\"\)/);
  assert.match(source, /validateLocalArtifactURL/);
  assert.match(source, /url\.isFileURL/);
  assert.match(source, /artifact URL must be a local file URL/);
  assert.match(source, /artifact URL must point to a regular \.kolm file/);
  assert.match(source, /ArtifactSafety\.validateExtractedTree\(root: work\)/);
  assert.match(source, /fileprivate let MAX_ARTIFACT_FILES = 8192/);
  assert.match(source, /fileprivate let MAX_ARTIFACT_BYTES: UInt64 = 8 \* 1024 \* 1024 \* 1024/);
  assert.match(source, /isSymbolicLinkKey/);
  assert.match(source, /resolvingSymlinksInPath\(\)\.standardizedFileURL/);
  assert.match(source, /artifact entry escapes extraction directory/);
  assert.match(source, /artifact extracted content is too large/);
  assert.match(source, /readJSONObject/);
  assert.match(source, /Data\(contentsOf: url, options: \.mappedIfSafe\)/);
  assert.match(source, /must be a regular file/);
});

test('W680 Swift SDK verification matches current artifact signing semantics', () => {
  const source = swift();
  assert.match(source, /try verifyManifest\(manifest: manifest\)/);
  assert.match(source, /manifest cid is required in strict mode/);
  assert.match(source, /manifest hashes are required when cid is present/);
  assert.match(source, /private static func isValidCid/);
  assert.match(source, /cidv1:sha256:/);
  assert.match(source, /try verifyReceipt\(receipt: receipt, manifest: manifest\)/);
  assert.match(source, /receipt manifest_cid present but manifest has no cid/);
  assert.match(source, /receipt manifest_cid mismatch/);
  assert.match(source, /receipt secret must not be empty/);
  assert.match(source, /receipt signature must be 64 hex characters/);
  assert.match(source, /fileprivate func hexToData/);
  assert.match(source, /HMAC<SHA256>\.isValidAuthenticationCode/);
  assert.match(source, /for key in \["signature", "signature_ed25519", "signature_sigstore"\]/);
});

test('W680 Swift SDK has package and depth verifier wiring', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['verify:sdk-swift'], 'node --test --test-concurrency=1 tests/wave680-sdk-swift-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:sdk-rn && npm run verify:sdk-swift && npm run verify:sdk-kotlin/);

  const release = read('src/package-release-readiness.js');
  assert.match(release, /id: 'sdk-swift'/);
  assert.match(release, /channel: 'swiftpm'/);
  assert.match(release, /checks: \['swift build'\]/);

  const manifest = read('packages/sdk-swift/Package.swift');
  assert.match(manifest, /name: "Kolm"/);
  assert.match(manifest, /\.library\(name: "Kolm", targets: \["Kolm"\]\)/);
  assert.match(manifest, /\.iOS\(\.v17\)/);
  assert.match(manifest, /\.macOS\(\.v14\)/);
  assert.match(manifest, /\.testTarget\(name: "KolmTests"/);
});

test('W680 Swift SDK release-readiness local check is honest about SwiftPM availability', () => {
  const result = runNode([
    'scripts/package-release-readiness.mjs',
    '--run-local-checks',
    '--target=sdk-swift',
    '--summary',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok=true/);
  assert.match(result.stdout, /target.?count=1|targets=1/);
  assert.match(result.stdout, /sdk-swift:swift build: (pass|skipped:tool_unavailable)/);
});
