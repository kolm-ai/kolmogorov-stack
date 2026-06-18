(() => {
  const POPUP_CONTRACT_VERSION = "w790-browser-extension-popup-v1";
  const ISSUER_CACHE_KEY = "kolm-issuer-pubkey-cache";
  const LAST_VERIFY_KEY = "kolm-last-verify";
  const POPUP_LIMITS = Object.freeze({
    max_kid_chars: 96,
    max_age_seconds: 365 * 24 * 60 * 60,
    max_clock_skew_seconds: 60,
  });

  function setText(id, text, className) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = className || "";
  }

  function cleanKid(cache) {
    const kid = cache && cache.key && typeof cache.key.kid === "string" ? cache.key.kid.trim() : "";
    if (!kid || /[\u0000-\u001f\u007f]/.test(kid)) return null;
    return kid.slice(0, POPUP_LIMITS.max_kid_chars);
  }

  function formatLastVerify(value, nowMs) {
    if (!value || typeof value !== "object") return null;
    const ts = Number(value.ts);
    if (!Number.isFinite(ts)) return null;
    const ageSeconds = Math.round((nowMs - ts) / 1000);
    if (ageSeconds < -POPUP_LIMITS.max_clock_skew_seconds) return null;
    if (ageSeconds > POPUP_LIMITS.max_age_seconds) return null;
    const safeAge = Math.max(0, ageSeconds);
    return {
      text: `${safeAge}s ago (${value.ok === true ? "OK" : "FAIL"})`,
      className: value.ok === true ? "ok" : "bad",
    };
  }

  async function readStorage() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.local || !chrome.storage.local.get) {
      throw new Error("chrome storage unavailable");
    }
    return chrome.storage.local.get([ISSUER_CACHE_KEY, LAST_VERIFY_KEY]);
  }

  const ready = (async () => {
    let s;
    try {
      s = await readStorage();
    } catch (_) {
      setText("ikey", "storage-unavailable", "bad");
      setText("last", "never", "");
      return;
    }

    const kid = cleanKid(s[ISSUER_CACHE_KEY]);
    if (kid) setText("ikey", kid, "ok");
    else setText("ikey", "baked-fallback", "bad");

    const last = formatLastVerify(s[LAST_VERIFY_KEY], Date.now());
    if (last) setText("last", last.text, last.className);
    else setText("last", "never", "");
  })();

  globalThis.KOLM_POPUP_CONTRACT = Object.freeze({
    version: POPUP_CONTRACT_VERSION,
    storage_keys: Object.freeze([ISSUER_CACHE_KEY, LAST_VERIFY_KEY]),
    limits: POPUP_LIMITS,
    secret_values_included: false,
  });
  globalThis.KOLM_POPUP_READY = ready;
})();
