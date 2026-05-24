// W819-3 — status bar entry: capture count + "ready to distill" CTA.
//
// Shows in the bottom-right status bar:
//
//    kolm: 47 captures · 4 clusters (ready)
//
// Lights up the "(ready)" suffix once `cluster_count >= kolm.cluster.threshold`
// (default 3). Click opens an information-message dialog with the buttons
// "Distill now" and "Snooze 1h" — selecting "Distill now" executes the
// command `kolm.rag.openDistillDialog`.
//
// Honest contract: this file holds NO domain logic. The cluster count is
// pushed in via `update()` — the pattern-detect module owns the clustering;
// the status bar is a pure view.

import type { CaptureQueue } from './capture-queue';
import type { Cluster } from './pattern-detect';

export const STATUS_BAR_VERSION = 'w819-v1';

export interface VsLikeStatusBarItem {
  text: string;
  tooltip?: string;
  command?: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface VsLikeWindow {
  createStatusBarItem(
    alignment: number,
    priority?: number
  ): VsLikeStatusBarItem;
  showInformationMessage(
    message: string,
    ...items: string[]
  ): Thenable<string | undefined>;
}

export interface VsLikeCommands {
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  registerCommand(
    command: string,
    handler: (...args: unknown[]) => unknown
  ): { dispose(): void };
}

export interface VsLikeMinimalApi {
  readonly window: VsLikeWindow;
  readonly commands: VsLikeCommands;
  readonly StatusBarAlignment: { Right: number; Left: number };
}

export interface StatusBarOptions {
  readonly clusterThreshold?: number;
}

export interface StatusBarDeps {
  readonly vscode: VsLikeMinimalApi;
  readonly queue: CaptureQueue;
  readonly getOptions: () => StatusBarOptions;
}

export interface StatusBarHandle {
  update(clusters: ReadonlyArray<Cluster>): void;
  /** Test seam — render the current text without going through vscode. */
  _renderText(): string;
  /** Test seam — current ready flag. */
  _isReady(): boolean;
  dispose(): void;
}

const DEFAULT_CLUSTER_THRESHOLD = 3;

export function formatStatusBarText(
  captureCount: number,
  clusterCount: number,
  ready: boolean
): string {
  const captureWord = captureCount === 1 ? 'capture' : 'captures';
  const clusterWord = clusterCount === 1 ? 'cluster' : 'clusters';
  const tail = ready ? ' (ready)' : '';
  return `$(database) kolm: ${captureCount} ${captureWord} · ${clusterCount} ${clusterWord}${tail}`;
}

export function activate(deps: StatusBarDeps): StatusBarHandle {
  if (!deps?.vscode) {
    throw new Error('status-bar.activate: deps.vscode required');
  }
  if (!deps.queue) {
    throw new Error('status-bar.activate: deps.queue required');
  }
  const alignment = deps.vscode.StatusBarAlignment?.Right ?? 2;
  const item = deps.vscode.window.createStatusBarItem(alignment, 100);
  item.command = 'kolm.rag.statusBarClicked';

  let clusterCount = 0;
  let ready = false;

  const render = (): void => {
    const opts = deps.getOptions ? (deps.getOptions() ?? {}) : {};
    const threshold = Number.isFinite(opts.clusterThreshold)
      ? Math.max(1, opts.clusterThreshold as number)
      : DEFAULT_CLUSTER_THRESHOLD;
    ready = clusterCount >= threshold;
    const captureCount = deps.queue.size();
    item.text = formatStatusBarText(captureCount, clusterCount, ready);
    item.tooltip = ready
      ? `kolm: ${clusterCount} repetition clusters detected — click to distill.`
      : `kolm: watching for repetition. Need ${Math.max(0, threshold - clusterCount)} more cluster(s) before distill is recommended.`;
    item.show();
  };

  // Update on every new capture (cheap — pattern-detect runs separately).
  const off = deps.queue.onCapture(() => render());

  // Register the click handler — opens an information-message dialog.
  const clickSub = deps.vscode.commands.registerCommand(
    'kolm.rag.statusBarClicked',
    async () => {
      if (!ready) {
        await deps.vscode.window.showInformationMessage(
          `kolm: ${clusterCount} cluster(s) detected — collect more before distilling.`
        );
        return;
      }
      const pick = await deps.vscode.window.showInformationMessage(
        `kolm: ${clusterCount} repetition clusters ready to distill. Open the distill dialog?`,
        'Distill now',
        'Snooze 1h'
      );
      if (pick === 'Distill now') {
        await deps.vscode.commands.executeCommand('kolm.rag.openDistillDialog');
      }
    }
  );

  render();

  return {
    update: (clusters: ReadonlyArray<Cluster>) => {
      clusterCount = clusters.length;
      render();
    },
    _renderText: () => item.text,
    _isReady: () => ready,
    dispose: () => {
      try {
        off();
      } catch {
        // best-effort
      }
      try {
        clickSub.dispose();
      } catch {
        // best-effort
      }
      try {
        item.dispose();
      } catch {
        // best-effort
      }
    },
  };
}
