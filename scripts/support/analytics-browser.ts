import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { z } from 'zod';

const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.hostname.endsWith('.apps.localhost') &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
export async function visitAnalyticsSite(input: { siteUrl: string; analyticsUrl: string }) {
  const site = new URL(originSchema.parse(input.siteUrl));
  const analytics = new URL(originSchema.parse(input.analyticsUrl));
  assert.equal(site.port, analytics.port);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    timeout: 20000,
  });
  try {
    // Deliberate test visitor: retain the actual browser version while excluding its bot-only UA marker.
    const probe = await browser.newPage();
    const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace(
      'HeadlessChrome',
      'Chrome',
    );
    await probe.close();
    const context = await browser.newContext({ userAgent, ignoreHTTPSErrors: true });
    const allowed = new Set([site.origin, analytics.origin]);
    await context.route('**/*', async (route) => {
      if (allowed.has(new URL(route.request().url()).origin)) await route.continue();
      else await route.abort();
    });
    const page = await context.newPage();
    const observed: { path: string; status: number }[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname === '/script.js' || url.pathname === '/api/send')
        observed.push({ path: url.pathname, status: response.status() });
    });
    await page.goto(site.href, { waitUntil: 'networkidle', timeout: 20000 });
    const before = await page.locator('#counter').innerText();
    assert.match(before, /Persisted visits: 1/);
    const posted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/send' &&
        response.request().method() === 'POST' &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: 'Record a visit', exact: true }).click();
    await posted;
    await page.waitForFunction(() =>
      document.querySelector('#counter')?.textContent.includes('Persisted visits: 2'),
    );
    assert.ok(
      observed.some((response) => response.path === '/script.js' && response.status === 200),
    );
    assert.ok(
      observed.filter((response) => response.path === '/api/send' && response.status === 200)
        .length >= 2,
    );
    return {
      browser: browser.version(),
      counter: await page.locator('#counter').innerText(),
      requests: observed,
      certificateException: 'fresh context restricted to two local fixture origins',
    };
  } finally {
    await browser.close();
  }
}
