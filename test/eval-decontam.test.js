// test/eval-decontam.test.js
//
// The full acceptance battery for src/eval-decontam.js lives in
// tests/finalized-c1-synthetic-provenance-contamination-moat.test.js (the
// node:test runner globs tests/*.test.js). This file re-runs that same suite
// so the module is also covered under the test/ tree. Importing the suite file
// registers all its node:test cases.
import '../tests/finalized-c1-synthetic-provenance-contamination-moat.test.js';
