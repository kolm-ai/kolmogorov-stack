//! Minimal zip extractor.
//!
//! Returns every file inside the artifact as `(filename → bytes)`. The
//! caller decides which files are required (manifest, recipes, signature,
//! receipt) and which are optional (lora.bin, index.sqlite-vec, model.gguf).

use crate::error::Error;
use std::collections::HashMap;
use std::io::{Cursor, Read};

/// Read every file out of a `.kolm` zip buffer into a hash map.
pub fn read_artifact_files(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, Error> {
    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)?;
    let mut out = HashMap::with_capacity(archive.len());
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if !entry.is_file() {
            continue;
        }
        let name = entry
            .enclosed_name()
            .ok_or_else(|| Error::MalformedManifest(format!("unsafe zip entry name at index {}", i)))?
            .to_string_lossy()
            .to_string();
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)?;
        out.insert(name, buf);
    }
    Ok(out)
}
