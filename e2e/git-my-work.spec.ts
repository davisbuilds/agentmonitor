import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { useIsolatedDb } from './isolated-db.js';

test('Git defaults to personal commits and can show all contributors', async ({ page }) => {
  const tempDir = await useIsolatedDb('agentmonitor-e2e-git-my-work-');
  const { config } = await import('../src/config.js');
  const { getDb, closeDb } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { createApp } = await import('../src/app.js');
  const previousProjectsDir = config.projectsDir;
  const previousAuthorEmails = config.git.authorEmails;
  const stack = new AsyncDisposableStack();
  stack.defer(() => {
    config.projectsDir = previousProjectsDir;
    config.git.authorEmails = previousAuthorEmails;
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  try {
    const repo = path.join(tempDir, 'my-repo');
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'config', '--local', 'user.email', 'me@example.com']);
    config.projectsDir = repo;
    config.git.authorEmails = undefined;
    initSchema();
    const insert = getDb().prepare(`INSERT INTO git_commits
      (repo_root, sha, authored_at, committed_at, author_email)
      VALUES (?, ?, '2026-09-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z', ?)`);
    insert.run(repo, '1111111', 'ME@example.com');
    insert.run(path.join(tempDir, 'reference-clone'), '2222222', 'contributor@example.com');

    const startApp = async () => {
      const server = createApp().listen(0, '127.0.0.1');
      stack.defer(() => new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }));
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
      return `http://127.0.0.1:${address.port}`;
    };
    const baseUrl = await startApp();

    await page.goto(`${baseUrl}/app/#analytics?view=git&from=2026-09-10&to=2026-09-10`);
    const chart = page.getByRole('region', { name: 'Commits', exact: true });
    const projects = page.getByRole('region', { name: 'By Agent and Project' });
    const day = chart.getByRole('button', { name: /^2026-09-10:/ });
    await expect(chart.getByRole('button', { name: 'My work' })).toHaveAttribute('aria-pressed', 'true');
    await expect(day).toHaveAccessibleName('2026-09-10: 1 outside a session');
    await expect(projects.getByRole('button', { name: 'my-repo' })).toBeVisible();
    await expect(projects.getByRole('button', { name: 'reference-clone' })).toHaveCount(0);

    await chart.getByRole('button', { name: 'All contributors' }).click();
    await expect(day).toHaveAccessibleName('2026-09-10: 2 outside a session');
    await expect(projects.getByRole('button', { name: 'reference-clone' })).toBeVisible();

    await chart.getByRole('button', { name: 'My work' }).click();
    await expect(day).toHaveAccessibleName('2026-09-10: 1 outside a session');
    await expect(projects.getByRole('button', { name: 'reference-clone' })).toHaveCount(0);

    const api = '/api/v2/analytics/git-activity?date_from=2026-09-10&date_to=2026-09-10';
    config.git.authorEmails = ['CONTRIBUTOR@example.com'];
    const overrideUrl = await startApp();
    const override = await page.request.get(`${overrideUrl}${api}&commit_scope=mine`);
    expect(override.ok()).toBe(true);
    expect(await override.json()).toMatchObject({
      author_identity_configured: true,
      projects: [{ project: 'reference-clone', commits: 1 }],
    });
    const original = await page.request.get(`${baseUrl}${api}&commit_scope=mine`);
    expect(original.ok()).toBe(true);
    expect(await original.json()).toMatchObject({ projects: [{ project: 'my-repo', commits: 1 }] });

    const invalid = await page.request.get(`${baseUrl}${api}&commit_scope=other`);
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).code).toBe('invalid_query');
  } finally {
    await stack.disposeAsync();
  }
});
