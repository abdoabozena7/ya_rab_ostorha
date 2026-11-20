import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../.github/extensions/prove-it-harness/process.mjs';

test('process supervisor preserves stdout, stderr and nonzero exit status', async () => {
  const result = await runProcess(process.execPath, [
    '-e', "process.stdin.on('data', data => process.stdout.write(data)); process.stdin.on('end', () => { process.stderr.write('diagnostic'); process.exitCode = 7; });",
  ], { input: 'literal $prompt; not a command', timeoutMs: 5000 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'literal $prompt; not a command');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.problem, null);
});

test('process supervisor reports missing executables instead of success', async () => {
  const result = await runProcess('harness-test-nonexistent-executable', [], { timeoutMs: 5000 });
  assert.equal(result.problem.code, 'SPAWN_FAILED');
});

test('process supervisor rejects oversized output without claiming truncated success', async () => {
  const result = await runProcess(process.execPath, [
    '-e', "process.stdout.write('x'.repeat(1024)); setInterval(() => {}, 1000);",
  ], { timeoutMs: 5000, maxBytes: 64 });
  assert.equal(result.problem.code, 'OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(result.stdout) <= 64);
});

test('process supervisor times out and stops its owned child process', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(JSON.stringify({child:child.pid})+'\\n'); setInterval(()=>{},1000);",
  ], { timeoutMs: 1500 });
  assert.equal(result.problem.code, 'TIMEOUT');
  const childId = JSON.parse(result.stdout).child;
  assert.throws(() => process.kill(childId, 0), error => error.code === 'ESRCH');
});

test('process supervisor honours cancellation before and during execution', async () => {
  const before = new AbortController();
  before.abort();
  const skipped = await runProcess('harness-test-nonexistent-executable', [], { signal: before.signal });
  assert.equal(skipped.problem.code, 'CANCELLED');
  assert.equal(skipped.launcherPid, null);
  const during = new AbortController();
  const timer = setTimeout(() => during.abort(), 250);
  try {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      signal: during.signal, timeoutMs: 5000,
    });
    assert.equal(result.problem.code, 'CANCELLED');
    assert.throws(() => process.kill(result.launcherPid, 0), error => error.code === 'ESRCH');
  } finally {
    clearTimeout(timer);
  }
});
