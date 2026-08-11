import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env['AGENTMONITOR_E2E_URL'];
const artifactDir = path.join(process.cwd(), 'output', 'playwright');
const claudeProject = `cwd:${createHash('sha256').update('/work/alpha').digest('hex')}`;

test.skip(!baseUrl, 'AGENTMONITOR_E2E_URL is provided by the built-runtime verifier');

test('Analytics keeps consultation overview bounded and provides a filterable explorer', async ({
  page,
}) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.goto(`${baseUrl}/app/#analytics?from=2026-07-01&to=2026-07-29`);

  const preview = page.getByRole('region', { name: 'Skill consultations' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('details')).toHaveCount(0);
  await expect(preview.getByTestId('skill-preview-row')).toHaveCount(6);
  await expect(preview.getByRole('link', { name: /Explore all 37 skills/ })).toBeVisible();

  await preview.screenshot({
    path: path.join(artifactDir, 'skill-consultations-preview-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await preview.screenshot({
    path: path.join(artifactDir, 'skill-consultations-preview-narrow.png'),
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await preview.getByRole('link', { name: /Explore all 37 skills/ }).click();
  await expect(page).toHaveURL(/#analytics\?.*view=skills/);

  const region = page.getByRole('region', { name: 'Skill consultation explorer' });
  await expect(region).toBeVisible();
  const comparability = region.getByTestId('skill-comparability');
  await expect(comparability).toContainText('Rates are not pooled across harnesses.');

  const claude = region.locator('section[aria-labelledby="skill-harness-claude"]');
  const codex = region.locator('section[aria-labelledby="skill-harness-codex"]');
  await expect(claude.getByRole('heading', { name: 'Claude' })).toBeVisible();
  await expect(codex.getByRole('heading', { name: 'Codex' })).toBeVisible();
  for (const harnessName of await region.locator('section h4').allTextContents()) {
    await expect(comparability).toContainText(harnessName.trim());
  }

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

  await region.getByRole('button', { name: 'Codex' }).click();
  await expect(codex).toBeVisible();
  await expect(claude).toHaveCount(0);

  await region.getByLabel('Search skills').fill('does-not-exist');
  await expect(page).toHaveURL(/skill=does-not-exist/);
  await expect(region.getByText('No skills match the explorer filters.')).toBeVisible();
  await region.getByRole('button', { name: 'Reset explorer filters' }).click();
  await expect(page).not.toHaveURL(/skill=/);
  await expect(claude).toBeVisible();
  await expect(codex).toBeVisible();
  await expect(region.locator('details')).toHaveCount(30);
  await region.getByRole('button', { name: 'Show 7 more' }).click();
  await expect(region.locator('details')).toHaveCount(37);

  await region.screenshot({
    path: path.join(artifactDir, 'skill-consultations-explorer-desktop.png'),
  });

  await page.getByLabel('Filter by agent').selectOption('claude');
  await expect(region.locator('details')).toHaveCount(30);
  await expect(region.getByRole('button', { name: 'Show 6 more' })).toBeVisible();

  await page.getByLabel('Filter by agent').selectOption('codex');
  await expect(codex).toBeVisible();
  await expect(claude).toHaveCount(0);
  await expect(region.getByTestId('skill-comparability')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await region.screenshot({
    path: path.join(artifactDir, 'skill-consultations-explorer-narrow.png'),
  });
});

test('Skills preserves a deep-linked harness while consultation data loads', async ({
  page,
}) => {
  await page.goto(
    `${baseUrl}/app/#analytics?view=skills&from=2026-07-01&to=2026-07-29&harness=codex`,
  );

  const region = page.getByRole('region', { name: 'Skill consultation explorer' });
  await expect(region).toBeVisible();
  await expect(page).toHaveURL(/harness=codex/);
  await expect(region.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true');
  await expect(region.locator('section[aria-labelledby="skill-harness-codex"]')).toBeVisible();
  await expect(region.locator('section[aria-labelledby="skill-harness-claude"]')).toHaveCount(0);
});
