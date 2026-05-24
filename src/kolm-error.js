// WC05 — typed error primitive for retiring the ~793 untyped `throw new Error(...)`
// call sites without a big-bang refactor. New code throws `kolmError(code, message,
// { detail, status, retryable, install_hint })`; callers up the stack can branch on
// `err.code` (snake_case) instead of regex-matching `err.message`.
//
// Pairs with `errorEnvelope()` in src/envelope.js — the field names line up so a
// route handler can do:
//
//   try { ... } catch (err) {
//     if (err instanceof KolmError) {
//       return res.status(err.status || 500).json(errorEnvelope({
//         code: err.code,
//         message: err.message,
//         install_hint: err.install_hint,
//         status: err.status,
//       }));
//     }
//     throw err;
//   }
//
// Do NOT add behavior here (logging, telemetry, etc.). Keep this a pure data class.

export class KolmError extends Error {
  constructor(code, message, opts = {}) {
    super(message || code);
    this.name = 'KolmError';
    this.code = code;
    this.detail = opts.detail;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.install_hint = opts.install_hint;
  }
}

export function kolmError(code, message, opts) {
  return new KolmError(code, message, opts);
}
