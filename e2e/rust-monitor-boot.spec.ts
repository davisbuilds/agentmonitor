import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';
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
      // Retry until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Rust server did not become healthy within ${timeoutMs}ms.\n${rustLogs}`);
}

test.beforeAll(async () => {
  const builtIndex = path.join(process.cwd(), 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('frontend/dist/index.html is missing. Run `pnpm build` before Playwright tests.');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-rust-e2e-'));
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
        AGENTMONITOR_RUST_DB_PATH: path.join(tempDir, 'agentmonitor-rs.db'),
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

  const response = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'rust-phase1-monitor-smoke',
      agent_type: 'codex',
      event_type: 'response',
      status: 'success',
      tokens_in: 42,
      tokens_out: 7,
      cost_usd: 0.25,
      project: 'rust-phase1-project',
      branch: 'arch/rust-runtime-convergence',
      metadata: { content_preview: 'Rust monitor boot smoke' },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to seed Rust monitor smoke event: ${response.status}\n${await response.text()}\n${rustLogs}`);
  }
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

test('rust runtime serves the Svelte app and boots the Monitor tab', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto(`${baseUrl}/app/`);

  await expect(page.getByText('AgentMonitor')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active Agents' })).toBeVisible();
  await expect(page.locator('button').filter({ hasText: 'rust-phase1-project' }).first()).toBeVisible();
  await expect(page.getByText('Rust monitor boot smoke')).toBeVisible();
  await expect(
    page.locator('section').filter({ hasText: 'Cost Overview' }).getByText('$0.25')
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});
