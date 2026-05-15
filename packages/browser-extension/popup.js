(async () => {
  const s = await chrome.storage.local.get(["kolm-issuer-pubkey-cache", "kolm-last-verify"]);
  const ikey = document.getElementById("ikey");
  const last = document.getElementById("last");
  const cache = s["kolm-issuer-pubkey-cache"];
  if (cache && cache.key && cache.key.kid) {
    ikey.textContent = cache.key.kid;
    ikey.className = "ok";
  } else {
    ikey.textContent = "baked-fallback";
    ikey.className = "bad";
  }
  const lv = s["kolm-last-verify"];
  if (lv && lv.ts) {
    const age = Math.round((Date.now() - lv.ts) / 1000);
    last.textContent = `${age}s ago (${lv.ok ? "OK" : "FAIL"})`;
    last.className = lv.ok ? "ok" : "bad";
  }
})();
