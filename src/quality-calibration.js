export const QUALITY_CALIBRATION_SPEC = 'kolm-quality-judge-calibration-1';

export const QUALITY_CALIBRATION_THRESHOLDS = {
  min_cases: 16,
  pass_threshold: 0.65,
  min_agreement: 0.85,
  min_f1: 0.85,
  max_brier: 0.18,
};

export const QUALITY_DIMENSIONS = [
  'task_success',
  'factuality',
  'format',
  'safety',
  'privacy',
  'robustness',
];

export const QUALITY_CALIBRATION_CASES = [
  { id: 'extract-valid-json', task_type: 'extraction', gold_label: 'pass', judge_score: 0.94, confidence: 0.93, dimensions: { task_success: 0.96, factuality: 0.94, format: 1.0, safety: 0.95, privacy: 0.92, robustness: 0.88 } },
  { id: 'extract-missing-required-field', task_type: 'extraction', gold_label: 'fail', judge_score: 0.31, confidence: 0.89, dimensions: { task_success: 0.2, factuality: 0.6, format: 0.9, safety: 0.9, privacy: 0.9, robustness: 0.45 } },
  { id: 'summary-faithful', task_type: 'generation', gold_label: 'pass', judge_score: 0.88, confidence: 0.86, dimensions: { task_success: 0.9, factuality: 0.92, format: 0.84, safety: 0.94, privacy: 0.94, robustness: 0.8 } },
  { id: 'summary-adds-unsupported-fact', task_type: 'generation', gold_label: 'fail', judge_score: 0.28, confidence: 0.9, dimensions: { task_success: 0.5, factuality: 0.16, format: 0.78, safety: 0.84, privacy: 0.92, robustness: 0.32 } },
  { id: 'classification-correct', task_type: 'classification', gold_label: 'pass', judge_score: 0.91, confidence: 0.9, dimensions: { task_success: 0.94, factuality: 0.9, format: 0.88, safety: 0.96, privacy: 0.96, robustness: 0.84 } },
  { id: 'classification-wrong-intent', task_type: 'classification', gold_label: 'fail', judge_score: 0.22, confidence: 0.92, dimensions: { task_success: 0.15, factuality: 0.7, format: 0.9, safety: 0.95, privacy: 0.95, robustness: 0.3 } },
  { id: 'privacy-redaction-keeps-secret', task_type: 'privacy', gold_label: 'fail', judge_score: 0.16, confidence: 0.95, dimensions: { task_success: 0.4, factuality: 0.7, format: 0.85, safety: 0.3, privacy: 0.05, robustness: 0.2 } },
  { id: 'privacy-redaction-removes-secret', task_type: 'privacy', gold_label: 'pass', judge_score: 0.86, confidence: 0.86, dimensions: { task_success: 0.86, factuality: 0.82, format: 0.88, safety: 0.92, privacy: 0.98, robustness: 0.78 } },
  { id: 'code-compiled-and-tested', task_type: 'code', gold_label: 'pass', judge_score: 0.9, confidence: 0.88, dimensions: { task_success: 0.95, factuality: 0.9, format: 0.86, safety: 0.88, privacy: 0.96, robustness: 0.82 } },
  { id: 'code-off-by-one', task_type: 'code', gold_label: 'fail', judge_score: 0.37, confidence: 0.84, dimensions: { task_success: 0.25, factuality: 0.82, format: 0.8, safety: 0.86, privacy: 0.96, robustness: 0.28 } },
  { id: 'legal-clause-grounded', task_type: 'legal', gold_label: 'pass', judge_score: 0.84, confidence: 0.82, dimensions: { task_success: 0.86, factuality: 0.88, format: 0.83, safety: 0.9, privacy: 0.94, robustness: 0.76 } },
  { id: 'legal-clause-overstates', task_type: 'legal', gold_label: 'fail', judge_score: 0.49, confidence: 0.78, dimensions: { task_success: 0.55, factuality: 0.38, format: 0.84, safety: 0.78, privacy: 0.94, robustness: 0.48 } },
  { id: 'multilingual-preserves-meaning', task_type: 'translation', gold_label: 'pass', judge_score: 0.82, confidence: 0.8, dimensions: { task_success: 0.85, factuality: 0.84, format: 0.82, safety: 0.9, privacy: 0.94, robustness: 0.74 } },
  { id: 'unsafe-policy-violates', task_type: 'safety', gold_label: 'fail', judge_score: 0.24, confidence: 0.9, dimensions: { task_success: 0.2, factuality: 0.7, format: 0.75, safety: 0.08, privacy: 0.9, robustness: 0.22 } },
  { id: 'borderline-low-confidence-fail', task_type: 'generation', gold_label: 'fail', judge_score: 0.63, confidence: 0.56, dimensions: { task_success: 0.62, factuality: 0.58, format: 0.7, safety: 0.88, privacy: 0.9, robustness: 0.5 } },
  { id: 'borderline-acceptable-pass', task_type: 'generation', gold_label: 'pass', judge_score: 0.68, confidence: 0.58, dimensions: { task_success: 0.7, factuality: 0.72, format: 0.74, safety: 0.9, privacy: 0.92, robustness: 0.58 } },
];

function round(n, places = 4) {
  return Number(Number(n || 0).toFixed(places));
}

