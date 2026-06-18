//! Trust-on-first-use (TOFU) pinning for receipt key namespaces.
//!
//! The runtime does not ship a centralized PKI. Instead, the first time a
//! given CID is verified successfully, its `signed_by` namespace is pinned in
//! a local store. Any subsequent verification of the same CID under a
//! different namespace is rejected as a TOFU pin mismatch.
//!
//! This is the same model SSH uses for host keys. The store is a simple
//! `BTreeMap<CID, TrustEntry>` that serializes to JSON; callers persist it on
//! disk wherever it suits their deployment.

use crate::cid::is_valid_cid_format;
use crate::error::Error;
use crate::verify::VerifyReport;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A single pinned entry — one CID and its observed `signed_by` namespace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustEntry {
    /// The receipt's `signed_by` namespace at the time of pinning
    /// (e.g. `kolm-dev-hmac-1`).
    pub signed_by: String,
    /// ISO-8601 timestamp when this CID was first observed. Recorded in
    /// human-readable form for audit; the runtime never branches on it.
    pub first_seen: String,
    /// Number of times this CID has been re-verified since pinning.
    pub seen_count: u64,
}

/// In-memory TOFU store. Persist by serializing to JSON; reload by
/// deserializing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrustStore {
    entries: BTreeMap<String, TrustEntry>,
}

impl TrustStore {
    /// Empty store.
    pub fn new() -> Self {
        Self { entries: BTreeMap::new() }
    }

    /// Load a store from JSON bytes. Returns an empty store on parse failure
    /// rather than erroring — callers can layer stricter handling on top.
    pub fn from_json(bytes: &[u8]) -> Self {
        Self::try_from_json(bytes).unwrap_or_default()
    }

    /// Strictly load a store from JSON bytes. Unlike [`Self::from_json`],
    /// malformed input is returned to the caller instead of erasing pins.
    pub fn try_from_json(bytes: &[u8]) -> Result<Self, Error> {
        let store: Self = serde_json::from_slice(bytes).map_err(Error::Json)?;
        for (cid, entry) in &store.entries {
            if !valid_pin_inputs(cid, &entry.signed_by) {
                return Err(Error::VerificationFailed(format!(
                    "trust store contains invalid pin: {}",
                    cid
                )));
            }
        }
        Ok(store)
    }

    /// Serialize the store to pretty JSON.
    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| String::from("{}"))
    }

    /// Look up the pinned namespace for a given CID. Returns `None` if the
    /// CID has not yet been observed.
    pub fn get_pinned_namespace(&self, cid: &str) -> Option<&str> {
        self.entries.get(cid).map(|e| e.signed_by.as_str())
    }

    /// Record (or update) an observation. If the CID is already pinned to a
    /// different namespace this is a no-op — callers should check
    /// [`Self::get_pinned_namespace`] first and reject the verification when
    /// they see a mismatch (the high-level `Artifact::verify_with_store` does
    /// this for you).
    pub fn observe(&mut self, cid: &str, signed_by: &str, _report: &VerifyReport) {
        if !valid_pin_inputs(cid, signed_by) {
            return;
        }
        if let Some(existing) = self.entries.get_mut(cid) {
            if existing.signed_by == signed_by {
                existing.seen_count = existing.seen_count.saturating_add(1);
            }
            return;
        }
        self.entries.insert(
            cid.to_string(),
            TrustEntry {
                signed_by: signed_by.to_string(),
                first_seen: current_iso_timestamp(),
                seen_count: 1,
            },
        );
    }

    /// Force-pin (or repin) a CID to a known namespace. Use sparingly — this
    /// bypasses TOFU semantics.
    pub fn force_pin(&mut self, cid: &str, signed_by: &str) {
        if !valid_pin_inputs(cid, signed_by) {
            return;
        }
        self.entries.insert(
            cid.to_string(),
            TrustEntry {
                signed_by: signed_by.to_string(),
                first_seen: current_iso_timestamp(),
                seen_count: 1,
            },
        );
    }

    /// Remove a pin. Returns `true` if the entry existed.
    pub fn unpin(&mut self, cid: &str) -> bool {
        self.entries.remove(cid).is_some()
    }

    /// Iterate over all pinned entries.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &TrustEntry)> {
        self.entries.iter()
    }

    /// Number of pinned CIDs.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` when no CIDs are pinned.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn valid_pin_inputs(cid: &str, signed_by: &str) -> bool {
    is_valid_cid_format(cid) && valid_signed_by(signed_by)
}

fn valid_signed_by(signed_by: &str) -> bool {
    !signed_by.is_empty()
        && signed_by.len() <= 256
        && signed_by
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
}

