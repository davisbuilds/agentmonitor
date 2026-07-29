import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env['AGENTMONITOR_E2E_URL'];
const artifactDir = path.join(process.cwd(), 'output', 'playwright');
const claudeProject = `cwd:${createHash('sha256').update('/work/alpha').digest('hex')}`;

test.skip(!baseUrl, 'AGENTMONITOR_E2E_URL is provided by the built-runtime verifier');

test('Analytics renders per-harness consultation evidence and filter-responsive detail', async ({
  page,
}) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.goto(`${baseUrl}/app/#analytics`);

  const region = page.getByRole('region', { name: 'Skill consultations' });
  await expect(region).toBeVisible();
  await expect(
    region.getByText(
      'Claude and Codex are shown separately because their detection semantics differ.',
    ),
  ).toBeVisible();

  const claude = region.locator('section[aria-labelledby="skill-harness-claude"]');
  const codex = region.locator('section[aria-labelledby="skill-harness-codex"]');
  await expect(claude.getByRole('heading', { name: 'Claude' })).toBeVisible();
  await expect(codex.getByRole('heading', { name: 'Codex' })).toBeVisible();

  const claudeSkill = claude.locator('details').filter({ hasText: 'test-strategy' });
  const codexSkill = codex.locator('details').filter({ hasText: 'test-strategy' });
  await expect(claudeSkill).toContainText('1 / 1');
  await expect(claudeSkill).toContainText('100% first read');
  await expect(claudeSkill).toContainText(/1\s+rehydrations/);
  await expect(claudeSkill).toContainText(/1 · 0\s+repeat · unknown/);
  await expect(claudeSkill).toContainText('presentation unavailable');
  await expect(codexSkill).toContainText('1 / 1');
  await expect(codexSkill).toContainText(/0 \/ 1\s+presented, no first read/);

  const claudeSummary = claudeSkill.locator('summary');
  await claudeSummary.focus();
  await claudeSummary.press('Enter');
  await expect(claudeSkill.getByRole('heading', { name: 'Version attribution' })).toBeVisible();
  await expect(claudeSkill.getByText('1.0.0')).toBeVisible();
  await expect(claudeSkill.getByText('exact')).toBeVisible();
  await expect(claudeSkill.getByText(claudeProject)).toBeVisible();

  await region.screenshot({
    path: path.join(artifactDir, 'skill-consultations-desktop.png'),
  });

  await page.getByLabel('Filter by agent').selectOption('codex');
  await expect(codex).toBeVisible();
  await expect(claude).toHaveCount(0);
  await expect(
    region.getByText(
      'Claude and Codex are shown separately because their detection semantics differ.',
    ),
  ).toHaveCount(0);

  await page.getByLabel('Filter by agent').selectOption('');
  await expect(claude).toBeVisible();
  await expect(codex).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await region.screenshot({
    path: path.join(artifactDir, 'skill-consultations-narrow.png'),
  });
});
