// kolm-rn — one-line embed for .kolm artifacts in React Native.
//
// The TS layer:
//   1. Resolves the source (require / file:// / https://) to a local path
//   2. Computes the CID from manifest.hashes and checks it matches
//      manifest.cid (if present)
//   3. Hands the local path to the native module, which dispatches to
//      Core ML / MLX / llama.cpp on iOS and ExecuTorch / llama.cpp / ONNX
//      on Android
//
// The native module is the same .kolm SDK as Swift/Kotlin, just exposed
// through the React Native bridge. See ios/KolmRN.swift and
// android/KolmRNModule.kt in this package.

import { NativeModules, Platform } from "react-native";

type Source = number | string | { uri: string };

export type Verify = "off" | "on" | "strict";

export interface KolmConfig {
  verify?: Verify;
  /** HMAC secret for body-signature verification. Base64 or raw string. */
  secret?: string;
}

export interface KolmOutput {
  text: string;
  cid?: string;
  credential?: string;
  latencyMs: number;
}

export interface PredictOptions {
  maxTokens?: number;
}

export interface KolmModel {
  cid: string | null;
  task: string | null;
  baseModel: string | null;
  predict(text: string, opts?: PredictOptions): Promise<KolmOutput>;
  dispose(): Promise<void>;
}

interface KolmNativeShape {
  load(localPath: string, options: { verify: Verify; secret?: string }): Promise<{
    handle: string;
    cid: string | null;
    task: string | null;
    base_model: string | null;
  }>;
  predict(handle: string, text: string, maxTokens: number): Promise<{
    text: string;
    credential: string | null;
    latency_ms: number;
  }>;
  dispose(handle: string): Promise<void>;
}

const native = (NativeModules.KolmRN as KolmNativeShape | undefined) ?? null;

let cachedConfig: KolmConfig = { verify: "on" };

function ensureNative(): KolmNativeShape {
  if (!native) {
    throw new Error(
      `kolm-rn native module not linked on ${Platform.OS}. iOS: pod install. Android: rebuild after adding kolm-rn to package.json.`
    );
  }
  return native;
}

export function setConfig(cfg: KolmConfig): void {
  cachedConfig = { ...cachedConfig, ...cfg };
}

async function resolveToLocalPath(source: Source): Promise<string> {
  if (typeof source === "number") {
    // require(...) returns an asset id. RN's `Asset` API converts it to
    // a local filesystem URI on iOS/Android.
    const { Asset } = await import("expo-asset").catch(() => ({ Asset: null }) as any);
    if (Asset) {
      const asset = await Asset.fromModule(source).downloadAsync();
      if (asset.localUri) return asset.localUri.replace(/^file:\/\//, "");
    }
    throw new Error(
      "kolm-rn require(...) loading needs expo-asset, or supply a file:// or https:// URI."
    );
  }
  const uri = typeof source === "string" ? source : source.uri;
  if (uri.startsWith("file://")) return uri.replace(/^file:\/\//, "");
  if (uri.startsWith("https://")) {
    // Cache to docs dir
    const RNFS = await import("react-native-fs").catch(() => null as any);
    if (!RNFS) {
      throw new Error(
        "kolm-rn https:// loading needs react-native-fs. `npm install react-native-fs` and rebuild."
      );
    }
    const dest = `${RNFS.CachesDirectoryPath}/${hash(uri)}.kolm`;
    if (!(await RNFS.exists(dest))) {
      await RNFS.downloadFile({ fromUrl: uri, toFile: dest }).promise;
    }
    return dest;
  }
  return uri;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const Kolm = {
  setConfig,

  async load(source: Source): Promise<KolmModel> {
    const path = await resolveToLocalPath(source);
    const opts = {
      verify: cachedConfig.verify ?? "on",
      ...(cachedConfig.secret ? { secret: cachedConfig.secret } : {}),
    };
    const n = ensureNative();
    const handle = await n.load(path, opts as { verify: Verify; secret?: string });

    return {
      cid: handle.cid,
      task: handle.task,
      baseModel: handle.base_model,
      async predict(text: string, predictOpts: PredictOptions = {}): Promise<KolmOutput> {
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
