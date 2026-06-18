// W888-C - RunPod adapter stub.
//
// Deferred to W888-B cloud module (src/cloud-providers/runpod.js already
// ships the serving-endpoint create path). This adapter exists so the
// adapter table is uniform across all device types; calling it returns a
// deterministic "not_yet_wired" envelope until W889 ties the runpod cloud
// provider into the deploy pipeline.

import crypto from 'node:crypto';

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  return {
    ok: false,
    deployment_id,
    error: 'not_yet_wired',
    hint: 'see W888-B cloud module: src/cloud-providers/runpod.js#createServingEndpoint',
    message: 'runpod-adapter is a stub; wire via src/cloud-providers/runpod.js',
    raw: { device_type: device && device.type, artifact: artifactPath, opts: Object.keys(opts || {}) },
  };
}

export default { deploy };
