// W711-4 — distill report blocks.
//
// This file is the home for diagnostic report blocks the distill pipeline
// emits. W711 ships the importance-distribution block; W741 (planned) will
// ship the feedback-aggregation block. Future waves should ADD exports here
// rather than create one-off block modules.
//
// Every block exporter is a PURE FUNCTION that takes a structured input and
// returns a serializable object. The caller is responsible for embedding the
// block in whatever envelope it's surfacing (CLI JSON, W741 diagnostic
// envelope, /v1/distill/report API, ...).
//
// Block envelope contract (every exporter MUST emit):
//   {
//     block_kind: <string>,         // identifies the block class
//     block_version: <string>,      // version of THIS exporter's schema
//     scorer_version: <string|null>,// version of the scorer that produced inputs
//     interpretation_hint: <string>,// 1-line hint surfaced to humans
//     ...block-specific fields
//   }
//
// The block_version and scorer_version are deliberately distinct: a block
// schema can stabilize while the underlying scorer evolves through v2/v3.

import { IMPORTANCE_VERSION } from './capture-importance.js';

export const IMPORTANCE_BLOCK_KIND = 'importance_distribution';
export const IMPORTANCE_BLOCK_VERSION = 'w711-v1';

/**
 * Build the importance-distribution report block.
 *
 * Takes pre-computed top-N and bottom-N arrays (typically from
 * topNByImportance / bottomNByImportance) and wraps them in the structured
 * envelope downstream diagnostic surfaces consume.
 *
 * Pure function — depends only on the inputs. No I/O.
 *
 * @param {object} params
 * @param {Array<{capture_id: string, score: number, components: object}>} params.topN
 * @param {Array<{capture_id: string, score: number, components: object}>} params.bottomN
 * @param {string} [params.scorerVersion]  defaults to IMPORTANCE_VERSION
 * @returns {{
 *   block_kind: string,
 *   block_version: string,
 *   scorer_version: string,
 *   top_n: Array,
 *   bottom_n: Array,
 *   interpretation_hint: string,
 * }}
 */
export function buildImportanceReportBlock(params = {}) {
  const topN = Array.isArray(params.topN) ? params.topN : [];
  const bottomN = Array.isArray(params.bottomN) ? params.bottomN : [];
  const scorerVersion = typeof params.scorerVersion === 'string' && params.scorerVersion.length > 0
    ? params.scorerVersion
    : IMPORTANCE_VERSION;
  return {
    block_kind: IMPORTANCE_BLOCK_KIND,
    block_version: IMPORTANCE_BLOCK_VERSION,
    scorer_version: scorerVersion,
    top_n: topN,
    bottom_n: bottomN,
    interpretation_hint:
      'Top-N drive learning; bottom-N candidates for dedup or drop.',
  };
}

export default {
  IMPORTANCE_BLOCK_KIND,
  IMPORTANCE_BLOCK_VERSION,
  buildImportanceReportBlock,
};
