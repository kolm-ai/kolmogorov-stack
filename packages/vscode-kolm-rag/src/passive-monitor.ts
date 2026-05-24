// W819-1 — passive Copilot/Cursor/Claude-Code suggestion-acceptance monitor.
//
// Subscribes to `vscode.workspace.onDidChangeTextDocument` and emits a
// `Capture` into the shared `CaptureQueue` whenever a single contentChange
// inserts a large block of text (>= configurable `minBlockChars`, default 80).
//
// Honest contract:
//   - We can't read Copilot/Cursor/Claude-Code's private accept signal — the
//     APIs are extension-host-private. Instead we detect the SHAPE of an
//     accepted suggestion: a single contentChange whose insertion spans
//     multiple lines OR clears the min-block threshold. This is the same
//     pattern W731's capture-watcher uses.
//   - The `source` field is a best-effort guess based on which AI extension
//     is currently installed/active; when ambiguous it falls back to
//     'unknown'. We NEVER fabricate a specific provider name when we don't
//     have signal.
//   - Backspaces, deletes, single-char keystrokes, and reformatter outputs
//     are filtered out — only NET insertions count.
//
// Designed so this file can be imported under `node --test` via the
// compiled JS — the activate() entry takes its `vscode` dependency via
// parameter, so tests pass a stub.

import type { CaptureQueue, Capture } from './capture-queue';

export const PASSIVE_MONITOR_VERSION = 'w819-v1';

const DEFAULT_MIN_BLOCK_CHARS = 80;

// vscode.* shapes we touch — kept minimal so the package builds standalone
// without pulling the full @types/vscode signature surface into this file.
export interface VsLikeRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface VsLikeContentChange {
  readonly range: VsLikeRange;
  readonly text: string;
  readonly rangeLength: number;
}

export interface VsLikeDocument {
  readonly uri: { toString(): string; fsPath?: string };
  readonly languageId: string;
  readonly fileName: string;
}

export interface VsLikeChangeEvent {
  readonly document: VsLikeDocument;
  readonly contentChanges: ReadonlyArray<VsLikeContentChange>;
}

export interface VsLikeExtension {
  readonly id: string;
  readonly isActive: boolean;
}

export interface VsLikeApi {
  readonly workspace: {
    onDidChangeTextDocument(
      listener: (e: VsLikeChangeEvent) => void
    ): { dispose(): void };
  };
  readonly extensions?: {
    all: ReadonlyArray<VsLikeExtension>;
  };
}

export interface PassiveMonitorOptions {
  readonly enabled?: boolean;
  readonly minBlockChars?: number;
}

export interface PassiveMonitorDeps {
  readonly vscode: VsLikeApi;
  readonly queue: CaptureQueue;
  readonly getOptions: () => PassiveMonitorOptions;
}

export interface PassiveMonitor {
  dispose(): void;
  /** Test seam — feed a synthetic change without going through vscode. */
  _handle(e: VsLikeChangeEvent): void;
  /** Test seam — internal counters. */
  _stats(): { processed: number; emitted: number; dropped: number };
}

/**
 * Heuristic: an "AI completion-like" change is a single contentChange whose
 * inserted text spans multiple lines OR is >= minBlockChars long, AND has
 * net positive insertion (i.e. we didn't simultaneously delete the same
 * amount). Single-key strokes never qualify.
 */
export function isAcceptedSuggestion(
  change: VsLikeContentChange,
  minBlockChars: number
): boolean {
  if (!change || typeof change.text !== 'string' || change.text.length === 0) {
    return false;
  }
  // Net-deletion or near-zero net-edit doesn't count
  const net = change.text.length - (change.rangeLength || 0);
  if (net <= 0) return false;
  const multiline = change.text.indexOf('\n') !== -1;
  if (multiline) return true;
  return change.text.length >= minBlockChars;
}

/**
 * Best-effort provider sniff based on installed/active VS Code extensions.
 * Returns 'unknown' when we can't tell — never fabricates a provider.
 */
export function guessSource(
  vscode: VsLikeApi
): Capture['source'] {
  const exts = vscode.extensions?.all ?? [];
  // Order matters: Claude Code takes precedence over generic Copilot when
  // both are present, because Claude Code's accept-rate is what W819 cares
  // about most.
  const ids = exts.filter((e) => e.isActive).map((e) => e.id.toLowerCase());
  if (ids.some((id) => id.includes('anthropic.claude-code'))) return 'claude-code';
  if (ids.some((id) => id.includes('cursor'))) return 'cursor';
  if (ids.some((id) => id.includes('github.copilot'))) return 'copilot';
  return 'unknown';
}

let __captureCounter = 0;
function nextCaptureId(): string {
  __captureCounter += 1;
  return 'cap_' + Date.now().toString(36) + '_' + __captureCounter.toString(36);
}

export function activate(deps: PassiveMonitorDeps): PassiveMonitor {
  if (!deps?.vscode) {
    throw new Error('passive-monitor.activate: deps.vscode required');
  }
  if (!deps.queue) {
    throw new Error('passive-monitor.activate: deps.queue required');
  }
  const stats = { processed: 0, emitted: 0, dropped: 0 };

  const handle = (e: VsLikeChangeEvent): void => {
    stats.processed += 1;
    const opts = deps.getOptions ? (deps.getOptions() ?? {}) : {};
    if (opts.enabled === false) {
      stats.dropped += 1;
      return;
    }
    const minBlockChars = Number.isFinite(opts.minBlockChars)
      ? Math.max(1, opts.minBlockChars as number)
      : DEFAULT_MIN_BLOCK_CHARS;

    if (!e?.document || !Array.isArray(e.contentChanges)) {
      stats.dropped += 1;
      return;
    }
    let emittedHere = false;
    for (const change of e.contentChanges) {
      if (!isAcceptedSuggestion(change, minBlockChars)) continue;
      const cap: Capture = {
        id: nextCaptureId(),
        uri: e.document.uri.toString(),
        language: e.document.languageId || 'plaintext',
        text: change.text,
        insertedAt: Date.now(),
        source: guessSource(deps.vscode),
      };
      deps.queue.enqueue(cap);
      stats.emitted += 1;
      emittedHere = true;
      // Coalesce: at most one capture per change-event so paste-bundles
      // (snippet expansion with N internal segments) don't spam the queue.
      break;
    }
    if (!emittedHere) stats.dropped += 1;
  };

  const sub = deps.vscode.workspace.onDidChangeTextDocument(handle);

  return {
    dispose: () => {
      try {
        sub.dispose();
      } catch {
        // best-effort
      }
    },
    _handle: handle,
    _stats: () => ({ ...stats }),
  };
}
