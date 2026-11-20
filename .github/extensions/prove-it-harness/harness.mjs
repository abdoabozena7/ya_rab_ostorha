import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError, runProcess } from './process.mjs';

export { HarnessError } from './process.mjs';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PROOF = join(ROOT, '.agents', 'skills', 'prove-it', 'scripts', 'proof.py');
const venv = join(ROOT, '.venv-carla', 'Scripts', 'python.exe');
export const PYTHON = existsSync(venv) ? venv : 'python.exe';
const fields = {
  doctor: [],
  init: ['goal', 'kind'],
  seal: [],
  todo: [],
  step: ['stepId', 'state', 'note', 'agentRef', 'handoff'],
  run: ['checkId'],
  review: ['reviewFile'],
  verify: [],
  block: ['reason', 'requiredAction', 'evidence'],
  resume: ['reason'],
};
export const ACTIONS = Object.keys(fields);

function text(value, key) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HarnessError('INVALID_INPUT', `${key} must be a nonempty string.`);
  }
  return value;
}

function identifier(value, key) {
  text(value, key);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw new HarnessError('INVALID_INPUT', `${key} must be a safe task/step/check identifier.`);
  }
  return value;
}

function inside(parent, target) {
  const path = relative(parent, target);
  if (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new HarnessError('OUTSIDE_WORKSPACE', 'Harness paths must stay inside the current checkout.');
  }
  return target;
}

async function localPath(parent, value) {
  text(value, 'path');
  if (isAbsolute(value)) throw new HarnessError('OUTSIDE_WORKSPACE', 'Use a workspace-relative path.');
  const candidate = inside(parent, resolve(parent, value));
  return inside(parent, await realpath(candidate));
}

export function modelSelection(value) {
  if (!value || typeof value.modelId !== 'string' || !value.modelId) {
    const keys = value && typeof value === 'object' ? Object.keys(value) : [];
    throw new HarnessError('MODEL_METADATA_UNAVAILABLE', `The host did not report modelId; fields: ${keys.join(', ')}`);
  }
  return { modelId: value.modelId };
}

export async function buildProofInvocation(value, sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ACTIONS.includes(value.action)) {
    throw new HarnessError('INVALID_INPUT', `action must be one of: ${ACTIONS.join(', ')}`);
  }
  const allowed = new Set(['action', 'project', 'timeoutSeconds', ...fields[value.action]]);
  if (value.action !== 'doctor') allowed.add('taskId');
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new HarnessError('INVALID_INPUT', `Unexpected field for ${value.action}.`);
  }
  const timeoutSeconds = Object.hasOwn(value, 'timeoutSeconds') ? value.timeoutSeconds : 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new HarnessError('INVALID_INPUT', 'timeoutSeconds must be an integer from 1 to 3600.');
  }
  const root = await realpath(ROOT);
  const project = await localPath(root, Object.hasOwn(value, 'project') ? value.project : '.');
  const args = [PROOF, value.action];
  if (value.action !== 'doctor') {
    const taskId = identifier(value.taskId, 'taskId');
    const stateDirectory = join(project, '.runtime-proof');
    if (existsSync(stateDirectory)) inside(project, await realpath(stateDirectory));
    const task = join(stateDirectory, taskId);
    if (existsSync(task)) inside(project, await realpath(task));
    if (value.action === 'init') {
      const kind = Object.hasOwn(value, 'kind') ? value.kind : 'cli';
      if (!['api', 'cli', 'generic', 'library', 'simulation', 'web'].includes(kind)) {
        throw new HarnessError('INVALID_INPUT', 'Unsupported task kind.');
      }
      args.push('--project', project, '--id', taskId, '--goal', text(value.goal, 'goal'),
        '--kind', kind, '--session-id', text(sessionId, 'sessionId'));
    } else {
      args.push('--task', task);
    }
  }
  if (value.action === 'step') {
    if (!['TODO', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFIED', 'BLOCKED'].includes(value.state)) {
      throw new HarnessError('INVALID_INPUT', 'Unsupported step state.');
    }
    args.push('--id', identifier(value.stepId, 'stepId'), '--status', value.state, '--note', text(value.note, 'note'));
    if (Object.hasOwn(value, 'agentRef')) args.push('--agent-ref', text(value.agentRef, 'agentRef'));
    if (Object.hasOwn(value, 'handoff')) args.push('--handoff', text(value.handoff, 'handoff').replaceAll('\\', '/'));
  }
  if (value.action === 'run') args.push('--check', identifier(value.checkId, 'checkId'));
  if (value.action === 'review') args.push('--input', await localPath(project, value.reviewFile));
  if (value.action === 'verify') args.push('--write-report');
  if (['block', 'resume'].includes(value.action)) args.push('--reason', text(value.reason, 'reason'));
  if (value.action === 'block') {
    args.push('--action', text(value.requiredAction, 'requiredAction'),
      '--evidence', text(value.evidence, 'evidence').replaceAll('\\', '/'));
  }
  return { executable: PYTHON, script: PROOF, args, project, action: value.action, timeoutMs: timeoutSeconds * 1000 };
}

export async function executeProof(command, signal) {
  const execution = await runProcess(command.executable, command.args, {
    cwd: command.project, timeoutMs: command.timeoutMs, signal,
  });
  return { action: command.action, ...execution };
}
