import { test, expect } from '@playwright/test';
import { assertPatchedVersion } from './browser-runtime.cjs';

test('configured browser is patched and handles an isolated DOM interaction', async ({ browser, page }) => {
  assertPatchedVersion(browser.version());
  await page.setContent('<button onclick="this.textContent=\'verified\'">check</button>');
  await page.getByRole('button', { name: 'check', exact: true }).click();
  await expect(page.getByRole('button', { name: 'verified', exact: true })).toBeVisible();
});
