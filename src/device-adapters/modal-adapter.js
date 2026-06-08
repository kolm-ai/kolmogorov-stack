// W888-C - Modal adapter stub.
//
// Deferred to W888-B cloud module (src/cloud-providers/modal.js already
// ships the function-deploy path). This adapter exists so the adapter
// table is uniform across all 6 device types; calling it returns a
// deterministic "not_yet_wired" envelope until W889 ties the Modal cloud
// provider into the deploy pipeline.

import crypto from 'node:crypto';

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  return {
    ok: false,
    deployment_id,
    error: 'not_yet_wired',
    hint: 'see W888-B cloud module: src/cloud-providers/modal.js#deployServingApp',
    message: 'modal-adapter is a stub; wire via src/cloud-providers/modal.js',
    raw: { device_type: device && device.type, artifact: artifactPath, opts: Object.keys(opts || {}) },
  };
}

export default { deploy };
