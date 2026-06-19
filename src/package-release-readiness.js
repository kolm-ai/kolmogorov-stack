import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PACKAGE_RELEASE_SPEC = 'kolm-package-release-readiness-1';
export const PACKAGE_RELEASE_MANIFEST_SPEC = 'kolm-package-release-manifest-1';

const SECRET_VALUE_RE = /\b(?:ks_[a-z0-9_]{12,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/i;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const RELEASE_ARTIFACT_PATH_RE = /^reports\/releases\/[a-z0-9][a-z0-9._/-]*\.(?:tgz|tar\.gz|zip|whl|deb|crate|vsix|json|jsonl|sig|pem|txt)$/i;

export const PACKAGE_REQUIREMENT_IDS = [
  'runtime-wasm',
  'ios-android-sdk',
  'sdk-depth',
  'one-line-install',
];

export const PACKAGE_RELEASE_TARGETS = [
  {
    id: 'sdk-ts',
    label: 'TypeScript/browser runtime SDK',
    channel: 'npm',
    root: 'packages/sdk-ts',
    manifests: ['package.json', 'tsconfig.json'],
    docs: ['README.md', '../../scripts/verify-sdk-dist.mjs'],
    requirement_ids: ['runtime-wasm', 'sdk-depth'],
    checks: ['npm run build', 'npm pack --dry-run'],
  },
  {
    id: 'sdk-rn',
    label: 'React Native SDK',
    channel: 'npm',
    root: 'packages/sdk-rn',
    manifests: ['package.json'],
    docs: ['README.md', '../../scripts/verify-sdk-dist.mjs'],
    requirement_ids: ['ios-android-sdk', 'sdk-depth'],
    checks: ['npm run build', 'npm pack --dry-run'],
  },
  {
    id: 'attestation-npm',
    label: 'Confidential-compute attestation package',
    channel: 'npm',
    root: 'packages/attestation',
    manifests: ['package.json'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['npm test', 'npm pack --dry-run'],
  },
  {
    id: 'langchain-npm',
    label: 'LangChain JavaScript adapter',
    channel: 'npm',
    root: 'packages/langchain-kolm',
    manifests: ['package.json'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['npm pack --dry-run'],
  },
  {
    id: 'llamaindex-npm',
    label: 'LlamaIndex JavaScript adapter',
    channel: 'npm',
    root: 'packages/llamaindex-kolm',
    manifests: ['package.json'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['npm pack --dry-run'],
  },
  {
    id: 'sdk-python',
    label: 'Python runtime SDK',
    channel: 'pypi',
    root: 'packages/sdk-python',
    manifests: ['pyproject.toml'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['python -m build .', 'node scripts/verify-python-package-dist.mjs --package packages/sdk-python'],
  },
  {
    id: 'langchain-python',
    label: 'LangChain Python adapter',
    channel: 'pypi',
    root: 'packages/python-langchain-kolm',
    manifests: ['pyproject.toml'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['python -m build .', 'node scripts/verify-python-package-dist.mjs --package packages/python-langchain-kolm'],
  },
  {
    id: 'llamaindex-python',
    label: 'LlamaIndex Python adapter',
    channel: 'pypi',
    root: 'packages/python-llamaindex-kolm',
    manifests: ['pyproject.toml'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['python -m build .', 'node scripts/verify-python-package-dist.mjs --package packages/python-llamaindex-kolm'],
  },
  {
    id: 'runtime-rs',
    label: 'Rust verifier/runtime crate',
    channel: 'crates',
    root: 'packages/runtime-rs',
    manifests: ['Cargo.toml'],
    docs: ['README.md'],
    requirement_ids: ['runtime-wasm', 'sdk-depth'],
    checks: ['cargo check', 'cargo package --allow-dirty'],
  },
  {
    id: 'sdk-swift',
    label: 'SwiftPM iOS/macOS SDK',
    channel: 'swiftpm',
    root: 'packages/sdk-swift',
    manifests: ['Package.swift'],
    docs: ['README.md'],
    requirement_ids: ['ios-android-sdk', 'sdk-depth'],
    checks: ['swift build'],
  },
  {
    id: 'sdk-kotlin',
    label: 'Android/Kotlin SDK',
    channel: 'maven',
    root: 'packages/sdk-kotlin',
    manifests: ['build.gradle.kts'],
    docs: ['README.md'],
    requirement_ids: ['ios-android-sdk', 'sdk-depth'],
    checks: ['gradle publishToMavenLocal'],
  },
  {
    id: 'homebrew',
    label: 'Homebrew formula',
    channel: 'homebrew',
    root: 'packages/homebrew',
    manifests: ['kolm.rb'],
    docs: ['README.md'],
    requirement_ids: ['one-line-install'],
    checks: ['brew audit --strict kolm.rb', 'brew install --build-from-source kolm.rb'],
  },
  {
    id: 'apt',
    label: 'Debian/Ubuntu package metadata',
    channel: 'apt',
    root: 'packages/apt',
    manifests: ['kolm.control'],
    docs: ['README.md', '../../scripts/build-deb.mjs'],
    requirement_ids: ['one-line-install'],
    checks: ['node scripts/build-deb.mjs --dry-run --json', 'dpkg-deb --build <staged-kolm-deb>'],
  },
  {
    id: 'winget',
    label: 'Windows winget manifests',
    channel: 'winget',
    root: 'packages/winget',
    manifests: ['kolm.kolm.yaml', 'kolm.kolm.installer.yaml', 'kolm.kolm.locale.en-US.yaml'],
    docs: ['README.md'],
    requirement_ids: ['one-line-install'],
    checks: ['node scripts/validate-winget-manifest.mjs packages/winget'],
  },
  {
    id: 'install-scripts',
    label: 'curl/PowerShell bootstrap installers',
    channel: 'direct-download',
    root: 'scripts',
    manifests: ['install.sh', 'install.ps1'],
    docs: [],
    requirement_ids: ['one-line-install'],
    checks: ['sh -n scripts/install.sh', 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf'],
  },
  {
    id: 'browser-extension',
    label: 'Browser verifier extension',
    channel: 'browser-extension',
    root: 'packages/browser-extension',
    manifests: ['manifest.json'],
    docs: ['README.md', '../../scripts/build-browser-extension.mjs'],
    requirement_ids: ['sdk-depth'],
    checks: ['node scripts/build-browser-extension.mjs --dry-run --json'],
  },
  {
    id: 'vscode-kolm-rag',
    label: 'VS Code RAG extension',
    channel: 'vscode-marketplace',
    root: 'packages/vscode-kolm-rag',
    manifests: ['package.json', 'tsconfig.json'],
    docs: ['README.md'],
    requirement_ids: ['sdk-depth'],
    checks: ['npm pack --dry-run'],
  },
];

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function parseJson(root, rel, failures) {
  try {
    return JSON.parse(read(root, rel));
  } catch (e) {
    failures.push(`invalid_json:${rel}:${String(e.message || e)}`);
    return null;
  }
}

function tomlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return m ? m[1] : null;
}

function hasZeroSha(text) {
  return /\b0{64}\b/.test(text);
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isHttpsUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validSha(v) {
  return typeof v === 'string' && SHA256_RE.test(v) && !/^(?:sha256:)?0{64}$/i.test(v);
}

function normalizeSha(v) {
  return String(v || '').replace(/^sha256:/i, '').toLowerCase();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validReleaseArtifactPath(v) {
  return typeof v === 'string'
    && RELEASE_ARTIFACT_PATH_RE.test(v)
    && !v.includes('..')
    && !v.includes('\\');
}

function parseJsonFile(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function rootVersion(root) {
  try {
    return parseJsonFile(root, 'package.json')?.version || null;
  } catch {
    return null;
  }
}

export function packageReleaseManifestTemplate() {
  return {
    spec: PACKAGE_RELEASE_MANIFEST_SPEC,
    secret_values_included: false,
    generated_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    release_version: 'REPLACE_WITH_VERSION',
    release_notes_url: 'https://kolm.ai/changelog',
    targets: PACKAGE_RELEASE_TARGETS.map((target) => ({
      id: target.id,
      channel: target.channel,
      requirement_ids: target.requirement_ids.slice(),
      version: 'REPLACE_WITH_VERSION',
      published_at: 'REPLACE_WITH_ISO_TIMESTAMP',
      registry_url: null,
      artifact_url: null,
      artifact_path: `reports/releases/${target.id}/artifact.tgz`,
      artifact_sha256: null,
      sbom_path: `reports/releases/${target.id}/sbom.spdx.json`,
      sbom_sha256: null,
      provenance_path: `reports/releases/${target.id}/provenance.intoto.jsonl`,
      provenance_sha256: null,
      signature_bundle_path: `reports/releases/${target.id}/signature-bundle.sig`,
      signature_bundle_sha256: null,
      local_checks_passed: false,
      local_checks: target.checks.slice(),
    })),
  };
}

export function validatePackageReleaseManifest(manifest = {}) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failures.push('manifest:must_be_object');
  if (manifest.spec !== PACKAGE_RELEASE_MANIFEST_SPEC) failures.push(`spec:expected_${PACKAGE_RELEASE_MANIFEST_SPEC}`);
  if (manifest.secret_values_included !== false) failures.push('secret_values_included:must_be_false');
  if (SECRET_VALUE_RE.test(JSON.stringify(manifest))) failures.push('secret_value_detected');
  if (!Array.isArray(manifest.targets)) failures.push('targets:missing_array');
  const rows = Array.isArray(manifest.targets) ? manifest.targets : [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      failures.push('target:must_be_object');
      continue;
    }
    const target = PACKAGE_RELEASE_TARGETS.find((item) => item.id === row.id);
    if (!target) {
      failures.push(`${row.id || 'unknown'}:unknown_target`);
      continue;
    }
    if (seen.has(target.id)) failures.push(`${target.id}:duplicate_target`);
    seen.add(target.id);
    if (row.channel !== target.channel) failures.push(`${target.id}:channel_mismatch`);
    if (!nonEmpty(row.version)) failures.push(`${target.id}:version_missing`);
    if (!nonEmpty(row.published_at) || Number.isNaN(Date.parse(row.published_at))) failures.push(`${target.id}:published_at_invalid`);
    if (!isHttpsUrl(row.registry_url) && !isHttpsUrl(row.artifact_url)) failures.push(`${target.id}:registry_or_artifact_https_url_missing`);
    for (const field of ['artifact_path', 'sbom_path', 'provenance_path', 'signature_bundle_path']) {
      if (!validReleaseArtifactPath(row[field])) failures.push(`${target.id}:${field}_invalid`);
    }
    for (const field of ['artifact_sha256', 'sbom_sha256', 'provenance_sha256', 'signature_bundle_sha256']) {
      if (!validSha(row[field])) failures.push(`${target.id}:${field}_invalid`);
    }
    if (row.local_checks_passed !== true) failures.push(`${target.id}:local_checks_passed_must_be_true`);
    if (Array.isArray(row.requirement_ids)) {
      for (const id of target.requirement_ids) {
        if (!row.requirement_ids.includes(id)) failures.push(`${target.id}:requirement_id_missing:${id}`);
      }
    }
  }
  for (const target of PACKAGE_RELEASE_TARGETS) {
    if (!seen.has(target.id)) failures.push(`${target.id}:target_missing`);
  }
  return {
    spec: PACKAGE_RELEASE_MANIFEST_SPEC,
    ok: failures.length === 0,
    publish_ready: failures.length === 0,
    secret_values_included: false,
    counts: {
      targets: rows.length,
      required_targets: PACKAGE_RELEASE_TARGETS.length,
      complete_targets: failures.length === 0 ? PACKAGE_RELEASE_TARGETS.length : 0,
      failures: failures.length,
    },
    failures,
  };
}

export function validatePackageReleaseArtifacts(root, manifest = {}) {
  const failures = [];
  const rows = Array.isArray(manifest.targets) ? manifest.targets : [];
  for (const row of rows) {
    const id = row && row.id ? row.id : 'unknown';
    for (const [pathField, hashField] of [
      ['artifact_path', 'artifact_sha256'],
      ['sbom_path', 'sbom_sha256'],
      ['provenance_path', 'provenance_sha256'],
      ['signature_bundle_path', 'signature_bundle_sha256'],
    ]) {
      const rel = row && row[pathField];
      if (!validReleaseArtifactPath(rel)) {
        failures.push(`${id}:${pathField}_invalid`);
        continue;
      }
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) {
        failures.push(`${id}:${rel}:missing`);
        continue;
      }
      const actual = sha256Buffer(fs.readFileSync(full));
      if (validSha(row[hashField]) && actual !== normalizeSha(row[hashField])) {
        failures.push(`${id}:${hashField}_mismatch`);
      }
    }
  }
  return {
    ok: failures.length === 0,
    artifact_count: rows.length * 4,
    failures,
  };
}

function validateNpm(root, target, failures, blockers, releaseVersion) {
  const pkg = parseJson(root, path.join(target.root, 'package.json'), failures);
  if (!pkg) return null;
  for (const key of ['name', 'version', 'license']) {
    if (!nonEmpty(pkg[key])) failures.push(`npm_missing_${key}`);
  }
  if (releaseVersion && pkg.version !== releaseVersion) failures.push(`npm_version_mismatch:${pkg.version || 'missing'}!=${releaseVersion}`);
  if (!pkg.main && !pkg.exports) failures.push('npm_missing_main_or_exports');
  const declaredEntries = new Set();
  for (const key of ['main', 'module', 'types', 'typings']) {
    if (nonEmpty(pkg[key])) declaredEntries.add(pkg[key]);
  }
  const collectExports = (v) => {
    if (typeof v === 'string') {
      declaredEntries.add(v);
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    for (const child of Object.values(v)) collectExports(child);
  };
  collectExports(pkg.exports);
  for (const entry of declaredEntries) {
    const rel = String(entry).replace(/^\.\//, '');
    if (rel.length > 0 && !exists(root, path.join(target.root, rel))) {
      failures.push(`npm_missing_declared_entry:${rel}`);
    }
  }
  if (!pkg.repository) blockers.push('repository_metadata_missing');
  if (Array.isArray(pkg.files) && pkg.files.length === 0) failures.push('npm_files_empty');
  if (target.id === 'sdk-rn') {
    const podspec = read(root, path.join(target.root, 'kolm-rn.podspec'));
    const podVersion = (podspec.match(/s\.version\s*=\s*"([^"]+)"/) || [])[1] || null;
    if (releaseVersion && podVersion !== releaseVersion) failures.push(`podspec_version_mismatch:${podVersion || 'missing'}!=${releaseVersion}`);
  }
  return {
    package_name: pkg.name || null,
    version: pkg.version || null,
    license: pkg.license || null,
    repository: pkg.repository || null,
    has_build_script: Boolean(pkg.scripts && pkg.scripts.build),
    has_test_script: Boolean(pkg.scripts && pkg.scripts.test),
  };
}

function validatePyProject(root, target, failures, _blockers, releaseVersion) {
  const rel = path.join(target.root, 'pyproject.toml');
  const text = read(root, rel);
  const name = tomlValue(text, 'name');
  const version = tomlValue(text, 'version');
  if (!text.includes('[project]')) failures.push('pyproject_missing_project_table');
  if (!name) failures.push('pyproject_missing_name');
  if (!version) failures.push('pyproject_missing_version');
  if (releaseVersion && version !== releaseVersion) failures.push(`pyproject_version_mismatch:${version || 'missing'}!=${releaseVersion}`);
  if (!/license\s*=/.test(text)) failures.push('pyproject_missing_license');
  if (!/readme\s*=/.test(text)) failures.push('pyproject_missing_readme');
  return {
    package_name: name,
    version,
    has_build_backend: /build-backend\s*=/.test(text),
  };
}

function validateCargo(root, target, failures, _blockers, releaseVersion) {
  const rel = path.join(target.root, 'Cargo.toml');
  const text = read(root, rel);
  const name = tomlValue(text, 'name');
  const version = tomlValue(text, 'version');
  if (!text.includes('[package]')) failures.push('cargo_missing_package_table');
  if (!name) failures.push('cargo_missing_name');
  if (!version) failures.push('cargo_missing_version');
  if (releaseVersion && version !== releaseVersion) failures.push(`cargo_version_mismatch:${version || 'missing'}!=${releaseVersion}`);
  if (!/license\s*=/.test(text)) failures.push('cargo_missing_license');
  if (!text.includes('crate-type')) failures.push('cargo_missing_crate_type');
  return { package_name: name, version, has_wasm_feature: /\bwasm\s*=/.test(text) };
}

function validateSwift(root, target, failures) {
  const text = read(root, path.join(target.root, 'Package.swift'));
  if (!text.includes('let package = Package(')) failures.push('swift_missing_package');
  if (!text.includes('.library(')) failures.push('swift_missing_library_product');
  if (!text.includes('.iOS(')) failures.push('swift_missing_ios_platform');
  return { package_name: (text.match(/name:\s*"([^"]+)"/) || [])[1] || null };
}

function validateGradle(root, target, failures, _blockers, releaseVersion) {
  const text = read(root, path.join(target.root, 'build.gradle.kts'));
  for (const token of ['com.android.library', 'org.jetbrains.kotlin.android', 'maven-publish']) {
    if (!text.includes(token)) failures.push(`gradle_missing_${token}`);
  }
  if (!/group\s*=/.test(text)) failures.push('gradle_missing_group');
  if (!/version\s*=/.test(text)) failures.push('gradle_missing_version');
  const version = (text.match(/version\s*=\s*"([^"]+)"/) || [])[1] || null;
  if (releaseVersion && version !== releaseVersion) failures.push(`gradle_version_mismatch:${version || 'missing'}!=${releaseVersion}`);
  return {
    package_name: (text.match(/group\s*=\s*"([^"]+)"/) || [])[1] || null,
    version,
  };
}

function validateFormula(root, target, failures, blockers, version) {
  const text = read(root, path.join(target.root, 'kolm.rb'));
  for (const token of ['class Kolm < Formula', 'homepage', 'url', 'sha256', 'license']) {
    if (!text.includes(token)) failures.push(`homebrew_missing_${token}`);
  }
  const nodeDependency = (text.match(/depends_on\s+"(node(?:@\d+)?)"/) || [])[1] || null;
  if (!nodeDependency) failures.push('homebrew_missing_node_dependency');
  if (!/Formula\["node(?:@\d+)?"]\.opt_bin/.test(text)) failures.push('homebrew_shim_missing_homebrew_node');
  if (!text.includes('set -euo pipefail')) failures.push('homebrew_shim_missing_strict_mode');
  if (!text.includes('KOLM_INSTALL_CHANNEL')) failures.push('homebrew_shim_missing_install_channel_marker');
  if (!/shell_output\("\#\{bin\}\/kolm --version"\)/.test(text)) failures.push('homebrew_test_missing_version_check');
  if (!/shell_output\("\#\{bin\}\/kolm --help"\)/.test(text)) failures.push('homebrew_test_missing_help_check');
  if (version && !text.includes(`/v${version}.tar.gz`)) failures.push(`homebrew_version_mismatch:${version}`);
  if (hasZeroSha(text)) blockers.push('release_archive_sha256_placeholder');
  return {
    has_test_block: text.includes('test do'),
    placeholder_sha: hasZeroSha(text),
    node_dependency: nodeDependency,
    strict_shim: text.includes('set -euo pipefail'),
    install_channel_marker: text.includes('KOLM_INSTALL_CHANNEL'),
  };
}

function validateApt(root, target, failures, _blockers, version) {
  const text = read(root, path.join(target.root, 'kolm.control'));
  for (const token of ['Package:', 'Version:', 'Depends:', 'Maintainer:', 'Homepage:', 'Description:']) {
    if (!text.includes(token)) failures.push(`apt_missing_${token.replace(':', '').toLowerCase()}`);
  }
  const packageVersion = (text.match(/^Version:\s*(.+)$/m) || [])[1] || null;
  if (version && packageVersion !== version) failures.push(`apt_version_mismatch:${packageVersion || 'missing'}!=${version}`);
  return { package_name: (text.match(/^Package:\s*(.+)$/m) || [])[1] || null, version: packageVersion };
}

function validateWinget(root, target, failures, blockers, releaseVersion) {
  const versionText = read(root, path.join(target.root, 'kolm.kolm.yaml'));
  const installer = read(root, path.join(target.root, 'kolm.kolm.installer.yaml'));
  const locale = read(root, path.join(target.root, 'kolm.kolm.locale.en-US.yaml'));
  for (const [name, text] of [['version', versionText], ['installer', installer], ['locale', locale]]) {
    if (!text.includes('PackageIdentifier: kolm.kolm')) failures.push(`winget_${name}_missing_package_identifier`);
    if (!text.includes('ManifestVersion:')) failures.push(`winget_${name}_missing_manifest_version`);
    if (releaseVersion && !text.includes(`PackageVersion: ${releaseVersion}`)) failures.push(`winget_${name}_version_mismatch:${releaseVersion}`);
  }
  if (!installer.includes('InstallerUrl:')) failures.push('winget_missing_installer_url');
  if (releaseVersion && !installer.includes(`/v${releaseVersion}/kolm-${releaseVersion}-win-x64.zip`)) failures.push(`winget_x64_url_version_mismatch:${releaseVersion}`);
  if (releaseVersion && !installer.includes(`/v${releaseVersion}/kolm-${releaseVersion}-win-arm64.zip`)) failures.push(`winget_arm64_url_version_mismatch:${releaseVersion}`);
  const placeholderSha = hasZeroSha(installer);
  if (placeholderSha && !/Placeholder until signed GitHub release artifacts are attached/i.test(installer)) {
    failures.push('winget_placeholder_sha_missing_release_comment');
  }
  if (/^\s*-\s*(?:hipaa|sr-11-7)\s*$/gim.test(locale)) {
    failures.push('winget_locale_regulated_claim_tag');
  }
  if (releaseVersion && !locale.includes(`ReleaseNotesUrl: https://github.com/kolm-ai/kolm/releases/tag/v${releaseVersion}`)) {
    failures.push(`winget_release_notes_url_mismatch:${releaseVersion}`);
  }
  if (placeholderSha) blockers.push('winget_installer_sha256_placeholder');
  return { placeholder_sha: placeholderSha };
}

function collectStringValues(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, out);
  }
  return out;
}

function validateVsCodeExtension(root, target, failures, _blockers, releaseVersion) {
  const pkg = parseJson(root, path.join(target.root, 'package.json'), failures);
  if (!pkg) return null;
  for (const key of ['name', 'displayName', 'description', 'version', 'publisher', 'license', 'main']) {
    if (!nonEmpty(pkg[key])) failures.push(`vscode_missing_${key}`);
  }
  if (pkg.preview !== true) failures.push('vscode_preview_flag_missing');
  if (pkg.qna !== false) failures.push('vscode_qna_must_be_disabled_until_public_support_ready');
  if (releaseVersion && pkg.version !== releaseVersion) failures.push(`vscode_version_mismatch:${pkg.version || 'missing'}!=${releaseVersion}`);
  if (!pkg.engines || !nonEmpty(pkg.engines.vscode)) failures.push('vscode_missing_engine_range');
  if (!String(pkg.main || '').startsWith('./dist/')) failures.push('vscode_main_must_point_to_dist');
  if (!pkg.repository || !String(pkg.repository.url || '').includes('github.com/kolm-ai/kolm')) failures.push('vscode_repository_url_missing');
  if (pkg.repository?.directory !== target.root) failures.push(`vscode_repository_directory_mismatch:${pkg.repository?.directory || 'missing'}`);
  if (!Array.isArray(pkg.extensionKind) || !pkg.extensionKind.includes('workspace')) failures.push('vscode_extension_kind_workspace_missing');
  if (pkg.capabilities?.untrustedWorkspaces?.supported !== false) failures.push('vscode_untrusted_workspace_must_be_disabled');
  if (pkg.capabilities?.virtualWorkspaces?.supported !== false) failures.push('vscode_virtual_workspace_must_be_disabled');
  if (!Array.isArray(pkg.activationEvents) || !pkg.activationEvents.includes('onStartupFinished')) failures.push('vscode_activation_event_missing');
  const commands = Array.isArray(pkg.contributes?.commands) ? pkg.contributes.commands : [];
  if (commands.length < 3) failures.push('vscode_commands_missing');
  const properties = pkg.contributes?.configuration?.properties || {};
  for (const setting of [
    'kolm.cluster.threshold',
    'kolm.teacher.preference',
    'kolm.namespace',
    'kolm.routing.enabled',
    'kolm.routing.jaccardThreshold',
    'kolm.passiveMonitor.enabled',
    'kolm.passiveMonitor.minBlockChars',
  ]) {
    if (!properties[setting]) failures.push(`vscode_setting_missing:${setting}`);
  }
  const userFacing = [
    pkg.displayName,
    pkg.description,
    ...(commands.map((command) => command.title)),
    pkg.contributes?.configuration?.title,
    ...Object.values(properties).flatMap((property) => [
      property?.description,
      property?.markdownDescription,
    ]),
  ].filter(Boolean);
  if (/\bW\d{3}(?:-\d+)?\b/.test(userFacing.join('\n'))) failures.push('vscode_user_facing_wave_label');
  if (/\bsneaky-hippo\b/i.test(collectStringValues(pkg).join('\n'))) failures.push('vscode_legacy_repository_name');
  return {
    package_name: pkg.name || null,
    version: pkg.version || null,
    preview: pkg.preview === true,
    trusted_workspace_required: pkg.capabilities?.untrustedWorkspaces?.supported === false,
    virtual_workspace_supported: pkg.capabilities?.virtualWorkspaces?.supported !== false,
  };
}

function validateInstallScripts(root, target, failures) {
  const sh = read(root, path.join(target.root, 'install.sh'));
  const ps = read(root, path.join(target.root, 'install.ps1'));
  if (!/set -eu/.test(sh)) failures.push('install_sh_missing_set_eu');
  if (!sh.includes('KOLM_REPO_URL')) failures.push('install_sh_missing_repo_override');
  if (!sh.includes('kolm" doctor')) failures.push('install_sh_missing_doctor_check');
  if (!ps.includes("$ErrorActionPreference = 'Stop'")) failures.push('install_ps1_missing_stop_preference');
  if (!ps.includes('SupportsShouldProcess')) failures.push('install_ps1_missing_whatif_support');
  if (!ps.includes('KOLM_REPO_URL')) failures.push('install_ps1_missing_repo_override');
  if (!ps.includes('doctor --quick')) failures.push('install_ps1_missing_doctor_check');
  return { shell: true, powershell: true };
}

function validateBrowserExtension(root, target, failures, _blockers, releaseVersion) {
  const manifest = parseJson(root, path.join(target.root, 'manifest.json'), failures);
  if (!manifest) return null;
  if (!manifest.manifest_version) failures.push('extension_missing_manifest_version');
  if (!manifest.name) failures.push('extension_missing_name');
  if (!manifest.version) failures.push('extension_missing_version');
  if (releaseVersion && manifest.version !== releaseVersion) failures.push(`extension_version_mismatch:${manifest.version || 'missing'}!=${releaseVersion}`);
  return {
    package_name: manifest.name,
    version: manifest.version,
    manifest_version: manifest.manifest_version,
  };
}

function validateByChannel(root, target, failures, blockers, version) {
  switch (target.channel) {
    case 'npm': return validateNpm(root, target, failures, blockers, version);
    case 'pypi': return validatePyProject(root, target, failures, blockers, version);
    case 'crates': return validateCargo(root, target, failures, blockers, version);
    case 'swiftpm': return validateSwift(root, target, failures, blockers);
    case 'maven': return validateGradle(root, target, failures, blockers, version);
    case 'homebrew': return validateFormula(root, target, failures, blockers, version);
    case 'apt': return validateApt(root, target, failures, blockers, version);
    case 'winget': return validateWinget(root, target, failures, blockers, version);
    case 'direct-download': return validateInstallScripts(root, target, failures, blockers);
    case 'browser-extension': return validateBrowserExtension(root, target, failures, blockers, version);
    case 'vscode-marketplace': return validateVsCodeExtension(root, target, failures, blockers, version);
    default:
      failures.push(`unknown_channel:${target.channel}`);
      return null;
  }
}

export function auditPackageReleaseReadiness(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const releaseVersion = rootVersion(root);
  let release_manifest = null;
  let release_manifest_validation = null;
  let release_artifact_validation = null;
  try {
    release_manifest = parseJsonFile(root, 'reports/package-release-manifest.json');
    release_manifest_validation = release_manifest ? validatePackageReleaseManifest(release_manifest) : null;
    release_artifact_validation = release_manifest && release_manifest_validation && release_manifest_validation.ok
      ? validatePackageReleaseArtifacts(root, release_manifest)
      : null;
  } catch (e) {
    release_manifest_validation = {
      spec: PACKAGE_RELEASE_MANIFEST_SPEC,
      ok: false,
      publish_ready: false,
      secret_values_included: false,
      counts: { targets: 0, required_targets: PACKAGE_RELEASE_TARGETS.length, complete_targets: 0, failures: 1 },
      failures: [`reports/package-release-manifest.json:invalid_json:${String(e.message || e)}`],
    };
    release_artifact_validation = null;
  }
  const releaseManifestPublishReady = Boolean(
    release_manifest_validation && release_manifest_validation.ok
    && release_artifact_validation && release_artifact_validation.ok
  );
  const targets = [];
  for (const target of PACKAGE_RELEASE_TARGETS) {
    const failures = [];
    const blockers = [];
    for (const file of [...(target.manifests || []), ...(target.docs || [])]) {
      const rel = path.join(target.root, file);
      if (!exists(root, rel)) failures.push(`missing_file:${rel.replace(/\\/g, '/')}`);
    }
    let metadata = null;
    if (failures.length === 0) {
      metadata = validateByChannel(root, target, failures, blockers, releaseVersion);
    }
    if (failures.length === 0 && !releaseManifestPublishReady) {
      blockers.push('signed_release_artifact_or_registry_url_missing');
    }
    const structural_ok = failures.length === 0;
    const publish_ready = structural_ok && blockers.length === 0;
    targets.push({
      id: target.id,
      label: target.label,
      channel: target.channel,
      root: target.root,
      requirement_ids: target.requirement_ids,
      structural_ok,
      publish_ready,
      status: publish_ready ? 'publish_ready' : structural_ok ? 'package_channel_pending' : 'blocked',
      failures,
      publish_blockers: blockers,
      metadata,
      local_checks: target.checks,
    });
  }

  const by_requirement = {};
  for (const id of PACKAGE_REQUIREMENT_IDS) {
    const reqTargets = targets.filter((target) => target.requirement_ids.includes(id));
    by_requirement[id] = {
      target_count: reqTargets.length,
      structural_ok: reqTargets.length > 0 && reqTargets.every((target) => target.structural_ok),
      publish_ready: reqTargets.length > 0 && reqTargets.every((target) => target.publish_ready),
      status: reqTargets.length === 0
        ? 'missing_targets'
        : reqTargets.every((target) => target.publish_ready)
          ? 'publish_ready'
          : reqTargets.every((target) => target.structural_ok)
            ? 'package_channel_pending'
            : 'blocked',
      targets: reqTargets.map((target) => target.id),
    };
  }

  const failures = targets.flatMap((target) => target.failures.map((failure) => `${target.id}:${failure}`));
  for (const [id, req] of Object.entries(by_requirement)) {
    if (req.target_count === 0) failures.push(`${id}:missing_targets`);
  }
  const publish_blockers = targets.flatMap((target) => target.publish_blockers.map((blocker) => `${target.id}:${blocker}`));
  return {
    spec: PACKAGE_RELEASE_SPEC,
    ok: failures.length === 0,
    publish_ready: failures.length === 0 && publish_blockers.length === 0,
    secret_values_included: false,
    generated_at: new Date().toISOString(),
    release_version: releaseVersion,
    counts: {
      requirements: PACKAGE_REQUIREMENT_IDS.length,
      targets: targets.length,
      structural_ok: targets.filter((target) => target.structural_ok).length,
      publish_ready: targets.filter((target) => target.publish_ready).length,
      package_channel_pending: targets.filter((target) => target.status === 'package_channel_pending').length,
      blocked: targets.filter((target) => target.status === 'blocked').length,
    },
    by_requirement,
    targets,
    release_manifest: {
      path: 'reports/package-release-manifest.json',
      exists: Boolean(release_manifest),
      validation: release_manifest_validation,
      artifacts: release_artifact_validation,
    },
    failures,
    publish_blockers,
    note: 'This is a local package-release readiness audit. It validates manifests, metadata, docs, and dry-run commands; registry/channel publication remains external until signed release artifacts exist.',
  };
}

export default auditPackageReleaseReadiness;
