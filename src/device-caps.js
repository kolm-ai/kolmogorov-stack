// W888-C — deviceCaps(device, sshConnFactory): unified hardware probe.
//
// Given a device record (DeviceRegistry shape) this opens an SSH connection
// (type=ssh) or shells out locally (type=local) and probes the host for:
//   - gpu_present, gpu_model, gpu_vram_gb        (nvidia-smi when available)
//   - cpu_model, cpu_cores, ram_gb               (/proc/cpuinfo + free -g, OR
//                                                 sysctl on macOS, OR PowerShell
//                                                 Get-CimInstance on Windows)
//   - os                                         (uname -a / sw_vers / ver)
//   - disk_free_gb at ~/.kolm                    (df -h ~ / Get-PSDrive)
//
// Returns:
//   { ok: true,  hardware: { gpu_present, gpu_model, gpu_vram_gb,
//                            cpu_model, cpu_cores, ram_gb,
//                            os, disk_free_gb },
//     raw: { nvidia_smi, cpu_raw, mem_raw, disk_raw, uname_raw } }
//   { ok: false, error: 'string', hint: 'install …' }
//
// Caveats / Constraints / Limitations:
//   - When the SSH target is non-Linux (macOS / Windows-OpenSSH) we fall back
//     to the OS-specific probes. The shape stays the same; values that the
//     remote OS can't expose are returned as null (e.g. disk_free_gb on
//     Windows hosts where PowerShell isn't on PATH for the SSH user).
//   - Local probes use child_process.execFile so that absent tools (nvidia-smi
//     on a CPU-only laptop) degrade to gpu_present:false instead of crashing.
//   - The sshConnFactory is constructor-injectable so tests can short-circuit
//     to an in-memory shim. In production the factory just opens the canonical
//     src/device-ssh.js SSHConnection.

import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Default SSH-connection factory: lazily loads src/device-ssh.js when the
// caller doesn't provide an override.
async function _defaultSshConnFactory(device) {
  const mod = await import('./device-ssh.js');
  const conn = new mod.SSHConnection(device);
  await conn.connect();
  return conn;
}

function _parseFreeOutput(out) {
  // free -h --si OR free -g OR free -m. We look for the Mem: row and
  // pull total. Returns ram_gb (rounded).
  const line = String(out || '').split(/\r?\n/).find(l => /^Mem:\s/i.test(l));
  if (!line) return null;
  const tokens = line.trim().split(/\s+/);
  const totalRaw = tokens[1] || '';
  const num = parseFloat(totalRaw);
  if (!Number.isFinite(num)) return null;
  // Heuristic for unit:
  //   - free -g → integer GB
  //   - free -m → integer MB
  //   - free -h → like "63Gi", "503Mi"
  if (/Gi?$/i.test(totalRaw)) return Math.round(num);
  if (/Mi?$/i.test(totalRaw)) return Math.round(num / 1024);
  // Plain integer: assume MB unless it looks small (>1024 → MB; ≤1024 → GB).
  return num >= 1024 ? Math.round(num / 1024) : Math.round(num);
}