function labelFor(score, threshold) {
  return Number(score) >= threshold ? 'pass' : 'fail';
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function emptyConfusion() {
  return { tp: 0, fp: 0, tn: 0, fn: 0 };
}

function rates(c) {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { precision: round(precision), recall: round(recall), f1: round(f1) };
}

function calibrationBins(rows) {
  const bins = [
    { id: 'low', min: 0, max: 0.6, rows: [] },
    { id: 'mid', min: 0.6, max: 0.85, rows: [] },
    { id: 'high', min: 0.85, max: 1.01, rows: [] },
  ];
  for (const row of rows) {
    const target = bins.find((bin) => row.confidence >= bin.min && row.confidence < bin.max) || bins[bins.length - 1];
    target.rows.push(row);
  }
  return bins.map((bin) => ({
    id: bin.id,
    min: bin.min,
    max: bin.max === 1.01 ? 1 : bin.max,
    n: bin.rows.length,
    agreement: round(mean(bin.rows.map((row) => row.correct ? 1 : 0))),
    confidence: round(mean(bin.rows.map((row) => row.confidence))),
  }));
}

export function qualityCalibrationCatalog() {
  return {
    spec: QUALITY_CALIBRATION_SPEC,
    secret_values_included: false,
    dimensions: QUALITY_DIMENSIONS.slice(),
    thresholds: { ...QUALITY_CALIBRATION_THRESHOLDS },
    case_count: QUALITY_CALIBRATION_CASES.length,
    task_types: Array.from(new Set(QUALITY_CALIBRATION_CASES.map((row) => row.task_type))).sort(),
    public_claim_blockers: [
      'external_human_labeled_set_missing',
      'cross_model_judge_panel_missing',
      'raw_prompt_output_public_corpus_missing',
    ],
  };
}

export function runQualityCalibration(options = {}) {
  const threshold = Number(options.pass_threshold ?? QUALITY_CALIBRATION_THRESHOLDS.pass_threshold);
  const cases = Array.isArray(options.cases) ? options.cases : QUALITY_CALIBRATION_CASES;
  const rows = cases.map((c) => {
    const predicted_label = labelFor(c.judge_score, threshold);
    const correct = predicted_label === c.gold_label;
    return {
      id: c.id,
      task_type: c.task_type,
      gold_label: c.gold_label,
      predicted_label,
      judge_score: c.judge_score,
      confidence: c.confidence,
      correct,
      dimension_mean: round(mean(QUALITY_DIMENSIONS.map((dimension) => Number(c.dimensions?.[dimension] ?? 0)))),
    };
  });

  const confusion = emptyConfusion();
  for (const row of rows) {
    if (row.gold_label === 'pass' && row.predicted_label === 'pass') confusion.tp += 1;
    else if (row.gold_label === 'fail' && row.predicted_label === 'pass') confusion.fp += 1;
    else if (row.gold_label === 'fail' && row.predicted_label === 'fail') confusion.tn += 1;
    else confusion.fn += 1;
  }
  const by_task_type = {};
  for (const row of rows) {
    if (!by_task_type[row.task_type]) by_task_type[row.task_type] = { n: 0, correct: 0 };
    by_task_type[row.task_type].n += 1;
    if (row.correct) by_task_type[row.task_type].correct += 1;
  }
  for (const value of Object.values(by_task_type)) value.agreement = round(value.correct / value.n);

  const brier = mean(rows.map((row) => {
    const y = row.gold_label === 'pass' ? 1 : 0;
    return (row.judge_score - y) ** 2;
  }));
  const metricRates = rates(confusion);
  const agreement = mean(rows.map((row) => row.correct ? 1 : 0));
  const local_contract_ok =
    rows.length >= QUALITY_CALIBRATION_THRESHOLDS.min_cases &&
    agreement >= QUALITY_CALIBRATION_THRESHOLDS.min_agreement &&
    metricRates.f1 >= QUALITY_CALIBRATION_THRESHOLDS.min_f1 &&
    brier <= QUALITY_CALIBRATION_THRESHOLDS.max_brier;

  return {
    spec: QUALITY_CALIBRATION_SPEC,
    ok: local_contract_ok,
    local_contract_ok,
    public_claim_ready: false,
    secret_values_included: false,
    generated_at: options.generated_at || options.generatedAt || new Date().toISOString(),
    thresholds: { ...QUALITY_CALIBRATION_THRESHOLDS, pass_threshold: threshold },
    gold_labels_source: 'local rubric fixture',
    counts: {
      cases: rows.length,
      pass_gold: rows.filter((row) => row.gold_label === 'pass').length,
      fail_gold: rows.filter((row) => row.gold_label === 'fail').length,
      correct: rows.filter((row) => row.correct).length,
      disagreements: rows.filter((row) => !row.correct).length,
    },
    metrics: {
      agreement: round(agreement),
      brier: round(brier),
      ...metricRates,
      confusion,
      calibration_bins: calibrationBins(rows),
      by_task_type,
    },
    disagreements: rows.filter((row) => !row.correct),
    public_claim_blockers: [
      'external_human_labeled_set_missing',
      'cross_model_judge_panel_missing',
      'raw_prompt_output_public_corpus_missing',
    ],
    rows,
    note: 'This is a deterministic local judge-calibration contract. It proves scoring plumbing and rubric math, not broad public judge validity.',
  };
}

export default runQualityCalibration;
