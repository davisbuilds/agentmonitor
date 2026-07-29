import assert from 'node:assert/strict';
import { execSync, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { normalizeIngestEvent } from '../src/contracts/event-contract.js';

const HOOKS_DIR = path.resolve(import.meta.dirname, '..', 'hooks', 'claude-code');
const PYTHON_DIR = path.join(HOOKS_DIR, 'python');

// Set a bogus URL so curl/urllib don't actually connect
const ENV = {
  ...process.env,
  AGENTMONITOR_URL: 'http://127.0.0.1:0',
  AGENTMONITOR_SAFETY: '1',
};

function makeSessionStartInput(): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'claude-sonnet-4-5-20250929',
  });
}

function makeStopInput(): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.',
  });
}

function makePostToolUseInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_use_id: 'toolu_01ABC123',
    tool_input: toolInput,
    tool_response: { success: true },
  });
}

function makePreToolUseInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'toolu_01DEF456',
    tool_input: toolInput,
  });
}

function makeNotificationInput(): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'Notification',
    message: 'Task completed successfully',
    title: 'Done',
    notification_type: 'idle_prompt',
  });
}

function makeInstructionsLoadedInput(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 'test-session-001',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'InstructionsLoaded',
    file_path: '/home/user/my-project/CLAUDE.md',
    memory_type: 'Project',
    load_reason: 'session_start',
    content: 'must never be emitted',
    ...overrides,
  });
}

interface CapturedHookPayload {
  event_id?: string;
  session_id: string;
  agent_type: string;
  event_type: string;
  project?: string;
  metadata?: Record<string, unknown>;
}

