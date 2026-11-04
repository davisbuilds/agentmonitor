// CVE-2026-76024 is fixed in Chrome 156.0.8078.79. Playwright 1.64.1's
// bundled Chromium is older; never silently fall back to that executable.
const minimumVersion = [156, 0, 8078, 79];
function assertPatchedVersion(version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Cannot verify Chrome version: ${version}`);
  }
  const parts = version.split('.').map(Number);
  const comparison = parts.map((part, index) => Math.sign(part - minimumVersion[index])).find(value => value !== 0) ?? 0;
  if (comparison < 0) throw new Error(`Chrome ${version} is affected by CVE-2026-76024; install Chrome >= 156.0.8078.79.`);
}

const browserUse = {
  channel: 'chrome',
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH || undefined,
    chromiumSandbox: process.platform === 'darwin',
  },
};

async function launchPatchedChromium(options = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ ...options, channel: browserUse.channel, ...browserUse.launchOptions });
  try {
    assertPatchedVersion(browser.version());
    return browser;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function checkBrowser() {
  const browser = await launchPatchedChromium();
  try { console.log(`Verified Chrome ${browser.version()} (CVE-2026-76024 floor)`); }
  finally { await browser.close(); }
}

module.exports = checkBrowser;
module.exports.assertPatchedVersion = assertPatchedVersion;
module.exports.browserUse = browserUse;
module.exports.launchPatchedChromium = launchPatchedChromium;
