import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';
let claudeDir = '';
let dbPath = '';
let baseUrl = '';
let rustProcess: ChildProcessWithoutNullStreams | null = null;
let rustLogs = '';

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to resolve free port'));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Rust server did not become healthy within ${timeoutMs}ms.\n${rustLogs}`);
}

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));
}

async function runRustImport(): Promise<void> {
  const cargoPath = path.join(process.env.HOME || '', '.cargo', 'bin', 'cargo');
  const cargo = fs.existsSync(cargoPath) ? cargoPath : 'cargo';

  const importProcess = spawn(
    cargo,
    ['run', '--manifest-path', 'rust-backend/Cargo.toml', '--bin', 'import', '--', '--source', 'claude-code', '--claude-dir', claudeDir],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTMONITOR_RUST_DB_PATH: dbPath,
      },
      stdio: 'pipe',
    },
  );

  let output = '';
  importProcess.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  importProcess.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const [code] = await once(importProcess, 'exit') as [number | null];
  if (code !== 0) {
    throw new Error(`Rust import failed with exit code ${code}.\n${output}`);
  }
}

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-rust-v2-'));
  claudeDir = path.join(tempDir, 'claude-root');
  dbPath = path.join(tempDir, 'agentmonitor-rs.db');

  const projectDir = path.join(claudeDir, 'projects', '-Users-dg-mac-mini-Dev-project-alpha');
  writeJsonl(path.join(projectDir, 'parity-v2-parent.jsonl'), [
    {
      type: 'user',
      sessionId: 'parity-v2-parent',
      timestamp: '2026-04-09T10:00:00Z',
      message: { role: 'user', content: 'NeedleRustUi parent' },
    },
    {
      type: 'assistant',
      sessionId: 'parity-v2-parent',
      timestamp: '2026-04-09T10:01:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'delegate' },
          { type: 'tool_use', id: 'tool-1', name: 'Agent', input: { session_id: 'agent-child-1' } },
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'NeedleRustUi delegated', is_error: false },
        ],
      },
    },
    {
      type: 'assistant',
      sessionId: 'parity-v2-parent',
      timestamp: '2026-04-09T10:02:00Z',
      message: { role: 'assistant', content: 'NeedleRustUi complete' },
    },
  ]);
  writeJsonl(path.join(projectDir, 'agent-child-1.jsonl'), [
    {
      type: 'user',
      sessionId: 'agent-child-1',
      timestamp: '2026-04-09T10:01:30Z',
      message: { role: 'user', content: 'Child prompt' },
    },
    {
      type: 'assistant',
      sessionId: 'agent-child-1',
      timestamp: '2026-04-09T10:01:45Z',
      message: { role: 'assistant', content: 'Child answer' },
    },
  ]);

  await runRustImport();

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const cargoPath = path.join(process.env.HOME || '', '.cargo', 'bin', 'cargo');
  const cargo = fs.existsSync(cargoPath) ? cargoPath : 'cargo';

  rustProcess = spawn(
    cargo,
    ['run', '--manifest-path', 'rust-backend/Cargo.toml', '--bin', 'agentmonitor-rs'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTMONITOR_HOST: '127.0.0.1',
        AGENTMONITOR_RUST_PORT: String(port),
        AGENTMONITOR_RUST_DB_PATH: dbPath,
        AGENTMONITOR_AUTO_IMPORT_MINUTES: '0',
        AGENTMONITOR_STATS_INTERVAL: '60000',
        AGENTMONITOR_UI_DIR: path.join(process.cwd(), 'public'),
        AGENTMONITOR_APP_UI_DIR: path.join(process.cwd(), 'frontend', 'dist'),
      },
      stdio: 'pipe',
    },
  );

  rustProcess.stdout.on('data', (chunk) => {
    rustLogs += chunk.toString();
  });
  rustProcess.stderr.on('data', (chunk) => {
    rustLogs += chunk.toString();
  });

  await waitForHealth(baseUrl, 15000);
});

test.afterAll(async () => {
  if (rustProcess) {
    rustProcess.kill('SIGTERM');
    await Promise.race([
      once(rustProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (rustProcess.exitCode === null && rustProcess.signalCode === null) {
      rustProcess.kill('SIGKILL');
      await once(rustProcess, 'exit');
    }
  }

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rust runtime boots Sessions, Search, and Analytics tabs against v2 history', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto(`${baseUrl}/app/`);
  await expect(page.getByText('AgentMonitor')).toBeVisible();

  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByText('NeedleRustUi parent')).toBeVisible();
  await expect(
    page.getByRole('button').filter({ hasText: 'NeedleRustUi parent' }).getByText('project-alpha')
  ).toBeVisible();

  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByPlaceholder('Search across all conversations...').fill('NeedleRustUi');
  await page.getByRole('button', { name: 'Search' }).last().click();
  await expect(
    page.locator('main button').filter({ hasText: 'NeedleRustUi' }).first()
  ).toBeVisible();

  await page.getByRole('button', { name: 'Analytics' }).click();
  await expect(page.getByText('Total Sessions')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tool Usage' })).toBeVisible();
  await expect(
    page.locator('section').filter({ hasText: 'Projects' }).getByText('project-alpha').first()
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});