/// Best-effort ISO-8601 timestamp without pulling in `chrono`. Returns
/// `1970-01-01T00:00:00Z` on platforms where `SystemTime` is unavailable
/// (e.g. early `wasm32-unknown-unknown` without `wasm-bindgen`'s Date).
fn current_iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 1970-01-01 + secs, rendered as ISO without fractional seconds.
    let (year, month, day, hour, minute, second) = epoch_to_civil(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

// Howard Hinnant's days-from-civil algorithm, inverted. No external date
// crate needed; pure arithmetic.
fn epoch_to_civil(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let seconds_today = (secs % 86_400) as u32;
    let hour = seconds_today / 3600;
    let minute = (seconds_today % 3600) / 60;
    let second = seconds_today % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d, hour, minute, second)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cid(byte: char) -> String {
        format!(
            "cidv1:sha256:{}",
            std::iter::repeat(byte).take(64).collect::<String>()
        )
    }

    fn empty_report() -> VerifyReport {
        VerifyReport::new(cid('a'), "kolm-dev-hmac-1".into())
    }

    #[test]
    fn observe_pins_new_cid() {
        let mut s = TrustStore::new();
        let c = cid('a');
        s.observe(&c, "kolm-dev-hmac-1", &empty_report());
        assert_eq!(s.get_pinned_namespace(&c), Some("kolm-dev-hmac-1"));
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn observe_increments_seen_count() {
        let mut s = TrustStore::new();
        let c = cid('a');
        s.observe(&c, "kolm-dev-hmac-1", &empty_report());
        s.observe(&c, "kolm-dev-hmac-1", &empty_report());
        let e = s.entries.get(&c).unwrap();
        assert_eq!(e.seen_count, 2);
    }

    #[test]
    fn observe_does_not_overwrite_pin() {
        let mut s = TrustStore::new();
        let c = cid('a');
        s.observe(&c, "kolm-dev-hmac-1", &empty_report());
        // Attempt to clobber with a different namespace — must be ignored.
        s.observe(&c, "imposter-key", &empty_report());
        assert_eq!(s.get_pinned_namespace(&c), Some("kolm-dev-hmac-1"));
    }

    #[test]
    fn force_pin_overrides() {
        let mut s = TrustStore::new();
        let c = cid('a');
        s.force_pin(&c, "k1");
        s.force_pin(&c, "k2");
        assert_eq!(s.get_pinned_namespace(&c), Some("k2"));
    }

    #[test]
    fn unpin_removes_entry() {
        let mut s = TrustStore::new();
        let c = cid('a');
        s.force_pin(&c, "k1");
        assert!(s.unpin(&c));
        assert!(!s.unpin(&c));
        assert!(s.is_empty());
    }

    #[test]
    fn round_trip_json() {
        let mut s = TrustStore::new();
        let c = cid('a');
        s.force_pin(&c, "k1");
        let j = s.to_json_pretty();
        let s2 = TrustStore::from_json(j.as_bytes());
        assert_eq!(s2.get_pinned_namespace(&c), Some("k1"));
    }

    #[test]
    fn from_json_invalid_returns_empty() {
        let s = TrustStore::from_json(b"not-json");
        assert!(s.is_empty());
    }

    #[test]
    fn try_from_json_invalid_returns_error() {
        assert!(TrustStore::try_from_json(b"not-json").is_err());
        let bad_pin = br#"{
          "entries": {
            "cidv1:sha256:a": {
              "signed_by": "kolm-dev-hmac-1",
              "first_seen": "2026-06-18T00:00:00Z",
              "seen_count": 1
            }
          }
        }"#;
        assert!(TrustStore::try_from_json(bad_pin).is_err());
    }

    #[test]
    fn invalid_pin_inputs_are_ignored() {
        let mut s = TrustStore::new();
        s.observe("cidv1:sha256:a", "kolm-dev-hmac-1", &empty_report());
        s.force_pin(&cid('a'), "");
        s.force_pin(&cid('b'), "bad namespace");
        s.force_pin(&cid('c'), "bad\"namespace");
        assert!(s.is_empty());
    }

    #[test]
    fn iso_timestamp_format() {
        // Sanity-check the date rendering for a known epoch.
        let ts = epoch_to_civil(0);
        assert_eq!(ts, (1970, 1, 1, 0, 0, 0));
        let ts = epoch_to_civil(1_705_000_000); // 2024-01-11T19:06:40Z
        assert_eq!(ts, (2024, 1, 11, 19, 6, 40));
    }
}