function runHookProcess(
  executable: string,
  args: string[],
  stdin: string,
  url: string,
  envOverrides: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...ENV, ...envOverrides, AGENTMONITOR_URL: url },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with ${code}: ${stderr}`));
    });
    child.stdin.end(stdin);
  });
}

async function captureHookPayloads(
  runs: Array<{
    executable: string;
    args: string[];
    stdin: string;
    env?: Record<string, string>;
  }>,
): Promise<CapturedHookPayload[]> {
  const payloads: CapturedHookPayload[] = [];
  let resolveReceived: (() => void) | undefined;
  const received = new Promise<void>(resolve => {
    resolveReceived = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedHookPayload);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      if (payloads.length === runs.length) resolveReceived?.();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  try {
    for (const run of runs) {
      await runHookProcess(run.executable, run.args, run.stdin, url, run.env);
    }
    await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(
          `Expected ${runs.length} hook payloads, received ${payloads.length}`,
        )), 1_000);
      }),
    ]);
    return payloads;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function runShellHook(script: string, stdin: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [path.join(HOOKS_DIR, script)], {
      input: stdin,
      env: ENV,
      timeout: 10000,
      encoding: 'utf-8',
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function runPythonHook(script: string, stdin: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('python3', [path.join(PYTHON_DIR, script)], {
      input: stdin,
      env: ENV,
      timeout: 10000,
      encoding: 'utf-8',
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function runStatuslineInstaller(args: string[], envOverrides: Record<string, string> = {}) {
  return execFileSync('bash', [path.join(HOOKS_DIR, 'install-statusline-bridge.sh'), ...args], {
    env: { ...process.env, ...envOverrides },
    timeout: 10000,
    encoding: 'utf-8',
  });
}

// Validate that the payload a hook would send matches our contract
function validatePayloadShape(eventType: string, fields: Record<string, unknown>) {
  const result = normalizeIngestEvent({
    session_id: 'test-session-001',
    agent_type: 'claude_code',
    event_type: eventType,
    source: 'hook',
    ...fields,
  });
  assert.equal(result.ok, true, `Contract validation failed for ${eventType}: ${JSON.stringify(result)}`);
}

describe('Shell hook scripts', () => {
  test('session_start.sh exits 0', () => {
    const result = runShellHook('session_start.sh', makeSessionStartInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('session_end.sh exits 0', () => {
    const result = runShellHook('session_end.sh', makeStopInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('post_tool_use.sh exits 0 for Bash tool', () => {
    const result = runShellHook(
      'post_tool_use.sh',
      makePostToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('post_tool_use.sh exits 0 for Read tool', () => {
    const result = runShellHook(
      'post_tool_use.sh',
      makePostToolUseInput('Read', { file_path: '/src/index.ts' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('notification.sh exits 0', () => {
    const result = runShellHook('notification.sh', makeNotificationInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 0 for safe Bash command', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 2 for rm -rf /', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Bash', { command: 'rm -rf /' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
    assert.ok(result.stderr.includes('Blocked'), `stderr should contain block message: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 2 for rm -rf ~', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Bash', { command: 'rm -rf ~' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
  });

  test('pre_tool_use.sh exits 0 for non-Bash tools', () => {
    const result = runShellHook(
      'pre_tool_use.sh',
      makePreToolUseInput('Read', { file_path: '/etc/passwd' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.sh exits 0 when safety is disabled', () => {
    try {
      execFileSync('bash', [path.join(HOOKS_DIR, 'pre_tool_use.sh')], {
        input: makePreToolUseInput('Bash', { command: 'rm -rf /' }),
        env: { ...ENV, AGENTMONITOR_SAFETY: '0' },
        timeout: 10000,
        encoding: 'utf-8',
      });
      // If we get here, exit code was 0
    } catch (err: unknown) {
      const e = err as { status: number };
      assert.fail(`Expected exit 0 with safety disabled, got ${e.status}`);
    }
  });
});

describe('Python hook scripts', () => {
  // Check if python3 is available
  let hasPython = false;
  try {
    execSync('python3 --version', { encoding: 'utf-8', timeout: 5000 });
    hasPython = true;
  } catch {
    // python3 not available
  }

  if (!hasPython) {
    test('python3 not available, skipping Python hook tests', { skip: 'python3 not found' }, () => {});
    return;
  }

  test('session_start.py exits 0', () => {
    const result = runPythonHook('session_start.py', makeSessionStartInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('session_end.py exits 0', () => {
    const result = runPythonHook('session_end.py', makeStopInput());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('post_tool_use.py exits 0 for Bash tool', () => {
    const result = runPythonHook(
      'post_tool_use.py',
      makePostToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.py exits 0 for safe command', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Bash', { command: 'npm test' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test('pre_tool_use.py exits 2 for rm -rf /', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Bash', { command: 'rm -rf /' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
    assert.ok(result.stderr.includes('Blocked'), `stderr should contain block message: ${result.stderr}`);
  });

  test('pre_tool_use.py exits 2 for rm -rf ~', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Bash', { command: 'rm -rf ~' })
    );
    assert.equal(result.exitCode, 2, 'Expected exit code 2 for destructive command');
  });

  test('pre_tool_use.py exits 0 for non-Bash tools', () => {
    const result = runPythonHook(
      'pre_tool_use.py',
      makePreToolUseInput('Read', { file_path: '/etc/passwd' })
    );
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });
});

describe('Claude statusline bridge installer', () => {
  let hasJq = false;
  try {
    execSync('jq --version', { encoding: 'utf-8', timeout: 5000 });
    hasJq = true;
  } catch {
    // jq not available
  }

  if (!hasJq) {
    test('jq not available, skipping statusline bridge installer tests', { skip: 'jq not found' }, () => {});
    return;
  }

  test('preserves the original statusline command across reinstalls', () => {
    const claudeDir = mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-statusline-bridge-'));

    try {
      const settingsPath = path.join(claudeDir, 'settings.json');
      const forwardPath = path.join(claudeDir, 'agentmonitor-statusline-forward.txt');
      const originalCommand = 'original-statusline --flag';

      writeFileSync(
        settingsPath,
        JSON.stringify({ statusLine: { command: originalCommand } }, null, 2)
      );

      runStatuslineInstaller([], { CLAUDE_CONFIG_DIR: claudeDir });
      assert.equal(readFileSync(forwardPath, 'utf8'), originalCommand);

      runStatuslineInstaller(['--url', 'http://127.0.0.1:9999'], { CLAUDE_CONFIG_DIR: claudeDir });
      assert.equal(readFileSync(forwardPath, 'utf8'), originalCommand);

      runStatuslineInstaller(['--uninstall'], { CLAUDE_CONFIG_DIR: claudeDir });

      const restoredSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        statusLine?: { command?: string };
      };
      assert.equal(restoredSettings.statusLine?.command, originalCommand);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('Hook payload contract validation', () => {
  test('session_start payload passes contract', () => {
    validatePayloadShape('session_start', {
      project: 'my-project',
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  test('session_end payload passes contract', () => {
    validatePayloadShape('session_end', { project: 'my-project' });
  });

  test('tool_use payload passes contract', () => {
    validatePayloadShape('tool_use', {
      tool_name: 'Bash',
      project: 'my-project',
      metadata: { command: 'npm test', tool_use_id: 'toolu_01ABC123' },
    });
  });

  test('response payload passes contract', () => {
    validatePayloadShape('response', {
      project: 'my-project',
      metadata: { notification_type: 'idle_prompt', message: 'Done' },
    });
  });

  test('error payload passes contract (blocked command)', () => {
    validatePayloadShape('error', {
      tool_name: 'Bash',
      status: 'error',
      project: 'my-project',
      metadata: { blocked: true, reason: 'destructive_command', command: 'rm -rf /' },
    });
  });

  test('instruction_load payload passes contract', () => {
    validatePayloadShape('instruction_load', {
      project: 'my-project',
      metadata: {
        file_path: '/home/user/my-project/CLAUDE.md',
        memory_type: 'Project',
        load_reason: 'session_start',
      },
    });
  });
});

describe('Instruction-load telemetry hooks', () => {
  test('shell hook emits each received load without instruction contents', async () => {
    const script = path.join(HOOKS_DIR, 'instructions_loaded.sh');
    const payloads = await captureHookPayloads([
      {
        executable: 'bash',
        args: [script],
        stdin: makeInstructionsLoadedInput(),
      },
      {
        executable: 'bash',
        args: [script],
        stdin: makeInstructionsLoadedInput({ load_reason: 'compact' }),
      },
    ]);

    assert.deepEqual(payloads.map(payload => payload.event_type), [
      'instruction_load',
      'instruction_load',
    ]);
    assert.deepEqual(payloads.map(payload => payload.metadata?.['load_reason']), [
      'session_start',
      'compact',
    ]);
    assert.equal(payloads.every(payload => payload.event_id === undefined), true);
    assert.equal(JSON.stringify(payloads).includes('must never be emitted'), false);
  });

  test('shell hook tolerates absent optional fields without jq', async () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-no-jq-'));
    const sourcePath = ENV.PATH ?? '';
    try {
      for (const command of ['basename', 'cat', 'curl', 'dirname', 'grep', 'head', 'sed']) {
        const executable = sourcePath
          .split(path.delimiter)
          .map(directory => path.join(directory, command))
          .find(candidate => existsSync(candidate));
        assert.ok(executable, `expected ${command} on the test runner PATH`);
        symlinkSync(realpathSync(executable), path.join(binDir, command));
      }

      const payloads = await captureHookPayloads([{
        executable: '/bin/bash',
        args: [path.join(HOOKS_DIR, 'instructions_loaded.sh')],
        stdin: makeInstructionsLoadedInput(),
        env: { PATH: binDir },
      }]);

      assert.deepEqual(payloads[0]?.metadata, {
        file_path: '/home/user/my-project/CLAUDE.md',
        memory_type: 'Project',
        load_reason: 'session_start',
      });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('Python hook preserves optional load metadata without instruction contents', async () => {
    const payloads = await captureHookPayloads([{
      executable: 'python3',
      args: [path.join(PYTHON_DIR, 'instructions_loaded.py')],
      stdin: makeInstructionsLoadedInput({
        load_reason: 'path_glob_match',
        globs: ['src/**/*.ts'],
        trigger_file_path: '/home/user/my-project/src/index.ts',
        parent_file_path: '/home/user/my-project/CLAUDE.md',
      }),
    }]);

    assert.deepEqual(payloads[0]?.metadata, {
      file_path: '/home/user/my-project/CLAUDE.md',
      memory_type: 'Project',
      load_reason: 'path_glob_match',
      globs: ['src/**/*.ts'],
      trigger_file_path: '/home/user/my-project/src/index.ts',
      parent_file_path: '/home/user/my-project/CLAUDE.md',
    });
    assert.equal(JSON.stringify(payloads).includes('must never be emitted'), false);
  });

  test('SessionStart hooks preserve the instruction-load instrumentation marker', async () => {
    const payloads = await captureHookPayloads([
      {
        executable: 'bash',
        args: [path.join(HOOKS_DIR, 'session_start.sh')],
        stdin: makeSessionStartInput(),
        env: { AGENTMONITOR_INSTRUCTION_LOAD_INSTRUMENTED: '1' },
      },
      {
        executable: 'python3',
        args: [path.join(PYTHON_DIR, 'session_start.py')],
        stdin: makeSessionStartInput(),
        env: { AGENTMONITOR_INSTRUCTION_LOAD_INSTRUMENTED: '1' },
      },
    ]);

    assert.equal(
      payloads.every(
        payload => payload.metadata?.['instruction_load_instrumented'] === true,
      ),
      true,
    );
  });
});
