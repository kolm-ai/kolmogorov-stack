//! Integration tests against the public `.kolm` fixtures.
//!
//! These tests require the fixtures shipped in `../../test/fixtures/`. The
//! fixtures are signed with the public secret `kolm-public-fixture-v0-1-0`,
//! mirroring what `tests/artifact-end-to-end.test.js` uses on the Node side.

use kolm_runtime::Artifact;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fixtures")
        .join(name)
}

const PUBLIC_SECRET: &str = "kolm-public-fixture-v0-1-0";

#[test]
fn load_sample_fixture() {
    let path = fixture("sample.kolm");
    if !path.exists() {
        eprintln!("skipping: fixture not present at {}", path.display());
        return;
    }
    let artifact = Artifact::load_from_path(&path).expect("load");
    assert_eq!(artifact.manifest().spec, "kolm-1");
    assert!(artifact.cid().starts_with("cidv1:sha256:"));
}

#[test]
fn verify_sample_fixture() {
    let path = fixture("sample.kolm");
    if !path.exists() {
        eprintln!("skipping: fixture not present at {}", path.display());
        return;
    }
    let artifact = Artifact::load_from_path(&path).expect("load");
    artifact.verify(PUBLIC_SECRET).expect("verify");
}

#[test]
fn verify_classifier_fixture() {
    let path = fixture("classifier.kolm");
    if !path.exists() {
        eprintln!("skipping: fixture not present at {}", path.display());
        return;
    }
    let artifact = Artifact::load_from_path(&path).expect("load");
    artifact.verify(PUBLIC_SECRET).expect("verify");
    assert!(artifact.manifest().recipes.n >= 1);
}

#[test]
fn wrong_secret_fails_verify() {
    let path = fixture("sample.kolm");
    if !path.exists() {
        return;
    }
    let artifact = Artifact::load_from_path(&path).expect("load");
    let err = artifact.verify("not-the-right-secret").unwrap_err();
    assert!(matches!(err, kolm_runtime::Error::VerificationFailed(_)));
}
