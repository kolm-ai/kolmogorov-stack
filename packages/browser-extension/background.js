// kolm Verify — MV3 service worker.
//
// Hooks into chrome.downloads to flag any *.kolm file the browser sees,
// then offers a one-click verification using the same code path as the
// /verify-prod page. Verification runs entirely in the browser; no network
// call besides fetching the kolm issuer pubkey at install time.
//
// Storage:
//   chrome.storage.local["kolm-issuer-pubkey-cache"]  cached pubkey + ts
//   chrome.storage.local["kolm-last-verify"]          most recent result
//
// Context menu: right-click any .kolm link in a page → "Verify with kolm".

const ISSUER_KEY_URL = "https://kolm.ai/.well-known/kolm-issuer-pubkey.json";
const ISSUER_CACHE_KEY = "kolm-issuer-pubkey-cache";
const ISSUER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "kolm-verify-link",
    title: "Verify with kolm",
    contexts: ["link"],
    targetUrlPatterns: ["*://*/*.kolm", "*://*/*.kolm?*"]
  });
  cacheIssuerKey().catch(() => { /* fall back to baked key on first verify */ });
});

chrome.contextMenus.onClicked.addListener(async (info, _tab) => {
  if (info.menuItemId !== "kolm-verify-link" || !info.linkUrl) return;
  const url = info.linkUrl;
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`verifier.html?src=${encodeURIComponent(url)}`)
  });
});

chrome.downloads.onCreated.addListener(async (item) => {
  if (!item.filename || !item.filename.toLowerCase().endsWith(".kolm")) return;
  await chrome.storage.local.set({ "kolm-last-download": { id: item.id, url: item.url, ts: Date.now() } });
});

async function cacheIssuerKey() {
  const cached = (await chrome.storage.local.get(ISSUER_CACHE_KEY))[ISSUER_CACHE_KEY];
  if (cached && (Date.now() - cached.ts) < ISSUER_CACHE_TTL_MS) return cached.key;
  const resp = await fetch(ISSUER_KEY_URL, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`issuer key fetch ${resp.status}`);
  const body = await resp.json();
  await chrome.storage.local.set({ [ISSUER_CACHE_KEY]: { key: body, ts: Date.now() } });
  return body;
}
