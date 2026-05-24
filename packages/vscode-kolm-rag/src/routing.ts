// W819-4 — post-distill routing.
//
// After a distill job completes, the kolm runtime emits a JSON manifest
// linking a `.kolm` artifact to the fingerprint of the cluster it covers.
// This module:
//
//   1. Maintains an in-memory routing table  cluster_fingerprint -> artifact.
//   2. For each new completion request, computes Jaccard similarity between
//      the request's prompt and every registered fingerprint.
//   3. If the best-match similarity > `kolm.routing.jaccardThreshold`
//      (default 0.7), routes the request to the local student via
//      `local-runtime.runLocalArtifact`. Otherwise yields back to the
//      original teacher path.
//
// Honest contract:
//   - This module owns NO transport. Callers feed in completion requests
//     synchronously and receive a routing decision + (optionally) the
//     local-runtime output.
//   - Routing is INTENT-ONLY when `kolm.routing.enabled` is false. We still
//     compute the match so the dashboard can surface "would have routed X
//     of Y requests" telemetry.

import {
  jaccardShingles,
  shingleTokens,
  tokenize,
} from './pattern-detect';
import type { LocalRuntimeResult } from './local-runtime';
import { runLocalArtifact } from './local-runtime';

export const ROUTING_VERSION = 'w819-v1';

export interface RoutingEntry {
  readonly clusterId: string;
  readonly artifactPath: string;
  readonly fingerprint: readonly string[];
  readonly label: string;
  readonly registeredAt: number;
}

export interface RoutingOptions {
  readonly enabled?: boolean;
  readonly jaccardThreshold?: number;
}

export interface RoutingDecision {
  readonly action: 'route' | 'pass-through' | 'would-route';
  readonly bestMatch?: {
    readonly clusterId: string;
    readonly artifactPath: string;
    readonly similarity: number;
  };
  readonly reason?: string;
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_SHINGLE_SIZE = 3;

const __table = new Map<string, RoutingEntry>();
const __stats = { routed: 0, wouldRoute: 0, passThrough: 0 };

/** Register a freshly-distilled artifact against its cluster fingerprint. */
export function registerArtifact(entry: {
  clusterId: string;
  artifactPath: string;
  fingerprint: ReadonlyArray<string>;
  label?: string;
}): RoutingEntry {
  const rec: RoutingEntry = {
    clusterId: entry.clusterId,
    artifactPath: entry.artifactPath,
    fingerprint: entry.fingerprint.slice(),
    label: entry.label ?? 'other',
    registeredAt: Date.now(),
  };
  __table.set(entry.clusterId, rec);
  return rec;
}

export function unregisterArtifact(clusterId: string): boolean {
  return __table.delete(clusterId);
}

export function listArtifacts(): readonly RoutingEntry[] {
  return Array.from(__table.values());
}

/**
 * Decide whether to route a completion request to a local student.
 * NO side-effects beyond updating routing-stats counters.
 */
export function decideRoute(
  promptText: string,
  options: RoutingOptions = {}
): RoutingDecision {
  const threshold = Math.min(
    1,
    Math.max(0, options.jaccardThreshold ?? DEFAULT_THRESHOLD)
  );
  if (typeof promptText !== 'string' || promptText.length === 0) {
    __stats.passThrough += 1;
    return { action: 'pass-through', reason: 'empty_prompt' };
  }
  if (__table.size === 0) {
    __stats.passThrough += 1;
    return { action: 'pass-through', reason: 'no_registered_artifacts' };
  }

  const promptShingles = shingleTokens(
    tokenize(promptText),
    DEFAULT_SHINGLE_SIZE
  );

  let best: { entry: RoutingEntry; sim: number } | null = null;
  for (const entry of __table.values()) {
    const sim = jaccardShingles(promptShingles, entry.fingerprint);
    if (!best || sim > best.sim) {
      best = { entry, sim };
    }
  }
  if (!best || best.sim < threshold) {
    __stats.passThrough += 1;
    return {
      action: 'pass-through',
      bestMatch: best
        ? {
            clusterId: best.entry.clusterId,
            artifactPath: best.entry.artifactPath,
            similarity: best.sim,
          }
        : undefined,
      reason: 'below_threshold',
    };
  }
  const matchSummary = {
    clusterId: best.entry.clusterId,
    artifactPath: best.entry.artifactPath,
    similarity: best.sim,
  };
  if (options.enabled === false) {
    __stats.wouldRoute += 1;
    return { action: 'would-route', bestMatch: matchSummary };
  }
  __stats.routed += 1;
  return { action: 'route', bestMatch: matchSummary };
}

/**
 * High-level helper: decide + (if applicable) execute via local-runtime.
 * Returns the routing decision alongside the local-runtime result (if any).
 */
export async function routeAndRun(
  promptText: string,
  options: RoutingOptions & {
    cliPath?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ decision: RoutingDecision; runtime?: LocalRuntimeResult }> {
  const decision = decideRoute(promptText, options);
  if (decision.action !== 'route' || !decision.bestMatch) {
    return { decision };
  }
  const runtime = await runLocalArtifact({
    artifactPath: decision.bestMatch.artifactPath,
    input: promptText,
    cliPath: options.cliPath,
    timeoutMs: options.timeoutMs,
  });
  return { decision, runtime };
}

export function routingStats(): {
  readonly routed: number;
  readonly wouldRoute: number;
  readonly passThrough: number;
  readonly registered: number;
} {
  return {
    routed: __stats.routed,
    wouldRoute: __stats.wouldRoute,
    passThrough: __stats.passThrough,
    registered: __table.size,
  };
}

/** Test seam — clears registered routes + counters. */
export function _resetForTests(): void {
  __table.clear();
  __stats.routed = 0;
  __stats.wouldRoute = 0;
  __stats.passThrough = 0;
}
