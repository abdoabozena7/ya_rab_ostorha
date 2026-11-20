import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
  }
}

async function stopProcessTree(processId) {
  if (!processId) return;
  if (process.platform !== 'win32') {
    throw new HarnessError('UNSUPPORTED_PLATFORM', 'Owned process-tree cleanup requires Windows.');
  }
  const script = `
$ErrorActionPreference = 'Stop'
function Stop-OwnedProcess([int]$OwnedId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $OwnedId")
    foreach ($child in $children) { Stop-OwnedProcess $child.ProcessId }
    if (Get-Process -Id $OwnedId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $OwnedId -Force -ErrorAction Stop
    }
}
Stop-OwnedProcess ${processId}
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  });
}

export function runProcess(command, args, {
  cwd, input = '', timeoutMs = 120000, maxBytes = 4 * 1024 * 1024, signal,
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: null, signal: null, launcherPid: null, stdout: '', stderr: '', durationMs: 0,
      problem: { code: 'CANCELLED', message: 'The deterministic helper was cancelled before launch.' },
    });
  }
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let problem = null;
    let cleanup = null;
    let finished = false;
    const finish = (exitCode, exitSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolveRun({
        exitCode, signal: exitSignal, launcherPid: child.pid,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started, problem,
      });
    };
    const stop = (reason) => {
      if (cleanup || finished) return;
      problem = reason;
      cleanup = stopProcessTree(child.pid).catch((error) => {
        problem = { code: 'CLEANUP_FAILED', message: `Could not stop owned PID ${child.pid}: ${error.message}` };
        finish(null, null);
      });
    };
    const capture = (chunks, data) => {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining > 0) chunks.push(data.subarray(0, remaining));
      bytes += data.length;
      if (bytes > maxBytes) {
        stop({ code: 'OUTPUT_LIMIT', message: `Process output exceeded ${maxBytes} bytes; partial logs are retained.` });
      }
    };
    const abort = () => stop({ code: 'CANCELLED', message: 'The deterministic helper was cancelled.' });
    const timer = setTimeout(() => stop({
      code: 'TIMEOUT', message: `Process exceeded the ${timeoutMs / 1000}-second limit.`,
    }), timeoutMs);
    child.stdout.on('data', data => capture(stdout, data));
    child.stderr.on('data', data => capture(stderr, data));
    child.on('error', error => { problem = { code: 'SPAWN_FAILED', message: error.message }; });
    child.stdin.on('error', error => {
      problem ??= { code: 'INPUT_CLOSED', message: `Process did not accept stdin: ${error.message}` };
    });
    child.on('close', async (code, exitSignal) => {
      if (cleanup) await cleanup;
      finish(code, exitSignal);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(input);
  });
}
