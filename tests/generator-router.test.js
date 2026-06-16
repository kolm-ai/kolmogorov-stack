// Owned-module test alias for src/generator-router.js.
//
// The full acceptance suite lives in
// tests/finalized-c1-sensitive-domain-local-generator-guardrail.test.js
// (the atom-named file the build spec requires). This file re-exports that
// suite so `node --test tests/generator-router.test.js` runs the same
// load-bearing invariants - keeping the module's named test discoverable.

import './finalized-c1-sensitive-domain-local-generator-guardrail.test.js';
