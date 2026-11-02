const { test } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { runBoundedWarmVisit } = require('../warmup-guard');

test('real Chromium: stalled navigation and stalled close do not block the next warm-up page', async () => {
  const browser = await puppeteer.launch({ headless: true });
  let created = 0;
  const realNewPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await realNewPage();
    await page.setRequestInterception(true);
    if (++created === 1) {
      page.on('request', () => {}); // deliberately leave local fixture request pending
      page.close = () => new Promise(() => {}); // emulate the reported cleanup stall
    } else {
      page.on('request', request => request.respond({ contentType: 'text/html', body: '<h1>OK</h1>' }));
    }
    return page;
  };
  const visit = (page, step) => step('navigation', async () => {
    await page.goto('https://warmup-fixture.test/', { timeout: 0 });
    return true;
  });
  try {
    const first = await runBoundedWarmVisit(browser, visit, { timeoutMs: 1000, closeTimeoutMs: 500 });
    assert.equal(first, false);
    const second = await runBoundedWarmVisit(browser, visit, { timeoutMs: 3000, closeTimeoutMs: 500 });
    assert.equal(second, true);
    assert.equal(created, 2);
  } finally { await browser.close(); }
});
