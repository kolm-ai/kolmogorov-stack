export declare const VERSION = "0.2.6";

export declare class VerificationError extends Error {
  constructor(message: string);
}

export interface KolmOutput {
  text: string;
  cid?: string;
  credential?: string;
  latency_ms: number;
}

export interface ManifestHashes {
  [path: string]: string;
}

export interface Manifest {
  cid?: string;
  spec?: string;
  hashes?: ManifestHashes;
  task?: string;
  base_model?: string;
  [k: string]: unknown;
}

export interface Receipt {
  signature?: string;
  manifest_cid?: string;
  [k: string]: unknown;
}

export interface LoadOptions {
  secret?: string | Buffer;
  endpoint?: string;
  apiKey?: string;
  skipHashCheck?: boolean;
}

export declare function canonicalJson(obj: unknown): string;

export declare class KolmModel {
  readonly cid?: string;
  readonly manifest: Manifest;
  readonly credential?: Record<string, unknown>;
  constructor(
    manifest: Manifest,
    credential: Record<string, unknown> | undefined,
    endpoint: string | undefined,
    apiKey: string | undefined
  );
  predict(input: string): Promise<KolmOutput>;
}

export declare function load(pathOrBuffer: string | Uint8Array, options?: LoadOptions): Promise<KolmModel>;
export declare function loadBuffer(buf: Uint8Array, options?: LoadOptions): Promise<KolmModel>;

declare const _default: {
  load: typeof load;
  loadBuffer: typeof loadBuffer;
  canonicalJson: typeof canonicalJson;
  VERSION: typeof VERSION;
  VerificationError: typeof VerificationError;
  KolmModel: typeof KolmModel;
};

export default _default;
