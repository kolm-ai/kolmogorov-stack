import { NativeModules, Platform } from "react-native";

const native = NativeModules.KolmRN ?? null;
let cachedConfig = { verify: "on" };

function ensureNative() {
  if (!native) {
    throw new Error(
      `kolm-rn native module not linked on ${Platform.OS}. iOS: pod install. Android: rebuild after adding kolm-rn to package.json.`
    );
  }
  return native;
}

export function setConfig(cfg) {
  cachedConfig = { ...cachedConfig, ...cfg };
}

async function resolveToLocalPath(source) {
  if (typeof source === "number") {
    const { Asset } = await import("expo-asset").catch(() => ({ Asset: null }));
    if (Asset) {
      const asset = await Asset.fromModule(source).downloadAsync();
      if (asset.localUri) return asset.localUri.replace(/^file:\/\//, "");
    }
    throw new Error("kolm-rn require(...) loading needs expo-asset, or supply a file:// or https:// URI.");
  }
  const uri = typeof source === "string" ? source : source.uri;
  if (uri.startsWith("file://")) return uri.replace(/^file:\/\//, "");
  if (uri.startsWith("https://")) {
    const RNFS = await import("react-native-fs").catch(() => null);
    if (!RNFS) {
      throw new Error("kolm-rn https:// loading needs react-native-fs. `npm install react-native-fs` and rebuild.");
    }
    const dest = `${RNFS.CachesDirectoryPath}/${hash(uri)}.kolm`;
    if (!(await RNFS.exists(dest))) {
      await RNFS.downloadFile({ fromUrl: uri, toFile: dest }).promise;
    }
    return dest;
  }
  return uri;
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
    const opts = {
      verify: cachedConfig.verify ?? "on",
      ...(cachedConfig.secret ? { secret: cachedConfig.secret } : {}),
    };
    const n = ensureNative();
    const handle = await n.load(path, opts);

    return {
      cid: handle.cid,
      task: handle.task,
      baseModel: handle.base_model,
      async predict(text, predictOpts = {}) {
        const res = await n.predict(handle.handle, text, predictOpts.maxTokens ?? 256);
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
