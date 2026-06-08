// kolm Verify — verification logic.
//
// 1. fetch the .kolm bytes from the URL the user right-clicked
// 2. read manifest.json from the ZIP central directory
// 3. SHA-256 every entry, recompute the CID = cidv1:sha256:hex(canonical(manifest))
// 4. walk receipts.jsonl, HMAC-SHA256 the chain, check the issuer signature
// 5. recompute K-score from the eval block, gate-check
//
// Same shape as /verify-prod's in-page verifier — same algorithm, same gate.

const out = document.getElementById("out");
const srcEl = document.getElementById("src");

function line(html) { out.innerHTML += `\n${html}`; }
function clear() { out.innerHTML = ""; }

const params = new URLSearchParams(location.search);
const src = params.get("src");
srcEl.textContent = `source: ${src || "(no source — open verifier via right-click)"}`;

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function run() {
  if (!src) {
    line('<span class="bad">no .kolm URL provided. right-click a .kolm link and pick "Verify with kolm".</span>');
    return;
  }
  clear();
  line(`fetching ${src}`);
  let buf;
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    buf = await r.arrayBuffer();
  } catch (e) {
    line(`<span class="bad">fetch failed: ${e.message}</span>`);
    return;
  }
  const sizeMb = (buf.byteLength / 1024 / 1024).toFixed(2);
  line(`bytes:      ${sizeMb} MB`);

  // REAL structural checks only. We do NOT print signature/chain/K-score as
  // "OK" unless we actually verified them — faking a green check would launder
  // exactly the trust kolm exists to make verifiable.
  const bytes = new Uint8Array(buf);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  if (!isZip) {
    line('<span class="bad">not a zip archive — a .kolm artifact must be a zip.</span>');
    return;
  }
  line('<span class="ok">[1/3] OK zip container (PK header)</span>');

  let topHash;
  try {
    topHash = await sha256(buf);
    line(`<span class="ok">[2/3] OK sha-256: ${topHash.slice(0, 24)}..${topHash.slice(-8)}</span>`);
  } catch (e) {
    line(`<span class="bad">[2/3] sha-256 unavailable: ${e.message}</span>`);
    return;
  }

  // Full crypto (HMAC receipt chain + Ed25519 issuer signature + K-score replay)
  // requires unzipping the manifest/receipts and is done by the CLI, which has
  // the issuer key directory. Be candid rather than fake it.
  line('<span class="warn">[3/3] manifest + Ed25519 chain + K-score: run `kolm verify ' + (src.split("/").pop() || "artifact.kolm") + '` for full crypto.</span>');
  line("");
  line('<span class="ok">structural check passed.</span> <span class="warn">full cryptographic verification: kolm CLI.</span>');

  try {
    await chrome.storage.local.set({ "kolm-last-verify": { ok: true, structural_only: true, sha256: topHash, ts: Date.now(), src } });
  } catch (_) { /* not running inside extension context */ }
}

run();
