import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOOKS_DIR = path.resolve(import.meta.dirname, '..', 'hooks', 'claude-code');
const INSTALLER = path.join(HOOKS_DIR, 'install.sh');

interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookHandler[];
}

interface ClaudeSettings {
  theme?: string;
  hooks?: Record<string, HookMatcher[]>;
}

function runInstaller(
  args: string[],
  configDir: string,
): void {
  execFileSync('bash', [INSTALLER, ...args], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    },
    timeout: 10_000,
    encoding: 'utf8',
  });
}

function readSettings(configDir: string): ClaudeSettings {
  return JSON.parse(
    readFileSync(path.join(configDir, 'settings.json'), 'utf8'),
  ) as ClaudeSettings;
}

function commandsFor(
  settings: ClaudeSettings,
  eventName: string,
): string[] {
  return (settings.hooks?.[eventName] ?? [])
    .flatMap(matcher => matcher.hooks ?? [])
    .map(hook => hook.command ?? '');
}

let hasJq = false;
try {
  execSync('jq --version', { encoding: 'utf8', timeout: 5_000 });
  hasJq = true;
} catch {
  // The installer itself requires jq.
}

test('installer registers both instruction-load modes and preserves unrelated settings', {
  skip: hasJq ? false : 'jq not found',
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-claude-hooks-'));
  const configDir = path.join(root, 'claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    theme: 'dark',
    hooks: {
      SessionStart: [{
        matcher: '',
        hooks: [
          { type: 'command', command: '/opt/unrelated/session-start.sh' },
          {
            type: 'command',
            command: 'AGENTMONITOR_URL=http://127.0.0.1:7777 /opt/custom/session-audit.sh',
          },
        ],
      }],
      InstructionsLoaded: [{
        matcher: 'compact',
        hooks: [{ type: 'command', command: '/opt/unrelated/instructions.sh' }],
      }],
    },
  }, null, 2));

  try {
    runInstaller(['--url', 'http://127.0.0.1:3999'], configDir);
    const shellSettings = readSettings(configDir);
    const shellInstructionMatchers = shellSettings.hooks?.['InstructionsLoaded'] ?? [];
    const shellInstruction = shellInstructionMatchers.find(matcher =>
      matcher.hooks?.some(hook => hook.command?.includes('instructions_loaded.sh')));
    assert.ok(shellInstruction);
    assert.equal(shellInstruction.matcher, '');
    assert.equal(shellInstruction.hooks?.[0]?.async, true);
    assert.match(shellInstruction.hooks?.[0]?.command ?? '', /AGENTMONITOR_URL=http:\/\/127\.0\.0\.1:3999/);
    assert.ok(commandsFor(shellSettings, 'SessionStart').some(command =>
      command.includes('AGENTMONITOR_INSTRUCTION_LOAD_INSTRUMENTED=1')));
    assert.ok(commandsFor(shellSettings, 'SessionStart').includes('/opt/unrelated/session-start.sh'));
    assert.ok(commandsFor(shellSettings, 'SessionStart').includes(
      'AGENTMONITOR_URL=http://127.0.0.1:7777 /opt/custom/session-audit.sh',
    ));
    assert.ok(commandsFor(shellSettings, 'InstructionsLoaded').includes('/opt/unrelated/instructions.sh'));
    assert.equal(shellSettings.theme, 'dark');

    runInstaller(['--python', '--url', 'http://127.0.0.1:3999'], configDir);
    const pythonSettings = readSettings(configDir);
    assert.ok(commandsFor(pythonSettings, 'InstructionsLoaded').some(command =>
      command.includes('python/instructions_loaded.py')));
    assert.equal(commandsFor(pythonSettings, 'InstructionsLoaded').some(command =>
      command.endsWith('/instructions_loaded.sh')), false);
    assert.ok(commandsFor(pythonSettings, 'SessionStart').includes('/opt/unrelated/session-start.sh'));
    assert.ok(commandsFor(pythonSettings, 'SessionStart').includes(
      'AGENTMONITOR_URL=http://127.0.0.1:7777 /opt/custom/session-audit.sh',
    ));
    assert.ok(commandsFor(pythonSettings, 'InstructionsLoaded').includes('/opt/unrelated/instructions.sh'));

    runInstaller(['--uninstall'], configDir);
    const uninstalled = readSettings(configDir);
    assert.deepEqual(commandsFor(uninstalled, 'SessionStart'), [
      '/opt/unrelated/session-start.sh',
      'AGENTMONITOR_URL=http://127.0.0.1:7777 /opt/custom/session-audit.sh',
    ]);
    assert.deepEqual(commandsFor(uninstalled, 'InstructionsLoaded'), ['/opt/unrelated/instructions.sh']);
    assert.equal(uninstalled.theme, 'dark');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
