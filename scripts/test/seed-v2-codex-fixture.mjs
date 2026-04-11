import fs from 'node:fs';
import path from 'node:path';

const homeDir = process.env.HOME;

if (!homeDir) {
  throw new Error('HOME is required for seed-v2-codex-fixture');
}

const sessionId = 'parity-v2-codex-session';
const project = 'parity-v2-codex-project';
const searchNeedle = 'NeedleCodexV2';

function isoOffset(msOffset) {
  return new Date(Date.now() + msOffset).toISOString();
}

function sampleJsonl(lines) {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

const codexHome = path.join(homeDir, '.codex');
const sessionDir = path.join(codexHome, 'sessions', '2026', '04', '11');

fs.mkdirSync(sessionDir, { recursive: true });

const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
const contents = sampleJsonl([
  {
    timestamp: isoOffset(-120_000),
    type: 'session_meta',
    payload: {
      id: sessionId,
      cwd: `/Users/parity/Dev/${project}`,
      originator: 'codex/0.1.0',
      timestamp: isoOffset(-120_000),
    },
  },
  {
    timestamp: isoOffset(-110_000),
    type: 'response_item',
    payload: {
      role: 'user',
      content: [{ type: 'text', text: `Fix the ${searchNeedle} integration test` }],
    },
  },
  {
    timestamp: isoOffset(-90_000),
    type: 'response_item',
    payload: {
      role: 'assistant',
      content: [{ type: 'text', text: `I'll look at the ${searchNeedle} test suite.` }],
    },
  },
  {
    timestamp: isoOffset(-85_000),
    type: 'response_item',
    payload: {
      name: 'apply_patch',
      input: `*** Begin Patch\n*** Update File: src/test.ts\n@@\n-  expect(result).toBe(false);\n+  expect(result).toBe(true);\n*** End Patch`,
    },
  },
  {
    timestamp: isoOffset(-80_000),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1200,
          output_tokens: 350,
          cached_input_tokens: 400,
          total_tokens: 1550,
        },
      },
    },
  },
  {
    timestamp: isoOffset(-60_000),
    type: 'response_item',
    payload: {
      role: 'user',
      content: [{ type: 'text', text: 'Looks good, run the tests now.' }],
    },
  },
  {
    timestamp: isoOffset(-40_000),
    type: 'response_item',
    payload: {
      role: 'assistant',
      content: [{ type: 'text', text: 'All tests passing after the fix.' }],
    },
  },
  {
    timestamp: isoOffset(-30_000),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 2400,
          output_tokens: 700,
          cached_input_tokens: 800,
          total_tokens: 3100,
        },
      },
    },
  },
]);

// Write a config.toml so the importer can resolve the model
const configPath = path.join(codexHome, 'config.toml');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, 'model = "o3-mini"\n', 'utf8');
}

fs.writeFileSync(filePath, contents, 'utf8');
