// W671 - direct contract for packages/homebrew/kolm.rb.
//
// Locks Homebrew formula integrity without pretending the tap is published:
// version-pinned release tarball, explicit SHA placeholder blocker, supported
// Node runtime wiring, strict shim, install-channel marker, and local tests.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { auditPackageReleaseReadiness } from '../src/package-release-readiness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORMULA = path.join(ROOT, 'packages/homebrew/kolm.rb');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W671 Homebrew formula stays version-pinned and honest about pending release SHA', () => {
  const pkg = JSON.parse(read('package.json'));
  const text = fs.readFileSync(FORMULA, 'utf8');

  assert.match(text, /class Kolm < Formula/);
  assert.match(text, new RegExp(`url "https://github\\.com/kolm-ai/kolm/archive/refs/tags/v${pkg.version.replace(/\./g, '\\.')}\\.tar\\.gz"`));
  assert.match(text, /sha256 "0{64}"/);
  assert.doesNotMatch(text, /sha256 "[1-9a-f][0-9a-f]{63}"/i, 'do not ship a fake non-placeholder hash');
  assert.match(text, /license "Apache-2\.0"/);
});

test('W671 Homebrew formula uses supported Homebrew Node runtime and strict shim', () => {
  const text = fs.readFileSync(FORMULA, 'utf8');

  assert.match(text, /depends_on "node"/);
  assert.doesNotMatch(text, /depends_on "node@20"/);
  assert.match(text, /Formula\["node"\]\.opt_bin/);
  assert.match(text, /set -euo pipefail/);
  assert.match(text, /KOLM_INSTALL_CHANNEL="\$\{KOLM_INSTALL_CHANNEL:-homebrew\}"/);
  assert.match(text, /exec "\#\{Formula\["node"\]\.opt_bin\}\/node" "\#\{libexec\}\/cli\/kolm\.js" "\$@"/);
});

test('W671 Homebrew formula keeps local install smoke checks in the formula', () => {
  const text = fs.readFileSync(FORMULA, 'utf8');

  assert.match(text, /test do/);
  assert.match(text, /shell_output\("\#\{bin\}\/kolm --version"\)/);
  assert.match(text, /shell_output\("\#\{bin\}\/kolm --help"\)/);
  assert.match(text, /assert_match "kolm v"/);
  assert.match(text, /assert_match "Usage:"/);
});

test('W671 package release audit keeps Homebrew structural but channel-pending', () => {
  const audit = auditPackageReleaseReadiness({ root: ROOT });
  const homebrew = audit.targets.find((target) => target.id === 'homebrew');

  assert.ok(homebrew, 'homebrew target must exist');
  assert.equal(homebrew.structural_ok, true, homebrew.failures.join('\n'));
  assert.equal(homebrew.publish_ready, false);
  assert.equal(homebrew.status, 'package_channel_pending');
  assert.deepEqual(homebrew.failures, []);
  assert.ok(homebrew.publish_blockers.includes('release_archive_sha256_placeholder'));
  assert.ok(homebrew.publish_blockers.includes('signed_release_artifact_or_registry_url_missing'));
  assert.equal(homebrew.metadata.placeholder_sha, true);
  assert.equal(homebrew.metadata.node_dependency, 'node');
  assert.equal(homebrew.metadata.strict_shim, true);
  assert.equal(homebrew.metadata.install_channel_marker, true);
  assert.ok(audit.publish_blockers.includes('homebrew:release_archive_sha256_placeholder'));
});
