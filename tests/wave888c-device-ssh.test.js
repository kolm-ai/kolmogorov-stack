// W888-C — Device SSH layer tests.
//
// Pinned items:
//   1) SSHConnection constructs without throwing for a valid mock device
//   2) SSHConnection throws clear error for missing key_path (KOLM_E_NO_KEY_PATH)
//   3) SSHConnection throws clear error for missing host (KOLM_E_NO_HOST)
//   4) SSHConnection throws clear error for unsafe host (KOLM_E_UNSAFE_HOST)
//   5) Connection normalization accepts canonical {connection: {...}} shape
//   6) Connection normalization accepts W372 legacy {ssh: {...}} shape
//   7) Connection normalization accepts {host, ssh_key} legacy shape
//   8) _parseHardware extracts gpu/vram from canonical nvidia-smi line
//   9) _parseHardware extracts cpu cores from canonical /proc/cpuinfo block
//   10) _parseHardware extracts ram_mb from canonical `free -m` block
//   11) _parseHardware extracts disk_free_mb from canonical `df -m /` block
//   12) _parseHardware extracts os + arch from `uname -sr` / `uname -m`
//   13) _parseHardware extracts cuda_version from `nvcc --version` block
//   14) _parseHardware degrades gracefully when probes return empty
//   15) _parseHardware handles "No devices were found" nvidia-smi shape
//   16) src/device-ssh.js stays under 600 lines (constraint)
//   17) src/device-capabilities.js exports detectHardwareRemote
//   18) src/device-capabilities.js exports healthCheck
//   19) src/device-capabilities.js exports pingAll
//   20) src/device-capabilities.js exports recordDeployment

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { SSHConnection, _parseHardware } from '../src/device-ssh.js';
import * as deviceCaps from '../src/device-capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEVICE_SSH_PATH = path.join(REPO_ROOT, 'src', 'device-ssh.js');

// Helper: build a temp key file so SSHConnection() doesn't immediately fail
// on `key_path` truthiness when we want to test the host validation paths
// independently. Cleaned up after each test that uses it.
function makeTempKeyFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888c-key-'));
  const keyPath = path.join(tmpDir, 'id_test');
  const pem = [
    '-----BEGIN OPENSSH ', 'PRIVATE ', 'KEY-----\n',
    'FAKE\n',
    '-----END OPENSSH ', 'PRIVATE ', 'KEY-----\n',
  ].join('');
  fs.writeFileSync(keyPath, pem);
  return { keyPath, cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} } }; // deliberate: cleanup
}

