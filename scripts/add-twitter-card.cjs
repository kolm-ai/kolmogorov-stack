const fs = require('fs');
const path = require('path');

const targets = [
  'public/changelog.html', 'public/compare.html', 'public/defense.html',
  'public/faq.html', 'public/finance.html', 'public/glossary.html',
  'public/healthcare.html', 'public/integrations.html', 'public/press.html',
  'public/roi.html', 'public/run.html', 'public/spec-grammar.html',
  'public/spec.html', 'public/threat-model.html', 'public/troubleshooting.html',
  'public/vs-fine-tune.html', 'public/vs-hindsight.html', 'public/vs-langsmith.html',
  'public/vs-mem0.html', 'public/vs-ollama.html', 'public/vs-openai-fine-tune.html',
  'public/vs-openpipe.html', 'public/vs-predibase.html', 'public/vs-rag.html',
  'public/vs-together.html', 'public/why-now.html',
  'public/cookbook/bug-spotter.html', 'public/cookbook/calendar-summary.html',
  'public/cookbook/churn-predict.html', 'public/cookbook/daily-recap.html',
  'public/cookbook/docstring.html', 'public/cookbook/email-reply.html',
  'public/cookbook/embedded-sensor-classifier.html', 'public/cookbook/feature-spec-from-issue.html',
  'public/cookbook/finance-disclosure-redact.html', 'public/cookbook/hipaa-summarizer.html',
  'public/cookbook/incident-summarizer.html', 'public/cookbook/k-score-explainer.html',
  'public/cookbook/legal-clause-extract.html', 'public/cookbook/log-grep.html',
  'public/cookbook/nps-classifier.html', 'public/cookbook/on-call-page-classifier.html',
  'public/cookbook/photo-grouper.html', 'public/cookbook/pr-review.html',
  'public/cookbook/pricing-quote.html', 'public/cookbook/recall-namespace-tagger.html',
  'public/cookbook/recipe-from-observations.html', 'public/cookbook/refactor.html',
  'public/cookbook/runbook-step.html', 'public/cookbook/slack-thread-summarizer.html',
  'public/cookbook/support-reply.html', 'public/cookbook/test-gen.html',
  'public/cookbook/type-hint.html', 'public/cookbook/verifier-from-examples.html',
  'public/cookbook/voice-memo-to-task.html', 'public/cookbook/web3-address-screener.html',
  'public/articles/distillation-vs-fine-tuning-vs-rag.html', 'public/articles/index.html',
  'public/articles/running-our-marketing-on-distilled-models.html', 'public/articles/why-we-built-kolm.html'
];

let touched = 0;
for (const f of targets) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch (e) { console.warn('miss', f); continue; }
  if (/twitter:card/i.test(s)) continue;
  const ogImageRe = /(<meta\s+property="og:image"[^>]*>)/i;
  const m = s.match(ogImageRe);
  if (!m) { console.warn('no og:image in', f); continue; }

  const titleM = s.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const descM = s.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  const imgM = s.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (!titleM || !descM || !imgM) { console.warn('missing og fields', f); continue; }

  const inject = `\n<meta name="twitter:card" content="summary_large_image" />\n<meta name="twitter:title" content="${titleM[1]}" />\n<meta name="twitter:description" content="${descM[1]}" />\n<meta name="twitter:image" content="${imgM[1]}" />`;

  const ogTypeRe = /(<meta\s+property="og:type"[^>]*>)/i;
  const tm = s.match(ogTypeRe);
  if (tm) {
    s = s.replace(ogTypeRe, `${tm[1]}${inject}`);
  } else {
    s = s.replace(ogImageRe, `${m[1]}${inject}`);
  }
  fs.writeFileSync(f, s);
  touched++;
}
console.log('twitter:card added to', touched, 'files');
