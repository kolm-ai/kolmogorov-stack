// Vercel serverless adapter — wraps the Express app for the platform.
// On cold-start error we surface the real exception in the response body
// so we can debug without dashboard access. Remove the try/catch once the
// deploy is healthy.
let app;
let importError = null;
try {
  ({ app } = await import('../server.js'));
} catch (e) {
  importError = e;
}

export default function handler(req, res) {
  if (importError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(
      'cold-start failed:\n' +
      String(importError && importError.message) + '\n\n' +
      String(importError && importError.stack || '')
    );
    return;
  }
  return app(req, res);
}