// ---------------------------------------------------------------------------
// 1) Constructs for valid mock device
// ---------------------------------------------------------------------------
test('W888-C #1 — SSHConnection constructs without throwing for a valid mock device', () => {
  const { keyPath, cleanup } = makeTempKeyFile();
  try {
    const device = {
      device_id: 'prod-gpu-1',
      type: 'ssh',
      connection: { host: 'prod1.example.com', user: 'kolm', port: 22, key_path: keyPath },
    };
    const c = new SSHConnection(device);
    assert.equal(c.deviceId, 'prod-gpu-1');
    assert.equal(c.connection.host, 'prod1.example.com');
    assert.equal(c._connected, false, 'must not auto-connect on construct');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 2) Missing key_path
// ---------------------------------------------------------------------------
test('W888-C #2 — SSHConnection throws KOLM_E_NO_KEY_PATH for missing key_path', () => {
  const device = {
    device_id: 'prod-gpu-1',
    connection: { host: 'prod1.example.com', user: 'kolm' /* no key_path */ },
  };
  assert.throws(() => new SSHConnection(device), (err) => {
    assert.equal(err.code, 'KOLM_E_NO_KEY_PATH');
    assert.match(err.message, /key_path is required/i);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 3) Missing host
// ---------------------------------------------------------------------------
test('W888-C #3 — SSHConnection throws KOLM_E_NO_HOST for missing host', () => {
  const { keyPath, cleanup } = makeTempKeyFile();
  try {
    const device = { device_id: 'bad-1', connection: { user: 'kolm', key_path: keyPath } };
    assert.throws(() => new SSHConnection(device), (err) => {
      assert.equal(err.code, 'KOLM_E_NO_HOST');
      return true;
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 4) Unsafe host
// ---------------------------------------------------------------------------
test('W888-C #4 — SSHConnection throws KOLM_E_UNSAFE_HOST for "-oProxyCommand=..." injection', () => {
  const { keyPath, cleanup } = makeTempKeyFile();
  try {
    const device = {
      device_id: 'bad-2',
      connection: { host: '-oProxyCommand=evil', user: 'kolm', key_path: keyPath },
    };
    assert.throws(() => new SSHConnection(device), (err) => {
      assert.equal(err.code, 'KOLM_E_UNSAFE_HOST');
      return true;
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 5-7) Connection-shape normalization
// ---------------------------------------------------------------------------
test('W888-C #5 — accepts canonical {connection: {...}} shape', () => {
  const { keyPath, cleanup } = makeTempKeyFile();
  try {
    const c = new SSHConnection({
      device_id: 'd1',
      connection: { host: 'host.example.com', user: 'k', key_path: keyPath, port: 2222 },
    });
    assert.equal(c.connection.host, 'host.example.com');
    assert.equal(c.connection.port, 2222);
  } finally { cleanup(); }
});

test('W888-C #6 — accepts W372 legacy {ssh: {...}} shape', () => {
  const { keyPath, cleanup } = makeTempKeyFile();
  try {
    const c = new SSHConnection({
      device_id: 'd2',
      ssh: { host: 'legacy.example.com', user: 'l', identity_file: keyPath, port: 22 },
    });
    assert.equal(c.connection.host, 'legacy.example.com');
    assert.equal(c.connection.key_path, keyPath);
  } finally { cleanup(); }
});

test('W888-C #7 — accepts {host, ssh_key} legacy shape', () => {
  const { keyPath, cleanup } = makeTempKeyFile();
  try {
    const c = new SSHConnection({
      device_id: 'd3',
      host: 'flat.example.com',
      user: 'f',
      ssh_key: keyPath,
    });
    assert.equal(c.connection.host, 'flat.example.com');
    assert.equal(c.connection.key_path, keyPath);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 8) nvidia-smi parsing
// ---------------------------------------------------------------------------
test('W888-C #8 — _parseHardware extracts gpu / vram / driver / sm from nvidia-smi line', () => {
  const fixtures = {
    nv: { stdout: 'NVIDIA GeForce RTX 5090, 32607, 535.183.01, 12.0', stderr: '', code: 0 },
    cpu: { stdout: '', stderr: '', code: 0 },
    mem: { stdout: '', stderr: '', code: 0 },
    disk: { stdout: '', stderr: '', code: 0 },
    unameSr: { stdout: 'Linux 6.8.0-31-generic', stderr: '', code: 0 },
    unameMa: { stdout: 'x86_64', stderr: '', code: 0 },
    nvcc: { stdout: '', stderr: '', code: 0 },
  };
  const hw = _parseHardware(fixtures);
  assert.equal(hw.gpu, 'NVIDIA GeForce RTX 5090');
  assert.equal(hw.gpu_vram_mb, 32607);
  assert.equal(hw.driver_version, '535.183.01');
  assert.equal(hw.compute_capability, '12.0');
});

// ---------------------------------------------------------------------------
// 9) cpu / core count parsing
// ---------------------------------------------------------------------------
test('W888-C #9 — _parseHardware extracts cpu + core count from /proc/cpuinfo', () => {
  const cpuinfo = [
    'processor	: 0',
    'vendor_id	: GenuineIntel',
    'model name	: Intel(R) Core(TM) i9-13900K CPU @ 5.50GHz',
    'cpu cores	: 24',
    'processor	: 1',
    'model name	: Intel(R) Core(TM) i9-13900K CPU @ 5.50GHz',
    'processor	: 2',
    'model name	: Intel(R) Core(TM) i9-13900K CPU @ 5.50GHz',
  ].join('\n');
  const hw = _parseHardware({
    nv: { stdout: '', code: 0 },
    cpu: { stdout: cpuinfo, code: 0 },
    mem: { stdout: '', code: 0 },
    disk: { stdout: '', code: 0 },
    unameSr: { stdout: '', code: 0 },
    unameMa: { stdout: '', code: 0 },
    nvcc: { stdout: '', code: 0 },
  });
  assert.equal(hw.cpu, 'Intel(R) Core(TM) i9-13900K CPU @ 5.50GHz');
  assert.equal(hw.cpu_cores, 3);
});

// ---------------------------------------------------------------------------
// 10) ram parsing
// ---------------------------------------------------------------------------
test('W888-C #10 — _parseHardware extracts ram_mb from `free -m` block', () => {
  const free = [
    '               total        used        free      shared  buff/cache   available',
    'Mem:           64111       2034       58723         96       3354      61567',
    'Swap:           2047           0        2047',
  ].join('\n');
  const hw = _parseHardware({
    nv: { stdout: '', code: 0 },
    cpu: { stdout: '', code: 0 },
    mem: { stdout: free, code: 0 },
    disk: { stdout: '', code: 0 },
    unameSr: { stdout: '', code: 0 },
    unameMa: { stdout: '', code: 0 },
    nvcc: { stdout: '', code: 0 },
  });
  assert.equal(hw.ram_mb, 64111);
});

// ---------------------------------------------------------------------------
// 11) disk parsing
// ---------------------------------------------------------------------------
test('W888-C #11 — _parseHardware extracts disk_free_mb from `df -m /` block', () => {
  const df = '/dev/nvme0n1p2  945843  287312  610243  33% /';
  const hw = _parseHardware({
    nv: { stdout: '', code: 0 },
    cpu: { stdout: '', code: 0 },
    mem: { stdout: '', code: 0 },
    disk: { stdout: df, code: 0 },
    unameSr: { stdout: '', code: 0 },
    unameMa: { stdout: '', code: 0 },
    nvcc: { stdout: '', code: 0 },
  });
  assert.equal(hw.disk_free_mb, 610243);
});

// ---------------------------------------------------------------------------
// 12) os + arch
// ---------------------------------------------------------------------------
test('W888-C #12 — _parseHardware extracts os + arch from uname probes', () => {
  const hw = _parseHardware({
    nv: { stdout: '', code: 0 },
    cpu: { stdout: '', code: 0 },
    mem: { stdout: '', code: 0 },
    disk: { stdout: '', code: 0 },
    unameSr: { stdout: 'Linux 6.8.0-31-generic\n', code: 0 },
    unameMa: { stdout: 'x86_64\n', code: 0 },
    nvcc: { stdout: '', code: 0 },
  });
  assert.equal(hw.os, 'Linux 6.8.0-31-generic');
  assert.equal(hw.arch, 'x86_64');
});

// ---------------------------------------------------------------------------
// 13) cuda version
// ---------------------------------------------------------------------------
test('W888-C #13 — _parseHardware extracts cuda_version from nvcc output', () => {
  const nvcc = [
    'nvcc: NVIDIA (R) Cuda compiler driver',
    'Copyright (c) 2005-2024 NVIDIA Corporation',
    'Built on Mon_Oct_28_19:43:32_PDT_2024',
    'Cuda compilation tools, release 12.6, V12.6.85',
  ].join('\n');
  const hw = _parseHardware({
    nv: { stdout: '', code: 0 },
    cpu: { stdout: '', code: 0 },
    mem: { stdout: '', code: 0 },
    disk: { stdout: '', code: 0 },
    unameSr: { stdout: '', code: 0 },
    unameMa: { stdout: '', code: 0 },
    nvcc: { stdout: nvcc, code: 0 },
  });
  assert.equal(hw.cuda_version, '12.6');
});

// ---------------------------------------------------------------------------
// 14) Graceful degrade — all empty probes
// ---------------------------------------------------------------------------
test('W888-C #14 — _parseHardware returns null fields gracefully on empty probes', () => {
  const hw = _parseHardware({
    nv: { stdout: '', code: 1 },
    cpu: { stdout: '', code: 1 },
    mem: { stdout: '', code: 1 },
    disk: { stdout: '', code: 1 },
    unameSr: { stdout: '', code: 1 },
    unameMa: { stdout: '', code: 1 },
    nvcc: { stdout: '', code: 1 },
  });
  assert.equal(hw.gpu, null);
  assert.equal(hw.gpu_vram_mb, null);
  assert.equal(hw.cpu, null);
  assert.equal(hw.ram_mb, null);
  assert.equal(hw.disk_free_mb, null);
  assert.equal(hw.cuda_version, null);
});

// ---------------------------------------------------------------------------
// 15) nvidia-smi "no devices" shape
// ---------------------------------------------------------------------------
test('W888-C #15 — _parseHardware ignores "No devices were found" nvidia-smi shape', () => {
  const hw = _parseHardware({
    nv: { stdout: 'No devices were found', code: 6 },
    cpu: { stdout: '', code: 0 },
    mem: { stdout: '', code: 0 },
    disk: { stdout: '', code: 0 },
    unameSr: { stdout: '', code: 0 },
    unameMa: { stdout: '', code: 0 },
    nvcc: { stdout: '', code: 0 },
  });
  assert.equal(hw.gpu, null, 'no devices line must not set gpu');
  assert.equal(hw.gpu_vram_mb, null, 'no devices line must not set vram');
});

// ---------------------------------------------------------------------------
// 16) File-size constraint (under 600 lines)
// ---------------------------------------------------------------------------
test('W888-C #16 — src/device-ssh.js stays under 600 lines', () => {
  const lines = fs.readFileSync(DEVICE_SSH_PATH, 'utf8').split(/\r?\n/).length;
  assert.ok(lines < 600, `src/device-ssh.js must be <600 lines; got ${lines}`);
});

// ---------------------------------------------------------------------------
// 17-20) device-capabilities.js exports the four new fleet methods.
// ---------------------------------------------------------------------------
test('W888-C #17 — device-capabilities exports detectHardwareRemote', () => {
  assert.equal(typeof deviceCaps.detectHardwareRemote, 'function');
});

test('W888-C #18 — device-capabilities exports healthCheck', () => {
  assert.equal(typeof deviceCaps.healthCheck, 'function');
});

test('W888-C #19 — device-capabilities exports pingAll', () => {
  assert.equal(typeof deviceCaps.pingAll, 'function');
});

test('W888-C #20 — device-capabilities exports recordDeployment', () => {
  assert.equal(typeof deviceCaps.recordDeployment, 'function');
});
