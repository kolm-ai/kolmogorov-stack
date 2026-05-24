type Source = number | string | { uri: string };

export type Verify = "off" | "on" | "strict";

export interface KolmConfig {
  verify?: Verify;
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

export function setConfig(cfg: KolmConfig): void;

declare const Kolm: {
  setConfig: typeof setConfig;
  load(source: Source): Promise<KolmModel>;
};

export default Kolm;
