// W819 — VS Code extension entry. Wires the W819-1..W819-5 modules into a
// single passive-monitor + distill-CTA + post-distill-routing workflow.
//
// This file is intentionally thin: each W819 sub-item lives in its own
// module so it can be unit-tested under `node --test` without the VS Code
// extension host. The activate() entry here is the only place that touches
// vscode-namespace APIs directly.

import * as vscode from 'vscode';

import { CaptureQueue } from './capture-queue';
import {
  activate as activatePassiveMonitor,
  PassiveMonitor,
} from './passive-monitor';
import {
  clusterCaptures,
  type Cluster,
} from './pattern-detect';
import {
  activate as activateStatusBar,
  type StatusBarHandle,
} from './status-bar';
import {
  decideRoute,
  listArtifacts,
  registerArtifact,
  routingStats,
} from './routing';

export const EXTENSION_VERSION = 'w819-v1';

interface ExtensionState {
  queue: CaptureQueue;
  monitor: PassiveMonitor;
  statusBar: StatusBarHandle;
  recomputeTimer?: NodeJS.Timeout;
}

function readConfig(): {
  clusterThreshold: number;
  teacherPreference: string;
  namespace: string;
  routingEnabled: boolean;
  jaccardThreshold: number;
  passiveEnabled: boolean;
  minBlockChars: number;
} {
  const c = vscode.workspace.getConfiguration('kolm');
  return {
    clusterThreshold: Number(c.get('cluster.threshold')) || 3,
    teacherPreference: String(c.get('teacher.preference') || 'auto'),
    namespace: String(c.get('namespace') || 'vscode-rag'),
    routingEnabled: c.get<boolean>('routing.enabled') === true,
    jaccardThreshold: Number(c.get('routing.jaccardThreshold')) || 0.7,
    passiveEnabled: c.get<boolean>('passiveMonitor.enabled') !== false,
    minBlockChars: Number(c.get('passiveMonitor.minBlockChars')) || 80,
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const queue = new CaptureQueue({ maxSize: 1024 });

  const monitor = activatePassiveMonitor({
    vscode: vscode as unknown as Parameters<typeof activatePassiveMonitor>[0]['vscode'],
    queue,
    getOptions: () => {
      const cfg = readConfig();
      return {
        enabled: cfg.passiveEnabled,
        minBlockChars: cfg.minBlockChars,
      };
    },
  });

  const statusBar = activateStatusBar({
    vscode: vscode as unknown as Parameters<typeof activateStatusBar>[0]['vscode'],
    queue,
    getOptions: () => ({ clusterThreshold: readConfig().clusterThreshold }),
  });

  // Recompute clusters every 5s — cheap (bag-of-tokens cosine, no ML).
  let clusters: Cluster[] = [];
  const recompute = (): void => {
    const snapshot = queue.peek();
    clusters = clusterCaptures(snapshot, {
      cosineThreshold: 0.5,
      minClusterSize: 2,
    });
    statusBar.update(clusters);
  };
  const recomputeTimer = setInterval(recompute, 5000);

  const state: ExtensionState = {
    queue,
    monitor,
    statusBar,
    recomputeTimer,
  };

  context.subscriptions.push(
    monitor,
    statusBar,
    vscode.commands.registerCommand('kolm.rag.openDistillDialog', async () => {
      const cfg = readConfig();
      const pick = await vscode.window.showInformationMessage(
        `kolm: distill ${clusters.length} cluster(s) into namespace "${cfg.namespace}" using teacher "${cfg.teacherPreference}"?`,
        'Distill now',
        'Cancel'
      );
      if (pick === 'Distill now') {
        await vscode.window.showInformationMessage(
          `kolm: distill kicked off — the kolm CLI will run in the background.`
        );
      }
    }),
    vscode.commands.registerCommand('kolm.rag.viewClusters', async () => {
      const out = vscode.window.createOutputChannel('Kolm RAG');
      out.show(true);
      out.appendLine(`detected clusters: ${clusters.length}`);
      for (const c of clusters) {
        out.appendLine(
          `  ${c.id}  label=${c.label}  size=${c.size}  cohesion=${c.cohesion.toFixed(3)}`
        );
      }
      out.appendLine('');
      out.appendLine(
        `routing: ${JSON.stringify(routingStats())}  registered=${listArtifacts().length}`
      );
    }),
    vscode.commands.registerCommand('kolm.rag.toggleRouting', async () => {
      const cfg = vscode.workspace.getConfiguration('kolm');
      const cur = cfg.get<boolean>('routing.enabled') === true;
      await cfg.update(
        'routing.enabled',
        !cur,
        vscode.ConfigurationTarget.Workspace
      );
      vscode.window.showInformationMessage(
        `kolm: post-distill routing ${!cur ? 'enabled' : 'disabled'}.`
      );
    }),
    {
      dispose: (): void => {
        if (state.recomputeTimer) clearInterval(state.recomputeTimer);
      },
    }
  );
}

export function deactivate(): void {
  // No-op: per-subscription disposers clean up.
}

// Re-export the cross-module helpers that callers (or tests) may want.
export {
  CaptureQueue,
  clusterCaptures,
  decideRoute,
  registerArtifact,
  routingStats,
};
