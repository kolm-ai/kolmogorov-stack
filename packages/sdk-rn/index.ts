// kolm-rn - one-line embed for .kolm artifacts in React Native.
//
// The TS layer:
//   1. Resolves the source (require / file:// / https://) to a local path
//   2. Validates wrapper config, URI shape, download status, and token bounds
//   3. Hands the local path to the native module, which verifies the artifact
//      and dispatches to Core ML / MLX / llama.cpp on iOS and ExecuTorch /
//      llama.cpp / ONNX on Android
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

type RnFsShape = {
  CachesDirectoryPath: string;
  exists(path: string): Promise<boolean>;
  downloadFile(opts: {
    fromUrl: string;
    toFile: string;
    readTimeout?: number;
    connectionTimeout?: number;
  }): { promise: Promise<{ statusCode?: number }> };
};

const native = (NativeModules.KolmRN as KolmNativeShape | undefined) ?? null;
const VALID_VERIFY = new Set<Verify>(["off", "on", "strict"]);
const DEFAULT_MAX_TOKENS = 256;
const MAX_TOKENS = 32768;
const DOWNLOAD_TIMEOUT_MS = 30000;

let cachedConfig: KolmConfig = { verify: "on" };

function ensureNative(): KolmNativeShape {
  if (!native) {
    throw new Error(
      `kolm-rn native module not linked on ${Platform.OS}. iOS: pod install. Android: rebuild after adding kolm-rn to package.json.`
    );
  }
  return native;
}

function normalizeConfig(cfg: KolmConfig): KolmConfig {
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

export function setConfig(cfg: KolmConfig): void {
  cachedConfig = normalizeConfig({ ...cachedConfig, ...cfg });
}

function fileUriToPath(uri: string): string {
  const raw = uri.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizePlainLocalPath(uri: string): string {
  if (typeof uri !== "string" || uri.trim().length === 0 || uri.includes("\0")) {
    throw new Error("kolm-rn source URI/path must be a non-empty string");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
    throw new Error("kolm-rn source must be require(...), file://, https://, or a local filesystem path");
  }
  return uri;
}

function cacheFileName(uri: string): string {
  const suffix = encodeURIComponent(uri)
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 96) || "remote";
  return `${hash(uri)}-${suffix}.kolm`;
}

async function resolveToLocalPath(source: Source): Promise<string> {
  if (typeof source === "number") {
    // require(...) returns an asset id. RN's `Asset` API converts it to
    // a local filesystem URI on iOS/Android.
    const { Asset } = await import("expo-asset").catch(() => ({ Asset: null }) as any);
    if (Asset) {
      const asset = await Asset.fromModule(source).downloadAsync();
      if (typeof asset.localUri === "string" && asset.localUri.startsWith("file://")) {
        return fileUriToPath(asset.localUri);
      }
    }
    throw new Error(
      "kolm-rn require(...) loading needs expo-asset, or supply a file:// or https:// URI."
    );
  }
  const uri = typeof source === "string" ? source : source?.uri;
  if (typeof uri !== "string") throw new Error("kolm-rn source object must include a string uri");
  if (uri.startsWith("file://")) return fileUriToPath(uri);
  if (uri.startsWith("https://")) {
    const RNFS = (await import("react-native-fs").catch(() => null as any)) as RnFsShape | null;
    if (!RNFS) {
      throw new Error(
        "kolm-rn https:// loading needs react-native-fs. `npm install react-native-fs` and rebuild."
      );
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

function normalizeMaxTokens(value: number | undefined): number {
  const maxTokens = value ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) {
    throw new Error(`kolm-rn maxTokens must be an integer between 1 and ${MAX_TOKENS}`);
  }
  return maxTokens;
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
    const opts = normalizeConfig(cachedConfig);
    const n = ensureNative();
    const handle = await n.load(path, opts as { verify: Verify; secret?: string });

    return {
      cid: handle.cid,
      task: handle.task,
      baseModel: handle.base_model,
      async predict(text: string, predictOpts: PredictOptions = {}): Promise<KolmOutput> {
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
