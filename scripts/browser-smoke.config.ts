import config from '../playwright.config';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Exercise the real project/browser/globalSetup wiring without app or DB state.
export default defineConfig({
  ...config,
  testDir: '.',
  testMatch: 'browser-runtime.spec.ts',
  webServer: undefined,
  globalSetup: path.resolve('scripts/browser-runtime.cjs'),
  projects: config.projects?.filter(project => project.name === 'chromium'),
  retries: 0,
  reporter: 'list',
});
