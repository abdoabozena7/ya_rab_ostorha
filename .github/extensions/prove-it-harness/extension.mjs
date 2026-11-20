import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { joinSession } from '@github/copilot-sdk/extension';
import { ACTIONS, HarnessError, PROOF, PYTHON, ROOT, buildProofInvocation, executeProof, modelSelection } from './harness.mjs';

const sessionId = process.env.SESSION_ID;
if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('A valid native Copilot SDK session is required.');
const loadedAt = new Date().toISOString();
const output = join(ROOT, '.runtime-proof', 'copilot-native-observations', sessionId);
mkdirSync(output, { recursive: true });
const trace = join(output, `trace-${randomUUID()}.jsonl`);
const hash = createHash('sha256');
for (const name of ['extension.mjs', 'harness.mjs', 'process.mjs']) {
  hash.update(name + '\0');
  hash.update(readFileSync(new URL(name, import.meta.url)));
}
const sourceHash = hash.digest('hex');
let session;
let active;
let preToolCount = 0;
const primaryModels = new Set();
let usageCount = 0;

function record(type, data = {}) {
  appendFileSync(trace, JSON.stringify({
    type, at: new Date().toISOString(), sessionId, sourceHash, ...data,
  }) + '\n');
}

async function readModel() {
  const selected = modelSelection(await session.rpc.model.getCurrent());
  record('model.selection', selected);
  return selected;
}

function toolHandler(action) {
  return async (args, invocation) => {
    try {
      if (invocation.sessionId !== sessionId) throw new HarnessError('SESSION_MISMATCH', 'The tool belongs to the existing Copilot session only.');
      return await action(args, invocation);
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      record('tool.rejected', { toolCallId: invocation.toolCallId, code: error.code });
      return { resultType: 'failure', textResultForLlm: JSON.stringify({ error: error.code, message: error.message }) };
    }
  };
}

session = await joinSession({
  streaming: true,
  hooks: {
    onPreToolUse: (input) => {
      preToolCount += 1;
      record('sdk.pre_tool', { toolName: input.toolName });
    },
  },
  tools: [
    {
      name: 'copilot_harness_status',
      description: 'Read this existing Copilot session’s selected model and observed primary usage/tool metadata. No inference, provider login, model change or new agent is started.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: toolHandler(async () => {
        const selectedModel = await readModel();
        const snapshot = join(output, `snapshot-${randomUUID()}.jsonl`);
        writeFileSync(snapshot, readFileSync(trace));
        return {
          resultType: 'success',
          textResultForLlm: JSON.stringify({
            sessionId, selectedModel, primaryModelsObserved: [...primaryModels],
            primaryUsageEventsObserved: usageCount,
            preToolHook: { registered: true, observedCalls: preToolCount, purpose: 'metadata observation only' },
            automaticStopBlocking: { installed: false, verified: false },
            proofScript: PROOF, pythonExecutable: PYTHON, sourceHash,
            evidenceSnapshot: relative(ROOT, snapshot),
            billing: 'No precise credit measurement collected or inferred.',
          }),
        };
      }),
    },
    {
      name: 'copilot_proof',
      description: 'Run the installed deterministic Prove It collector for planning, task DAG steps, execution receipts, reviews, verification and recovery. Copilot retains all reasoning and model ownership. Read the skill, review declared commands, and never put model delegation or unauthorized simulation in a contract.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          project: { type: 'string', description: 'Existing checkout-relative project directory; default ".".' },
          taskId: { type: 'string' },
          goal: { type: 'string' },
          kind: { type: 'string', enum: ['api', 'cli', 'generic', 'library', 'simulation', 'web'] },
          stepId: { type: 'string' },
          state: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFIED', 'BLOCKED'] },
          note: { type: 'string' },
          checkId: { type: 'string' },
          reviewFile: { type: 'string', description: 'Project-relative existing review input file.' },
          reason: { type: 'string' },
          requiredAction: { type: 'string' },
          evidence: { type: 'string', description: 'Task-relative raw blocker evidence.' },
          agentRef: { type: 'string', description: 'Only an actual native worker invocation ID, when one was used.' },
          handoff: { type: 'string' },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 120 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: toolHandler(async (args, invocation) => {
        if (active) throw new HarnessError('BUSY', 'A deterministic Prove It operation is already running.');
        const controller = new AbortController();
        active = controller;
        try {
          const command = await buildProofInvocation(args, invocation.sessionId);
          const selected = await readModel();
          record('helper.started', {
            toolCallId: invocation.toolCallId, executable: command.executable,
            script: command.script, action: command.action, modelId: selected.modelId,
          });
          const result = await executeProof(command, controller.signal);
          record('helper.completed', {
            toolCallId: invocation.toolCallId, executable: command.executable,
            script: command.script, action: command.action, exitCode: result.exitCode,
            launcherPid: result.launcherPid, problem: result.problem, durationMs: result.durationMs,
          });
          return {
            resultType: !result.problem && result.exitCode === 0 ? 'success' : 'failure',
            textResultForLlm: JSON.stringify(result),
          };
        } finally {
          active = undefined;
        }
      }),
    },
  ],
});

record('extension.loaded', { pid: process.pid, loadedAt });
session.on('assistant.usage', (event) => {
  if (event.timestamp < loadedAt || event.agentId || typeof event.data.model !== 'string') return;
  usageCount += 1;
  primaryModels.add(event.data.model);
  record('model.usage', { eventId: event.id, model: event.data.model, agentId: null });
});
session.on('tool.execution_start', (event) => {
  if (event.timestamp < loadedAt || event.agentId) return;
  record('native.tool', { toolName: event.data.toolName, toolCallId: event.data.toolCallId });
});
process.once('SIGTERM', () => active?.abort());
process.once('disconnect', () => active?.abort());
