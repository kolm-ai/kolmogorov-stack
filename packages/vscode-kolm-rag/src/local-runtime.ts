// W819-4 helper — shells out to the local `kolm` CLI runtime to execute a
// distilled artifact against a routed completion request.
//
// Pure TS, no VS Code dependency (so the same code runs under `node --test`).
// Honest contract:
//   - If the CLI binary is not on PATH, returns {ok:false, error:'no_runtime'}
//     instead of throwing. The caller (routing.ts) then falls back to the
//     original teacher request.
//   - Output capture is best-effort — if the CLI emits non-JSON, we still
//     return ok:true with `raw_stdout` populated so the caller can debug.
//   - Timeout default 5s; configurable via env var KOLM_RAG_TIMEOUT_MS.

import { spawn, spawnSync } from 'child_process';

export const LOCAL_RUNTIME_VERSION = 'w819-v1';

export interface LocalRuntimeResult {
  readonly ok: boolean;
  readonly artifact?: string;
  readonly output?: string;
  readonly raw_stdout?: string;
  readonly error?: string;
  readonly latency_ms?: number;
  readonly exit_code?: number;
}

export interface LocalRuntimeOptions {
  readonly cliPath?: string;
  readonly artifactPath: string;
  readonly input: string;
  readonly timeoutMs?: number;
  /** Test seam — inject a custom spawner. */
  readonly _spawn?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CLI = 'kolm';

/**
 * Check whether the kolm CLI is callable. Returns true iff `<cli> --version`
 * exits 0 within 2s. Used by routing.ts to short-circuit before attempting
 * a full run.
 */
export function isLocalRuntimeAvailable(cliPath: string = DEFAULT_CLI): boolean {
  try {
    const r = spawnSync(cliPath, ['--version'], {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    if (r.error) return false;
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run a `.kolm` artifact against `input` via the local CLI. Mirrors the
 * `kolm run <artifact> --input <text> --json` invocation shape used by the
 * runtime-shim tests.
 */
export function runLocalArtifact(
  opts: LocalRuntimeOptions
): Promise<LocalRuntimeResult> {
  return new Promise((resolve) => {
    const cli = opts.cliPath || DEFAULT_CLI;
    const timeoutMs = Math.max(
      100,
      opts.timeoutMs ??
        Number(process.env.KOLM_RAG_TIMEOUT_MS) ||
        DEFAULT_TIMEOUT_MS
    );
    const args = ['run', opts.artifactPath, '--input', opts.input, '--json'];
    const start = Date.now();
    let child;
    try {
      const spawner = opts._spawn || spawn;
      child = spawner(cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (err) {
      resolve({
        ok: false,
        error: 'no_runtime',
        artifact: opts.artifactPath,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const finish = (result: LocalRuntimeResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // best-effort
      }
      finish({
        ok: false,
        error: 'timeout',
        artifact: opts.artifactPath,
        latency_ms: Date.now() - start,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: err.message.includes('ENOENT') ? 'no_runtime' : err.message,
        artifact: opts.artifactPath,
        latency_ms: Date.now() - start,
      });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const latency_ms = Date.now() - start;
      if (code !== 0) {
        finish({
          ok: false,
          error: stderr.trim() || 'non_zero_exit',
          artifact: opts.artifactPath,
          exit_code: code ?? -1,
          raw_stdout: stdout,
          latency_ms,
        });
        return;
      }
      // Best-effort JSON parse — fall back to raw stdout.
      try {
        const parsed = JSON.parse(stdout);
        finish({
          ok: true,
          artifact: opts.artifactPath,
          output:
            typeof parsed?.output === 'string'
              ? parsed.output
              : JSON.stringify(parsed?.output ?? parsed),
          raw_stdout: stdout,
          latency_ms,
          exit_code: code,
        });
      } catch {
        finish({
          ok: true,
          artifact: opts.artifactPath,
          output: stdout.trim(),
          raw_stdout: stdout,
          latency_ms,
          exit_code: code,
        });
      }
    });
  });
}
