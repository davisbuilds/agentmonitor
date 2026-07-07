import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { claudeInvocationMode, codexInvocationMode } from '../src/util/invocation-mode.js';

describe('claudeInvocationMode', () => {
  test('sdk-cli entrypoint is headless (claude -p)', () => {
    assert.equal(claudeInvocationMode('sdk-cli', undefined), 'headless');
  });

  test('sdk promptSource is headless even without entrypoint', () => {
    assert.equal(claudeInvocationMode(undefined, 'sdk'), 'headless');
  });

  test('cli entrypoint is interactive', () => {
    assert.equal(claudeInvocationMode('cli', 'typed'), 'interactive');
  });

  test('unknown entrypoint yields no signal', () => {
    assert.equal(claudeInvocationMode('vscode', undefined), undefined);
    assert.equal(claudeInvocationMode(undefined, undefined), undefined);
  });
});

describe('codexInvocationMode', () => {
  test('codex_exec originator is headless (codex exec)', () => {
    assert.equal(codexInvocationMode('codex_exec'), 'headless');
  });

  test('interactive originators map to interactive', () => {
    assert.equal(codexInvocationMode('codex-tui'), 'interactive');
    assert.equal(codexInvocationMode('codex_cli_rs'), 'interactive');
    assert.equal(codexInvocationMode('Codex Desktop'), 'interactive');
  });

  test('unknown / missing originator yields no signal', () => {
    assert.equal(codexInvocationMode('some_future_thing'), undefined);
    assert.equal(codexInvocationMode(undefined), undefined);
  });
});
