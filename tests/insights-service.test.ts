import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { generateInsight as generateInsightType } from '../src/insights/service.js';

let tempDir = '';
let generateInsight: typeof generateInsightType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;
const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function installFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-insights-service-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_OPENAI_API_KEY = 'openai-test-key';
  process.env.AGENTMONITOR_OPENAI_BASE_URL = 'https://openai.test/v1/';
  process.env.AGENTMONITOR_ANTHROPIC_API_KEY = 'anthropic-test-key';
  process.env.AGENTMONITOR_ANTHROPIC_BASE_URL = 'https://anthropic.test/v1/';
  process.env.AGENTMONITOR_GEMINI_API_KEY = 'gemini-test-key';
  process.env.AGENTMONITOR_GEMINI_BASE_URL = 'https://gemini.test/v1beta/';

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const service = await import('../src/insights/service.js');
  generateInsight = service.generateInsight;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  initSchema();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  getDb().exec(`
    DELETE FROM insights;
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM agents;
  `);
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('generateInsight sends an OpenAI responses request and stores the generated insight', async () => {
  let requestUrl = '';
  let requestHeaders: Headers;
  let requestBody: Record<string, unknown> = {};

  installFetch((input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '# Cost focus\n\nSpend is concentrated.' }],
        },
      ],
    });
  });

  const insight = await generateInsight({
    kind: 'usage',
    date_from: '2026-03-01',
    date_to: '2026-03-02',
    project: 'alpha',
    agent: 'claude',
    prompt: '  Watch cost.  ',
    provider: 'openai',
    model: 'gpt-test',
  });

  assert.equal(requestUrl, 'https://openai.test/v1/responses');
  assert.equal(requestHeaders!.get('authorization'), 'Bearer openai-test-key');
  assert.equal(requestBody.model, 'gpt-test');
  const input = requestBody.input as Array<{ role: string; content: string }>;
  assert.match(input[0]!.content, /usage and cost review/i);
  assert.match(input[1]!.content, /Additional user steering: Watch cost\./);
  assert.match(input[1]!.content, /"analytics_summary"/);
  assert.equal(insight.title, 'Cost focus');
  assert.equal(insight.prompt, 'Watch cost.');
  assert.equal(insight.provider, 'openai');
  assert.equal(insight.model, 'gpt-test');
  assert.equal(insight.project, 'alpha');
  assert.equal(insight.agent, 'claude');
  assert.ok(Array.isArray(insight.input_snapshot.usage_daily));
});

test('generateInsight sends an Anthropic messages request and extracts text content', async () => {
  let requestUrl = '';
  let requestHeaders: Headers;
  let requestBody: Record<string, unknown> = {};

  installFetch((input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      content: [
        { type: 'text', text: '# Workflow review\n\nTool failures are visible.' },
      ],
    });
  });

  const insight = await generateInsight({
    kind: 'workflow',
    date_from: '2026-03-01',
    date_to: '2026-03-01',
    provider: 'anthropic',
  });

  assert.equal(requestUrl, 'https://anthropic.test/v1/messages');
  assert.equal(requestHeaders!.get('x-api-key'), 'anthropic-test-key');
  assert.equal(requestHeaders!.get('anthropic-version'), '2023-06-01');
  assert.equal(requestBody.model, 'claude-sonnet-4-5');
  assert.match(String(requestBody.system), /workflow review/i);
  assert.equal(insight.title, 'Workflow review');
  assert.equal(insight.provider, 'anthropic');
});

test('generateInsight normalizes Gemini model paths and falls back to a date-range title', async () => {
  let requestUrl = '';
  let requestHeaders: Headers;
  let requestBody: Record<string, unknown> = {};

  installFetch((input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [{ text: 'No markdown heading in this response.' }],
          },
        },
      ],
    });
  });

  const insight = await generateInsight({
    kind: 'overview',
    date_from: '2026-03-03',
    date_to: '2026-03-03',
    provider: 'gemini',
    model: 'models/gemini-test',
  });

  assert.equal(requestUrl, 'https://gemini.test/v1beta/models/gemini-test:generateContent');
  assert.equal(requestHeaders!.get('x-goog-api-key'), 'gemini-test-key');
  assert.equal(requestHeaders!.get('x-goog-api-client'), 'agentmonitor-insights/1.0');
  assert.deepEqual(requestBody.generationConfig, { maxOutputTokens: 1800 });
  assert.match(JSON.stringify(requestBody.systemInstruction), /operational summary/i);
  assert.match(insight.title, /^Overview/);
  assert.match(insight.title, /2026-03-03/);
  assert.equal(insight.model, 'gemini-test');
  assert.equal(insight.provider, 'gemini');
});

test('generateInsight reports invalid ranges and provider response failures', async () => {
  await assert.rejects(
    () => generateInsight({ kind: 'overview', date_from: '', date_to: '2026-03-01' }),
    /date_from and date_to are required/,
  );
  await assert.rejects(
    () => generateInsight({ kind: 'overview', date_from: '2026-03-02', date_to: '2026-03-01' }),
    /date_from must be on or before date_to/,
  );

  installFetch(() => new Response('rate limited', { status: 429 }));
  await assert.rejects(
    () => generateInsight({
      kind: 'overview',
      date_from: '2026-03-01',
      date_to: '2026-03-01',
      provider: 'openai',
    }),
    /Insight generation failed \(429\): rate limited/,
  );
});
