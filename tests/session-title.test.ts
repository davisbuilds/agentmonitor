import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  codexSubagentTitle,
  isCodexAppJobPrompt,
  isInjectedContextText,
  promptTitleFromTexts,
  untitledSessionName,
} from '../src/parser/session-title.js';

const AGENTS_MD = '# AGENTS.md instructions for /Users/dev/project\n\n<INSTRUCTIONS>\n# AGENTS.md\nRules.\n</INSTRUCTIONS>';
const ENVIRONMENT = '<environment_context>\n  <cwd>/Users/dev/project</cwd>\n  <shell>zsh</shell>\n</environment_context>';

describe('isInjectedContextText', () => {
  test('recognizes the context harnesses write into user messages', () => {
    for (const text of [
      AGENTS_MD,
      ENVIRONMENT,
      '<recommended_plugins>\nHere is a list of plugins.\n</recommended_plugins>',
      '<turn_aborted>\nThe user interrupted.\n</turn_aborted>',
      '<subagent_notification>{"agent":"x"}</subagent_notification>',
      '<codex_internal_context source="daemon_recovery">resume</codex_internal_context>',
      '<task-notification>\n<task-id>b1</task-id>\n</task-notification>',
      '<system-reminder>Remember this.</system-reminder>',
      '<local-command-caveat>Caveat</local-command-caveat>',
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
      '<local-command-stdout>done</local-command-stdout>',
      '<bash-input>git status</bash-input><bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>',
      '<skill>\n<name>review</name>\n</skill>',
      '<user_action>\n  <context>User initiated a review task.</context>\n</user_action>',
      '<image name=[Image #1]>',
      '</image>',
    ]) {
      assert.equal(isInjectedContextText(text), true, text.slice(0, 40));
    }
  });

  test('keeps prompts, including ones that start or end with markup', () => {
    for (const text of [
      'Fix the failing test in parser.ts',
      '<div> is not centered on the settings page',
      'Use <environment_context> in the fixture',
      '# Plan: migrate to pnpm\n\nSteps below.',
      '<b>bold</b> text and then more words',
      '<task>Review the authentication flow</task>',
      '<div class="card">Fix the card padding</div>',
    ]) {
      assert.equal(isInjectedContextText(text), false, text);
    }
  });
});

describe('promptTitleFromTexts', () => {
  test('skips injected blocks and returns the first prompt', () => {
    assert.equal(
      promptTitleFromTexts([AGENTS_MD, ENVIRONMENT, 'Review the open PR']),
      'Review the open PR',
    );
  });

  test('returns null when every block is injected', () => {
    assert.equal(promptTitleFromTexts([AGENTS_MD, ENVIRONMENT]), null);
    assert.equal(promptTitleFromTexts([]), null);
    assert.equal(promptTitleFromTexts(['   ']), null);
  });

  test('collapses whitespace, strips ANSI color and caps the length', () => {
    assert.equal(promptTitleFromTexts(['  fix\n\n the \u001b[31mbug\u001b[0m  ']), 'fix the bug');
    const long = 'word '.repeat(100);
    const title = promptTitleFromTexts([long]);
    assert.equal(title?.length, 200);
  });
});

describe('isCodexAppJobPrompt', () => {
  test('recognizes the Codex app background jobs', () => {
    for (const text of [
      'Generate a concise, single-line task title of at most 36 characters and under five words where possible.',
      'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.',
      'Write a brief catch-up for a user returning to this Codex task. In at most 40 words',
      'Write a brief catch-up for a user returning to this task. Return JSON with summary',
      'Consolidate the supplied rollout summaries into `memory_summary.md` so another agent',
    ]) {
      assert.equal(isCodexAppJobPrompt(text), true, text.slice(0, 40));
    }
  });

  test('leaves user prompts alone, even ones that mention titles or catch-ups', () => {
    for (const text of [
      'Generate a title for the blog post',
      'You are a helpful assistant. Summarize this file.',
      'Write a brief catch-up email for the team',
      '',
    ]) {
      assert.equal(isCodexAppJobPrompt(text), false, text);
    }
  });
});

describe('codexSubagentTitle', () => {
  test('names a subagent by the task name its parent gave it', () => {
    assert.equal(codexSubagentTitle('/root/emil_pstack'), 'emil pstack');
    assert.equal(codexSubagentTitle('/root/review/auth_flow_check'), 'auth flow check');
  });

  test('returns null for a missing or empty path', () => {
    assert.equal(codexSubagentTitle(undefined), null);
    assert.equal(codexSubagentTitle(42), null);
    assert.equal(codexSubagentTitle('/root/'), null);
    assert.equal(codexSubagentTitle('/root'), null);
  });
});

describe('untitledSessionName', () => {
  test('names the agent when it is known', () => {
    assert.equal(untitledSessionName('codex'), 'Untitled Codex session');
    assert.equal(untitledSessionName('claude_code'), 'Untitled Claude Code session');
    assert.equal(untitledSessionName('mystery'), 'Untitled session');
    assert.equal(untitledSessionName(null), 'Untitled session');
  });
});
