import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

let tempHome = '';
let claudeDir = '';
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

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-rust-live-'));
  claudeDir = path.join(tempHome, '.claude');
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const endedAt = new Date(Date.now() - 5_000).toISOString();

  const projectDir = path.join(claudeDir, 'projects', '-Users-dg-mac-mini-Dev-project-live');
  writeJsonl(path.join(projectDir, 'rust-live-phase3.jsonl'), [
    {
      type: 'user',
      sessionId: 'rust-live-phase3',
      timestamp: startedAt,
      message: { role: 'user', content: 'NeedleRustLive auto import' },
    },
    {
      type: 'assistant',
      sessionId: 'rust-live-phase3',
      timestamp: endedAt,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspecting live parity' },
          { type: 'text', text: 'Rust live answer' },
        ],
      },
    },
  ]);

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const originalHome = process.env.HOME || '';
  const cargoPath = path.join(originalHome, '.cargo', 'bin', 'cargo');
  const cargo = fs.existsSync(cargoPath) ? cargoPath : 'cargo';

  rustProcess = spawn(
    cargo,
    ['run', '--manifest-path', 'rust-backend/Cargo.toml', '--bin', 'agentmonitor-rs'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        CARGO_HOME: process.env.CARGO_HOME || path.join(originalHome, '.cargo'),
        RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(originalHome, '.rustup'),
        AGENTMONITOR_HOST: '127.0.0.1',
        AGENTMONITOR_RUST_PORT: String(port),
        AGENTMONITOR_RUST_DB_PATH: path.join(tempHome, 'agentmonitor-rs.db'),
        AGENTMONITOR_AUTO_IMPORT_MINUTES: '1',
        AGENTMONITOR_STATS_INTERVAL: '60000',
        AGENTMONITOR_ENABLE_LIVE_TAB: 'true',
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

  if (tempHome) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('rust runtime auto-import populates the Live tab through the v2 live stream', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto(`${baseUrl}/app/#live`);

  await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
  await expect(page.getByText('connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Prompts on')).toBeVisible();

  const sessionButton = page.getByRole('button').filter({ hasText: 'NeedleRustLive auto import' }).first();
  await expect(sessionButton).toBeVisible({ timeout: 12000 });
  await sessionButton.click();

  await expect(page.getByText('Rust live answer', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Inspecting live parity', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