function _parseDfOutput(out) {
  // df -h ~ → returns Available column in human units.
  // Skip the header line, take the last column for "Available". On Linux:
  //   "Filesystem  Size  Used  Avail  Use%  Mounted on"
  //   "/dev/...    100G  20G   80G    20%   /home/user"
  const lines = String(out || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const row = lines[lines.length - 1].trim().split(/\s+/);
  // Avail is index 3 in the standard 6-column shape.
  const avail = row[3] || '';
  const num = parseFloat(avail);
  if (!Number.isFinite(num)) return null;
  if (/T/i.test(avail)) return Math.round(num * 1024);
  if (/G/i.test(avail)) return Math.round(num);
  if (/M/i.test(avail)) return Math.round(num / 1024);
  return Math.round(num); // plain number → assume GB-ish
}

function _parseNvidiaSmi(out) {
  // "NVIDIA GeForce RTX 5090, 32607" (memory in MiB by --format=csv,noheader,nounits)
  const line = String(out || '').trim().split(/\r?\n/).find(l => l.trim() && !/no devices were found/i.test(l));
  if (!line) return { gpu_present: false, gpu_model: null, gpu_vram_gb: null };
  const parts = line.split(',').map(s => s.trim());
  const model = parts[0] || null;
  const mb = Number(parts[1]);
  const vramGb = Number.isFinite(mb) && mb > 0 ? Math.round(mb / 1024) : null;
  return { gpu_present: !!model, gpu_model: model, gpu_vram_gb: vramGb };
}

function _parseCpuinfo(out) {
  const txt = String(out || '');
  if (!txt.trim()) return { cpu_model: null, cpu_cores: null };
  const model = (txt.split(/\r?\n/).find(l => /^model name\s*:/i.test(l)) || '').split(':')[1] || '';
  const cores = (txt.match(/^processor\s*:/gmi) || []).length;
  return { cpu_model: model.trim() || null, cpu_cores: cores > 0 ? cores : null };
}

// SSH path — runs 5 probes via the connection's .exec().
async function _probeSsh(device, conn) {
  const raw = { nvidia_smi: '', cpu_raw: '', mem_raw: '', disk_raw: '', uname_raw: '' };
  const run = async (cmd, timeoutMs = 8000) => {
    try { return await conn.exec(cmd, { timeoutMs }); }
    catch (e) { return { stdout: '', stderr: e && e.message ? e.message : String(e), code: 1 }; }
  };

  const [nv, cpu, mem, disk, uname] = await Promise.all([
    run('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true'),
    run('cat /proc/cpuinfo 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null || system_profiler SPHardwareDataType 2>/dev/null || true'),
    run('free -g 2>/dev/null || sysctl -n hw.memsize 2>/dev/null || true'),
    run('df -h ~/.kolm 2>/dev/null || df -h / 2>/dev/null || true'),
    run('uname -a 2>/dev/null || sw_vers 2>/dev/null || ver 2>/dev/null || true'),
  ]);

  raw.nvidia_smi = (nv.stdout || '').slice(0, 1024);
  raw.cpu_raw = (cpu.stdout || '').slice(0, 4096);
  raw.mem_raw = (mem.stdout || '').slice(0, 512);
  raw.disk_raw = (disk.stdout || '').slice(0, 1024);
  raw.uname_raw = (uname.stdout || '').slice(0, 512);

  const gpu = _parseNvidiaSmi(nv.stdout);
  const cpuParts = _parseCpuinfo(cpu.stdout);
  // free output OR a raw sysctl byte count for Darwin.
  let ramGb = _parseFreeOutput(mem.stdout);
  if (ramGb == null) {
    const bytes = parseInt(String(mem.stdout || '').trim(), 10);
    if (Number.isFinite(bytes) && bytes > 1024 * 1024) ramGb = Math.round(bytes / 1024 / 1024 / 1024);
  }
  const diskFree = _parseDfOutput(disk.stdout);
  const osStr = (uname.stdout || '').trim().split(/\r?\n/)[0] || null;

  return {
    ok: true,
    hardware: {
      gpu_present: gpu.gpu_present,
      gpu_model: gpu.gpu_model,
      gpu_vram_gb: gpu.gpu_vram_gb,
      cpu_model: cpuParts.cpu_model,
      cpu_cores: cpuParts.cpu_cores,
      ram_gb: ramGb,
      os: osStr,
      disk_free_gb: diskFree,
    },
    raw,
  };
}

// Local path — runs the same probes via child_process. Branches on platform
// so macOS / Windows / Linux all return the same shape.
async function _probeLocal() {
  const raw = { nvidia_smi: '', cpu_raw: '', mem_raw: '', disk_raw: '', uname_raw: '' };
  const platform = process.platform;

  // GPU via nvidia-smi (any OS that has CUDA on PATH).
  try {
    const { stdout } = await execFileP('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000 });
    raw.nvidia_smi = (stdout || '').slice(0, 1024);
  } catch { /* no nvidia-smi → leave empty */ }
  const gpu = _parseNvidiaSmi(raw.nvidia_smi);

  // CPU + RAM + disk_free + OS — platform-specific.
  let cpuParts = { cpu_model: null, cpu_cores: os.cpus().length || null };
  let ramGb = Math.round(os.totalmem() / 1024 / 1024 / 1024) || null;
  let diskFree = null;
  let osStr = `${platform} ${os.release ? os.release() : ''}`.trim();

  if (platform === 'linux') {
    try {
      const r = await execFileP('cat', ['/proc/cpuinfo'], { timeout: 3000 });
      raw.cpu_raw = (r.stdout || '').slice(0, 4096);
      cpuParts = _parseCpuinfo(r.stdout);
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('free', ['-g'], { timeout: 3000 });
      raw.mem_raw = (r.stdout || '').slice(0, 512);
      const parsed = _parseFreeOutput(r.stdout);
      if (parsed != null) ramGb = parsed;
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('df', ['-h', os.homedir() + '/.kolm'], { timeout: 3000 });
      raw.disk_raw = (r.stdout || '').slice(0, 1024);
      diskFree = _parseDfOutput(r.stdout);
    } catch {
      try {
        const r = await execFileP('df', ['-h', '/'], { timeout: 3000 });
        raw.disk_raw = (r.stdout || '').slice(0, 1024);
        diskFree = _parseDfOutput(r.stdout);
      } catch {} // deliberate: cleanup
    }
    try {
      const r = await execFileP('uname', ['-a'], { timeout: 3000 });
      raw.uname_raw = (r.stdout || '').slice(0, 512);
      osStr = (r.stdout || '').trim();
    } catch {} // deliberate: cleanup
  } else if (platform === 'darwin') {
    try {
      const r = await execFileP('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 3000 });
      raw.cpu_raw = (r.stdout || '').slice(0, 512);
      cpuParts.cpu_model = (r.stdout || '').trim() || null;
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('sysctl', ['-n', 'hw.memsize'], { timeout: 3000 });
      raw.mem_raw = (r.stdout || '').slice(0, 64);
      const bytes = parseInt(String(r.stdout || '').trim(), 10);
      if (Number.isFinite(bytes)) ramGb = Math.round(bytes / 1024 / 1024 / 1024);
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('df', ['-h', os.homedir() + '/.kolm'], { timeout: 3000 });
      raw.disk_raw = (r.stdout || '').slice(0, 1024);
      diskFree = _parseDfOutput(r.stdout);
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('sw_vers', [], { timeout: 3000 });
      raw.uname_raw = (r.stdout || '').slice(0, 512);
      osStr = (r.stdout || '').trim().split(/\r?\n/).join(' ');
    } catch {} // deliberate: cleanup
  } else if (platform === 'win32') {
    // Best-effort: PowerShell Get-CimInstance. If PowerShell isn't on PATH,
    // fall back to the os.* numbers we already have.
    try {
      const r = await execFileP('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name'], { timeout: 5000 });
      raw.cpu_raw = (r.stdout || '').slice(0, 512);
      cpuParts.cpu_model = (r.stdout || '').trim().split(/\r?\n/)[0] || null;
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory'], { timeout: 5000 });
      const bytes = parseInt(String(r.stdout || '').trim(), 10);
      if (Number.isFinite(bytes)) ramGb = Math.round(bytes / 1024 / 1024 / 1024);
    } catch {} // deliberate: cleanup
    try {
      const r = await execFileP('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive C).Free'], { timeout: 5000 });
      const bytes = parseInt(String(r.stdout || '').trim(), 10);
      if (Number.isFinite(bytes)) diskFree = Math.round(bytes / 1024 / 1024 / 1024);
    } catch {} // deliberate: cleanup
    osStr = `Windows ${os.release()}`;
  }

  return {
    ok: true,
    hardware: {
      gpu_present: gpu.gpu_present,
      gpu_model: gpu.gpu_model,
      gpu_vram_gb: gpu.gpu_vram_gb,
      cpu_model: cpuParts.cpu_model,
      cpu_cores: cpuParts.cpu_cores,
      ram_gb: ramGb,
      os: osStr,
      disk_free_gb: diskFree,
    },
    raw,
  };
}

// Public: deviceCaps(device, sshConnFactory?). Returns {ok, hardware, raw}
// or {ok:false, error, hint}.
export async function deviceCaps(device, sshConnFactory = null) {
  if (!device || !device.type) {
    return { ok: false, error: 'no_device_or_type', hint: 'pass a DeviceRegistry record with .type' };
  }
  try {
    if (device.type === 'local') {
      return await _probeLocal();
    }
    if (device.type === 'ssh') {
      const factory = sshConnFactory || _defaultSshConnFactory;
      let conn = null;
      try {
        conn = await factory(device);
        return await _probeSsh(device, conn);
      } finally {
        if (conn && typeof conn.disconnect === 'function') {
          try { conn.disconnect(); } catch {} // deliberate: cleanup
        }
      }
    }
    if (device.type === 'ollama' || device.type === 'k8s' || device.type === 'runpod' || device.type === 'modal') {
      return {
        ok: false,
        error: 'probe_not_supported_for_type',
        hint: `type=${device.type} is reachable over HTTP/API not SSH; use the adapter health endpoint instead`,
      };
    }
    return { ok: false, error: 'unknown_device_type', hint: `type "${device.type}" not in {ssh,local,ollama,k8s,runpod,modal}` };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), hint: 'check ssh reachability + key path' };
  }
}

export default { deviceCaps };
