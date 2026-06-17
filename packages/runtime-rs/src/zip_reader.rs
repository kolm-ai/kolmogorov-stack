//! Minimal checked zip extractor.
//!
//! Returns every file inside the artifact as `(filename, bytes)`. The caller
//! decides which files are required (manifest, recipes, signature, receipt)
//! and which are optional (lora.bin, index.sqlite-vec, model.gguf).

use crate::error::Error;
use std::collections::HashMap;
use std::io::{Cursor, Read};

/// Maximum number of file entries read by the default artifact extractor.
pub const DEFAULT_MAX_ZIP_ENTRIES: usize = 512;
/// Maximum uncompressed bytes accepted for one file entry.
pub const DEFAULT_MAX_ZIP_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Maximum total uncompressed bytes accepted across all file entries.
pub const DEFAULT_MAX_ZIP_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Resource limits for artifact zip extraction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZipReadLimits {
    /// Maximum number of file entries to read.
    pub max_entries: usize,
    /// Maximum uncompressed bytes for one file entry.
    pub max_entry_bytes: u64,
    /// Maximum total uncompressed bytes across all file entries.
    pub max_total_bytes: u64,
}

impl Default for ZipReadLimits {
    fn default() -> Self {
        Self {
            max_entries: DEFAULT_MAX_ZIP_ENTRIES,
            max_entry_bytes: DEFAULT_MAX_ZIP_ENTRY_BYTES,
            max_total_bytes: DEFAULT_MAX_ZIP_TOTAL_BYTES,
        }
    }
}

/// Read every file out of a `.kolm` zip buffer into a hash map.
pub fn read_artifact_files(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, Error> {
    read_artifact_files_with_limits(bytes, ZipReadLimits::default())
}

/// Read every file out of a `.kolm` zip buffer with explicit resource limits.
pub fn read_artifact_files_with_limits(
    bytes: &[u8],
    limits: ZipReadLimits,
) -> Result<HashMap<String, Vec<u8>>, Error> {
    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)?;
    if archive.len() > limits.max_entries {
        return Err(Error::MalformedManifest(format!(
            "zip entry count {} exceeds limit {}",
            archive.len(),
            limits.max_entries
        )));
    }

    let mut out = HashMap::with_capacity(archive.len());
    let mut total_uncompressed: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if !entry.is_file() {
            continue;
        }
        let declared_size = entry.size();
        if declared_size > limits.max_entry_bytes {
            return Err(Error::MalformedManifest(format!(
                "zip entry {} declared size {} exceeds per-entry limit {}",
                i, declared_size, limits.max_entry_bytes
            )));
        }

        let name = entry
            .enclosed_name()
            .ok_or_else(|| Error::MalformedManifest(format!("unsafe zip entry name at index {}", i)))?
            .to_string_lossy()
            .replace('\\', "/");
        if name.is_empty() {
            return Err(Error::MalformedManifest(format!(
                "empty zip entry name at index {}",
                i
            )));
        }
        if out.contains_key(&name) {
            return Err(Error::MalformedManifest(format!(
                "duplicate zip entry name: {}",
                name
            )));
        }

        let mut buf = Vec::new();
        let mut limited = entry.by_ref().take(limits.max_entry_bytes.saturating_add(1));
        limited.read_to_end(&mut buf)?;
        if buf.len() as u64 > limits.max_entry_bytes {
            return Err(Error::MalformedManifest(format!(
                "zip entry {} exceeds per-entry limit {}",
                name, limits.max_entry_bytes
            )));
        }
        total_uncompressed = total_uncompressed
            .checked_add(buf.len() as u64)
            .ok_or_else(|| Error::MalformedManifest("zip total size overflow".into()))?;
        if total_uncompressed > limits.max_total_bytes {
            return Err(Error::MalformedManifest(format!(
                "zip uncompressed size {} exceeds total limit {}",
                total_uncompressed, limits.max_total_bytes
            )));
        }

        out.insert(name, buf);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let cursor = Cursor::new(&mut out);
            let mut z = zip::ZipWriter::new(cursor);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, bytes) in entries {
                z.start_file(name, opts).unwrap();
                z.write_all(bytes).unwrap();
            }
            z.finish().unwrap();
        }
        out
    }

    #[test]
    fn reads_files() {
        let zip = zip_bytes(&[("manifest.json", b"{}"), ("recipes.json", b"[]")]);
        let files = read_artifact_files(&zip).unwrap();
        assert_eq!(files.get("manifest.json").unwrap(), b"{}");
        assert_eq!(files.get("recipes.json").unwrap(), b"[]");
    }

    #[test]
    fn duplicate_zip_entry_is_rejected() {
        let zip = zip_bytes(&[("manifest.json", b"one"), ("manifest.json", b"two")]);
        let err = read_artifact_files(&zip).unwrap_err();
        assert!(err.to_string().contains("duplicate zip entry name"));
    }

    #[test]
    fn zip_limits_reject_large_entry() {
        let zip = zip_bytes(&[("model.gguf", b"12345")]);
        let err = read_artifact_files_with_limits(
            &zip,
            ZipReadLimits {
                max_entries: 8,
                max_entry_bytes: 4,
                max_total_bytes: 1024,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("per-entry limit"));
    }

    #[test]
    fn zip_limits_reject_total_size() {
        let zip = zip_bytes(&[("a", b"123"), ("b", b"456")]);
        let err = read_artifact_files_with_limits(
            &zip,
            ZipReadLimits {
                max_entries: 8,
                max_entry_bytes: 8,
                max_total_bytes: 5,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("total limit"));
    }

    #[test]
    fn zip_limits_reject_too_many_entries() {
        let zip = zip_bytes(&[("a", b"1"), ("b", b"2")]);
        let err = read_artifact_files_with_limits(
            &zip,
            ZipReadLimits {
                max_entries: 1,
                max_entry_bytes: 8,
                max_total_bytes: 64,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("entry count"));
    }
}
