import { NativeModules, Platform } from "react-native";

const native = NativeModules.KolmRN ?? null;
const VALID_VERIFY = new Set(["off", "on", "strict"]);
const DEFAULT_MAX_TOKENS = 256;
const MAX_TOKENS = 32768;
const DOWNLOAD_TIMEOUT_MS = 30000;

let cachedConfig = { verify: "on" };

function ensureNative() {
  if (!native) {
    throw new Error(
      `kolm-rn native module not linked on ${Platform.OS}. iOS: pod install. Android: rebuild after adding kolm-rn to package.json.`
    );
  }
  return native;
}

function normalizeConfig(cfg) {
  const verify = cfg.verify ?? "on";
  if (!VALID_VERIFY.has(verify)) {
    throw new Error(`kolm-rn invalid verify mode: ${String(cfg.verify)}`);
  }
  if (cfg.secret !== undefined && (typeof cfg.secret !== "string" || cfg.secret.length === 0)) {
    throw new Error("kolm-rn config.secret must be a non-empty string when supplied");
  }
  return {
    verify,
    ...(cfg.secret ? { secret: cfg.secret } : {}),
  };
}

export function setConfig(cfg) {
  cachedConfig = normalizeConfig({ ...cachedConfig, ...cfg });
}

function fileUriToPath(uri) {
  const raw = uri.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizePlainLocalPath(uri) {
  if (typeof uri !== "string" || uri.trim().length === 0 || uri.includes("\0")) {
    throw new Error("kolm-rn source URI/path must be a non-empty string");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
    throw new Error("kolm-rn source must be require(...), file://, https://, or a local filesystem path");
  }
  return uri;
}

function cacheFileName(uri) {
  const suffix = encodeURIComponent(uri)
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 96) || "remote";
  return `${hash(uri)}-${suffix}.kolm`;
}

async function resolveToLocalPath(source) {
  if (typeof source === "number") {
    const { Asset } = await import("expo-asset").catch(() => ({ Asset: null }));
    if (Asset) {
      const asset = await Asset.fromModule(source).downloadAsync();
      if (typeof asset.localUri === "string" && asset.localUri.startsWith("file://")) {
        return fileUriToPath(asset.localUri);
      }
    }
    throw new Error("kolm-rn require(...) loading needs expo-asset, or supply a file:// or https:// URI.");
  }
  const uri = typeof source === "string" ? source : source?.uri;
  if (typeof uri !== "string") throw new Error("kolm-rn source object must include a string uri");
  if (uri.startsWith("file://")) return fileUriToPath(uri);
  if (uri.startsWith("https://")) {
    const RNFS = await import("react-native-fs").catch(() => null);
    if (!RNFS) {
      throw new Error("kolm-rn https:// loading needs react-native-fs. `npm install react-native-fs` and rebuild.");
    }
    const dest = `${RNFS.CachesDirectoryPath}/${cacheFileName(uri)}`;
    if (!(await RNFS.exists(dest))) {
      const result = await RNFS.downloadFile({
        fromUrl: uri,
        toFile: dest,
        readTimeout: DOWNLOAD_TIMEOUT_MS,
        connectionTimeout: DOWNLOAD_TIMEOUT_MS,
      }).promise;
      const status = typeof result.statusCode === "number" ? result.statusCode : 200;
      if (status < 200 || status >= 300) {
        throw new Error(`kolm-rn download failed with HTTP ${status}`);
      }
    }
    return dest;
  }
  return normalizePlainLocalPath(uri);
}

function normalizeMaxTokens(value) {
  const maxTokens = value ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) {
    throw new Error(`kolm-rn maxTokens must be an integer between 1 and ${MAX_TOKENS}`);
  }
  return maxTokens;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const Kolm = {
  setConfig,

  async load(source) {
    const path = await resolveToLocalPath(source);
    const opts = normalizeConfig(cachedConfig);
    const n = ensureNative();
    const handle = await n.load(path, opts);

    return {
      cid: handle.cid,
      task: handle.task,
      baseModel: handle.base_model,
      async predict(text, predictOpts = {}) {
        if (typeof text !== "string") throw new Error("kolm-rn predict text must be a string");
        const res = await n.predict(handle.handle, text, normalizeMaxTokens(predictOpts.maxTokens));
        return {
          text: res.text,
          cid: handle.cid ?? undefined,
          credential: res.credential ?? undefined,
          latencyMs: res.latency_ms,
        };
      },
      async dispose() {
        await n.dispose(handle.handle);
      },
    };
  },
};

export default Kolm;
