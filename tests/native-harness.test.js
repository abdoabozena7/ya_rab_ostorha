import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ACTIONS, HarnessError, PROOF, PYTHON, ROOT,
  buildProofInvocation, executeProof, modelSelection,
} from '../.github/extensions/prove-it-harness/harness.mjs';

const sessionId = 'native-test-session';
const invalid = error => error instanceof HarnessError && error.code === 'INVALID_INPUT';

test('native adapter only exposes existing deterministic collector actions', async () => {
  assert.deepEqual(ACTIONS, ['doctor', 'init', 'seal', 'todo', 'step', 'run', 'review', 'verify', 'block', 'resume']);
  const command = await buildProofInvocation({ action: 'doctor' }, sessionId);
  assert.equal(command.executable, PYTHON);
  assert.deepEqual(command.args, [PROOF, 'doctor']);
  for (const value of [
    null, [], {}, { action: 'exec' }, { action: 'doctor', model: 'another-model' },
    { action: 'doctor', provider: 'another-provider' }, { action: 'doctor', prompt: 'reason for me' },
    { action: 'doctor', timeoutSeconds: null }, { action: 'doctor', timeoutSeconds: 0 },
    { action: 'doctor', timeoutSeconds: 3601 }, { action: 'doctor', timeoutSeconds: 1.5 },
  ]) {
    await assert.rejects(() => buildProofInvocation(value, sessionId), invalid);
  }
});

test('init records the existing owner without selecting another model or treating text as a command', async () => {
  const goal = "literal '; & ignored | text";
  const command = await buildProofInvocation({ action: 'init', taskId: 'native-task', goal }, sessionId);
  assert.equal(command.args[1], 'init');
  assert.equal(command.args[command.args.indexOf('--goal') + 1], goal);
  assert.equal(command.args[command.args.indexOf('--session-id') + 1], sessionId);
  assert.ok(!command.args.includes('--model'));
  await assert.rejects(() => buildProofInvocation({ action: 'init', taskId: '../other', goal }, sessionId), invalid);
  await assert.rejects(() => buildProofInvocation({ action: 'init', taskId: 'valid', goal, kind: null }, sessionId), invalid);
  await assert.rejects(() => buildProofInvocation({ action: 'init', taskId: 'valid', goal: '' }, sessionId), invalid);
});

test('all paths stay inside the checkout, including resolved directory links', async () => {
  await assert.rejects(
    () => buildProofInvocation({ action: 'doctor', project: '..' }, sessionId),
    error => error.code === 'OUTSIDE_WORKSPACE',
  );
  await assert.rejects(
    () => buildProofInvocation({ action: 'doctor', project: tmpdir() }, sessionId),
    error => error.code === 'OUTSIDE_WORKSPACE',
  );
  const parent = join(ROOT, '.runtime-proof');
  await mkdir(parent, { recursive: true });
  const inside = await mkdtemp(join(parent, 'path-test-'));
  const outside = await mkdtemp(join(tmpdir(), 'native-proof-path-'));
  try {
    const link = join(inside, 'outside');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => buildProofInvocation({ action: 'doctor', project: relative(ROOT, link) }, sessionId),
      error => error.code === 'OUTSIDE_WORKSPACE',
    );
    await rm(link);
  } finally {
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('state, check and recovery parameters preserve the existing collector contract', async () => {
  const step = await buildProofInvocation({
    action: 'step', taskId: 'task', stepId: 'T01', state: 'IMPLEMENTED', note: 'Not verified yet.',
  }, sessionId);
  assert.ok(step.args.includes('IMPLEMENTED'));
  assert.ok(step.args.includes('--task'));
  const verify = await buildProofInvocation({ action: 'verify', taskId: 'task', timeoutSeconds: 3600 }, sessionId);
  assert.equal(verify.timeoutMs, 3600000);
  assert.equal(verify.args.at(-1), '--write-report');
  const blocked = await buildProofInvocation({
    action: 'block', taskId: 'task', reason: 'Missing resource',
    requiredAction: 'Restore the resource', evidence: 'runs\\check\\stderr.log',
  }, sessionId);
  assert.equal(blocked.args.at(-1), 'runs/check/stderr.log');
  await assert.rejects(() => buildProofInvocation({ action: 'run', taskId: 'task' }, sessionId), invalid);
  await assert.rejects(() => buildProofInvocation({
    action: 'step', taskId: 'task', stepId: 'T01', state: 'DONE', note: 'Unsupported shortcut',
  }, sessionId), invalid);
});

test('review inputs resolve within the chosen project and credentials are not exposed as model metadata', async () => {
  const project = await mkdtemp(join(ROOT, '.runtime-proof', 'review-test-'));
  try {
    await writeFile(join(project, 'review.json'), '{}');
    const command = await buildProofInvocation({
      action: 'review', project: relative(ROOT, project), taskId: 'task', reviewFile: 'review.json',
    }, sessionId);
    assert.equal(command.args.at(-1), join(project, 'review.json'));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
  assert.deepEqual(modelSelection({ modelId: 'picker-model', unrelated: 'not exposed' }), { modelId: 'picker-model' });
  assert.throws(() => modelSelection({}), error => error.code === 'MODEL_METADATA_UNAVAILABLE');
});

test('the public native adapter runs the actual installed collector without an AI client', async () => {
  const command = await buildProofInvocation({ action: 'doctor' }, sessionId);
  const result = await executeProof(command);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.problem, null);
  assert.match(JSON.parse(result.stdout).python, /^3\./);
  assert.equal(result.action, 'doctor');
});
