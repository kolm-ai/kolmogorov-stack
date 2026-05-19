// examples/demo-log-triage/recipe.js
//
// W396 demo-log-triage — the canonical "close the loop" demo recipe.
// Classifies a single log/error/exception line into one of 6 categories
// using a deterministic keyword matrix. The /v1/recipes/run sandbox forbids
// import/require, so this file is a self-contained generate(input, lib)
// body (same constraint as examples/claims-redactor/recipe.js).
//
// Categories (ordered by precedence — first match wins on ties):
//   db        — postgres / mysql / connection / deadlock / SQL timeouts
//   network   — DNS / TCP / 502/503/504 / SSL/TLS / socket / refused
//   auth      — 401 / 403 / token / JWT / signature / expired
//   deploy    — k8s / helm / terraform / docker / OOM-on-pod / build
//   app-bug   — NullPointer / TypeError / undefined / segfault / panic
//   infra     — ENOSPC / disk / CPU / throttle / rate limit (last resort)
//
// Output schema: { category, signals, confidence }. signals is the sorted
// unique set of keywords that matched (helpful for human review). confidence
// is 1.0 when exactly one category matched, else (matchedCount / totalRules)
// — a heuristic, but stable per input so the K-score is deterministic.

function generate(input, lib) {
  var raw = (typeof input === 'string')
    ? input
    : (input && input.log != null) ? String(input.log)
    : (input && input.text != null) ? String(input.text)
    : '';
  if (!raw) return { category: 'unknown', signals: [], confidence: 0 };
  var t = raw.toLowerCase();

  // Order matters: db before network (timeout overlaps), auth before app-bug
  // (forbidden vs ReferenceError), deploy before infra (oom-on-pod vs oom).
  var RULES = [
    {
      cat: 'db',
      kw: [
        /\b(postgres|postgresql|mysql|mariadb|sqlite|mongodb|redis|cassandra)\b/,
        /\b(sql|query|transaction|deadlock|rollback)\b/,
        /\bdb[_\s-]?(timeout|connection|conn|pool|lock)\b/,
        /\b(connection|conn)\s+(refused|pool|timeout)\b.*\b(db|database|postgres|mysql)\b/,
        /\b(database|db)\b.*\b(timeout|unreachable|refused|down|lock)\b/,
        /\btoo many connections\b/,
        /\bduplicate key value\b/,
      ],
    },
    {
      cat: 'network',
      kw: [
        /\b50[234]\b/,
        /\b(econnrefused|econnreset|etimedout|enotfound|ehostunreach)\b/,
        /\b(dns|tcp|udp|socket|ssl|tls)\s+(error|failure|timeout|refused|handshake)\b/,
        /\bcertificate\s+(expired|invalid|verify)\b/,
        /\bgateway timeout\b/,
        /\bbad gateway\b/,
        /\bunable to resolve host\b/,
        /\bnetwork unreachable\b/,
      ],
    },
    {
      cat: 'auth',
      kw: [
        /\b40[13]\b/,
        /\b(unauthorized|forbidden)\b/,
        /\b(jwt|token|bearer)\b.*\b(expired|invalid|missing|signature)\b/,
        /\b(signature|sig)\s+(invalid|mismatch|verify)\b/,
        /\b(api[_\s-]?key|access[_\s-]?key)\s+(invalid|missing|expired|revoked)\b/,
        /\binvalid credentials\b/,
        /\bauthentication\s+(failed|required)\b/,
      ],
    },
    {
      cat: 'deploy',
      kw: [
        /\b(k8s|kubernetes|kubelet|kubectl|helm|terraform|ansible)\b/,
        /\b(docker|podman|containerd)\b/,
        /\b(crashloopbackoff|imagepullbackoff|readinessprobefailed|liveness probe)\b/,
        /\b(pod|container|deployment|replicaset|statefulset)\s+(failed|crashed|killed|terminated|oom)\b/,
        /\b(build|ci|pipeline|workflow)\s+(failed|broken|errored)\b/,
        /\boom[_\s-]?killed\b/,
        /\bnpm err!\b/,
      ],
    },
    {
      cat: 'app-bug',
      kw: [
        /\b(nullpointer(?:exception)?|nullreferenceexception)\b/,
        /\b(typeerror|valueerror|referenceerror|assertionerror|attributeerror)\b/,
        /\b(undefined|null)\s+(is not a function|has no method|reading|cannot read)\b/,
        /\bcannot read (?:property|properties) of (?:undefined|null)\b/,
        /\b(segfault|sigsegv|sigabrt|panic)\b/,
        /\b(stack ?overflow|maximum call stack)\b/,
        /\bunhandled (?:promise )?rejection\b/,
        /\b(traceback|stack trace)\b.*\bline \d+/,
      ],
    },
    {
      cat: 'infra',
      kw: [
        /\b(enospc|disk\s+full|no space left)\b/,
        /\b(out of memory|oom)\b/,
        /\b(cpu|memory|ram)\s+(throttle|throttling|throttled|exhausted|saturated)\b/,
        /\b(rate[_\s-]?limit(?:ed|ing)?|429|too many requests)\b/,
        /\b(throttled|backpressure|circuit[_\s-]?breaker)\b/,
        /\b(file descriptor|fd)\s+(leak|exhausted)\b/,
      ],
    },
  ];

  var hits = [];
  var signals = [];
  for (var i = 0; i < RULES.length; i++) {
    var rule = RULES[i];
    var matched = 0;
    for (var j = 0; j < rule.kw.length; j++) {
      var m = t.match(rule.kw[j]);
      if (m) { matched++; signals.push(m[0]); }
    }
    if (matched > 0) hits.push({ cat: rule.cat, matched: matched });
  }

  if (!hits.length) {
    return { category: 'unknown', signals: [], confidence: 0 };
  }
  // Sort by matched count desc, then by rule precedence (earlier in RULES).
  hits.sort(function (a, b) {
    if (b.matched !== a.matched) return b.matched - a.matched;
    var ia = -1, ib = -1;
    for (var k = 0; k < RULES.length; k++) {
      if (RULES[k].cat === a.cat) ia = k;
      if (RULES[k].cat === b.cat) ib = k;
    }
    return ia - ib;
  });
  var top = hits[0];
  var uniqSignals = Array.from(new Set(signals)).sort();
  var conf = hits.length === 1 ? 1.0 : Math.round((top.matched / (top.matched + (hits[1] ? hits[1].matched : 0))) * 1000) / 1000;
  return { category: top.cat, signals: uniqSignals, confidence: conf };
}
