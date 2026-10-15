const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { openIpProfileSession } = require('../ip-profile');

test('Chromium persists localStorage for a returning IP and isolates another IP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haibo-ip-browser-test-'));
  let active;
  const open = ip => openIpProfileSession({
    root, projectName: 'fixture', device: 'mobile', initialIp: ip, log() {},
    launch: dir => puppeteer.launch({ headless: true, userDataDir: dir }),
    checkIp: async () => ip,
    warm: async (browser, dir) => {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', request => request.respond({ contentType: 'text/html', body: '<h1>Local fixture</h1>' }));
      await page.goto('https://profile.test/');
      fs.writeFileSync(path.join(dir, '.warmed'), 'fixture-only warm marker');
      return { visited: 1 };
    },
  });
  const profilePage = async session => (await session.browser.pages()).find(page => page.url() === 'https://profile.test/');
  try {
    active = await open('192.0.2.1');
    let page = await profilePage(active);
    await page.evaluate(() => localStorage.setItem('fixture-history', 'profile A'));
    await active.browser.close();
    active = await open('192.0.2.2');
    page = await profilePage(active);
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture-history')), null);
    await page.evaluate(() => localStorage.setItem('fixture-history', 'profile B'));
    await active.browser.close();
    active = await open('192.0.2.1');
    page = await profilePage(active);
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture-history')), 'profile A');
  } finally {
    if (active) await active.browser.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
