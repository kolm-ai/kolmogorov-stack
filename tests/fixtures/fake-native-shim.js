#!/usr/bin/env node
// W409d fake native shim — read one JSON line on stdin, write a canned
// {"echo": <input>, "ran_via": "fake_native_shim"} line on stdout.
//
// This file is shipped INSIDE the test .kolm zip at entrypoint.binary path
// so the native-runner extracts it to a tmp dir, chmods 0755, and spawns it.
// On POSIX the shebang line above is sufficient to run it as a binary; on
// Windows the native-runner refuses non-.exe binaries so we never spawn it
// there. The same canned-output contract is used by `tests/wave409d-runtime-
// dispatch.test.js` to assert the non-JS path actually ran.
let buf = '';
process.stdin.on('data', (b) => { buf += b.toString('utf8'); });
process.stdin.on('end', () => {
  let input = null;
  try { input = buf.trim() ? JSON.parse(buf) : null; } catch { input = buf; }
  const out = { echo: input, ran_via: 'fake_native_shim', pid_alive: true };
  process.stdout.write(JSON.stringify(out) + '\n');
});
