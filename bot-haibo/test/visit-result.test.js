const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const helpers = require('../visit-result');

let browser;
before(async () => { browser = await puppeteer.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

async function fixture(html, { status = 200, abort = false, mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const setup = async page => {
    await page.setRequestInterception(true);
    page.on('request', request => {
      const target = new URL(request.url()).hostname === 'target.test';
      if (target && abort) return request.abort();
      return request.respond({ status: target ? status : 200, contentType: 'text/html; charset=utf-8',
        body: target ? '<h1>Target</h1>' : html });
    });
  };
  const page = await context.newPage();
  await setup(page);
  await page.setViewport({ width: 800, height: 600, isMobile: mobile, hasTouch: mobile });
  await page.goto('https://search.test/');
  return { context, page, setup };
}

test('domain validation rejects URL substring matches and supports subdomains/IDN', () => {
  assert.equal(helpers.matchesTarget('https://target.test.evil.test/', 'target.test'), false);
  assert.equal(helpers.matchesTarget('https://search.test/?url=https://target.test', 'target.test'), false);
  assert.equal(helpers.matchesTarget('https://target.test@evil.test/', 'target.test'), false);
  assert.equal(helpers.matchesTarget('https://shop.target.test/', 'target.test'), true);
  assert.equal(helpers.matchesTarget('https://xn--e1afmkfd.xn--p1ai/', 'пример.рф'), true);
});

test('mobile click scrolls offscreen link into view and confirms same-tab arrival', async () => {
  const f = await fixture('<div style="height:1800px"></div><a href="https://target.test/">Target</a>', { mobile: true });
  try {
    const outcome = await helpers.followSearchLink(f.page, await f.page.$('a'), 'target.test', 'mobile', { timeoutMs: 1500 });
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.source, 'search');
    assert.equal(outcome.result.reason, 'same-tab-click');
  } finally { await f.context.close(); }
});

test('mobile click waits for an overlay released after scrolling before tapping the link', async () => {
  const f = await fixture(`<meta name="viewport" content="width=device-width,initial-scale=1">
    <a href="https://target.test/" style="display:block;padding:30px">Target</a>
    <div id="cover" style="position:fixed;inset:0;background:white"></div>
    <script>document.querySelector('a').scrollIntoView = () => {
      setTimeout(() => document.querySelector('#cover').remove(), 250);
    };</script>`, { mobile: true });
  try {
    const outcome = await helpers.followSearchLink(f.page, await f.page.$('a'), 'target.test', 'mobile', { timeoutMs: 1500 });
    assert.equal(outcome.result.source, 'search');
    assert.equal(outcome.result.reason, 'same-tab-click');
  } finally { await f.context.close(); }
});

test('permanently covered search link is not clicked or credited as an arrival', async () => {
  const f = await fixture('<a href="https://target.test/">Target</a><div style="position:fixed;inset:0"></div>');
  try {
    const outcome = await helpers.followSearchLink(f.page, await f.page.$('a'), 'target.test', 'desktop', { timeoutMs: 250 });
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.reason, 'link-covered-or-moving');
    assert.equal(f.page.url(), 'https://search.test/');
  } finally { await f.context.close(); }
});

test('waits for a popup delayed redirect, without mistaking an existing target tab for the click', async () => {
  const f = await fixture(`<a href="#" onclick="const p=window.open('about:blank'); setTimeout(()=>p.location='https://target.test/', 350); return false">Target</a>`);
  try {
    const old = await f.context.newPage();
    await f.setup(old);
    await old.goto('https://target.test/');
    const setupPopups = async target => {
      if (target.opener() === f.page.target()) {
        const popup = await target.page();
        if (popup) await f.setup(popup);
      }
    };
    browser.on('targetcreated', setupPopups);
    try {
      const outcome = await helpers.followSearchLink(f.page, await f.page.$('a'), 'target.test', 'desktop', { timeoutMs: 2500 });
      assert.equal(outcome.result.source, 'search');
      assert.equal(outcome.result.reason, 'new-tab-click');
      assert.notEqual(outcome.page, old);
    } finally { browser.off('targetcreated', setupPopups); }
  } finally { await f.context.close(); }
});

test('prevented click is a failure even with a pre-existing target tab', async () => {
  const f = await fixture('<a href="https://target.test/" onclick="return false">Target</a>');
  try {
    const old = await f.context.newPage();
    await f.setup(old);
    await old.goto('https://target.test/');
    const outcome = await helpers.followSearchLink(f.page, await f.page.$('a'), 'target.test', 'desktop', { timeoutMs: 250 });
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.source, 'none');
  } finally { await f.context.close(); }
});

// Exercise the actual CLI functions without importing its auto-running main(),
// credentials or solver. Timing and unrelated site browsing are stubbed only.
function loadVisitFlow(failTarget = false, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
  const find = source.slice(source.indexOf('async function findAndVisitTarget('), source.indexOf('async function visitSite('));
  const run = source.slice(source.indexOf('async function runSearchAndVisit('), source.indexOf('function buildDomains('));
  return vm.runInNewContext(`${find}\n${run}\n({findAndVisitTarget, runSearchAndVisit})`, {
    ...helpers, ...require('../search-pagination'), URL, console: { log() {} }, redactSensitive: value => value,
    followSearchLink: (...args) => helpers.followSearchLink(...args, { timeoutMs: 250 }),
    buildDomains: domain => [domain], sleep: async () => {}, rand: min => min,
    humanActivity: async () => {}, scrollToBottom: async () => {},
    humanizePage: async () => {}, authenticateIfNeeded: async () => {},
    visitSite: async () => {}, isCaptchaPage: () => false,
    gotoWithRetry: (page, url) => {
      if (failTarget && helpers.matchesTarget(url, 'target.test')) throw new Error('fixture navigation failure');
      return page.goto(url);
    },
    searchViaForm: async () => true,
    ...overrides,
  });
}

test('blocked click followed by direct navigation is reported DIRECT', async () => {
  const f = await fixture('<div class="serp-item"><a href="https://target.test/" onclick="return false">Target</a></div>');
  try {
    f.page.screenshot = async () => {};
    const result = await loadVisitFlow().findAndVisitTarget(f.page, 'target.test');
    assert.equal(result.ok, true);
    assert.equal(result.source, 'direct');
    assert.equal(result.reason, 'click-target-not-reached');
    assert.match(helpers.formatVisitSummary({ ...result, query: 'query' }), /^DIRECT \|/);
  } finally { await f.context.close(); }
});

test('search flow skips a hidden duplicate and clicks the visible result', async () => {
  const f = await fixture('<div class="serp-item"><a style="display:none" href="https://target.test/hidden">Hidden</a><a href="https://target.test/visible">Target</a></div>');
  try {
    f.page.screenshot = async () => {};
    const result = await loadVisitFlow().findAndVisitTarget(f.page, 'target.test');
    assert.equal(result.ok, true);
    assert.equal(result.source, 'search');
    assert.equal(f.page.url(), 'https://target.test/visible');
  } finally { await f.context.close(); }
});

test('text-only URL is a direct visit, not a search click', async () => {
  const f = await fixture('<div class="serp-item">https://target.test/</div>');
  try {
    f.page.screenshot = async () => {};
    const result = await loadVisitFlow().findAndVisitTarget(f.page, 'target.test');
    assert.equal(result.source, 'direct');
    assert.equal(result.reason, 'text-url-only');
  } finally { await f.context.close(); }
});

test('failed direct navigation is FAIL and never browses an unrelated page', async () => {
  const f = await fixture('<div class="serp-item">https://target.test/</div>', { abort: true });
  try {
    const result = await loadVisitFlow().findAndVisitTarget(f.page, 'target.test');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'direct-navigation-failed');
    assert.match(helpers.formatVisitSummary({ ...result, query: 'query' }), /^FAIL \|/);
  } finally { await f.context.close(); }
});

test('target HTTP error is not counted as a successful visit', async () => {
  const f = await fixture('<div class="serp-item">https://target.test/</div>', { status: 503 });
  try {
    const result = await loadVisitFlow().findAndVisitTarget(f.page, 'target.test');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'target-http-error');
  } finally { await f.context.close(); }
});

test('no target in scanned results plus failing direct fallback returns FAIL from query flow', async () => {
  const f = await fixture('<div class="serp-item">Other result</div>', { abort: true });
  try {
    const fakeBrowser = { newPage: async () => f.page };
    const result = await loadVisitFlow(true, {
      searchViaForm: async page => { await page.goto('https://ya.ru/search/?text=query'); return true; },
    }).runSearchAndVisit(fakeBrowser, {}, 'query', 'target.test');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'direct-navigation-failed');
  } finally { await f.context.close(); }
});

async function localPopupFixture({ slow = false } = {}) {
  let targetUrl;
  const server = require('node:http').createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/source')) {
      res.end(`<meta name="viewport" content="width=device-width,initial-scale=1">
        <div class="serp-item"><a target="_blank" rel="noopener" href="${targetUrl}">Target</a></div>`);
    } else if (req.url.startsWith('/slow')) {
      res.write('<h1>Still loading</h1>');
      const timer = setTimeout(() => res.end('<p>Loaded</p>'), 1200);
      res.on('close', () => clearTimeout(timer));
    } else res.end('<h1>Target</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  targetUrl = `http://127.0.0.1:${port}/${slow ? 'slow' : 'target'}?ysclid=fixture`;
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  page.screenshot = async () => {};
  await page.goto(`http://localhost:${port}/source`);
  return { page, context, targetUrl, close: async () => {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  } };
}

test('timed-out search popup is closed before direct browsing, existing tabs survive and internal popups remain usable', async () => {
  const f = await localPopupFixture({ slow: true });
  const listeners = browser.listenerCount('targetcreated');
  try {
    const existing = await f.context.newPage();
    await existing.goto(f.targetUrl.replace('/slow', '/existing'));
    let browsed = false;
    const flow = loadVisitFlow(false, {
      visitSite: async page => {
        browsed = true;
        assert.equal(page, f.page);
        assert.equal((await f.context.pages()).length, 2, 'only working page and unrelated existing tab');
        assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
        // Search-click cleanup must not close legitimate internal browsing tabs.
        const popupEvent = new Promise(resolve => page.once('popup', resolve));
        await page.evaluate(() => window.open('/internal'));
        const internal = await popupEvent;
        await internal.waitForFunction(() => document.readyState !== 'loading');
        assert.equal(internal.isClosed(), false);
        await internal.close();
      },
    });
    const result = await flow.findAndVisitTarget(f.page, '127.0.0.1', 'mobile');
    assert.equal(result.source, 'direct');
    assert.equal(result.reason, 'click-target-not-reached');
    assert.equal(browsed, true);
    assert.equal(existing.isClosed(), false);
    assert.equal((await f.context.pages()).length, 2);
    assert.equal(browser.listenerCount('targetcreated'), listeners);
  } finally { await f.close(); }
});

test('successful noopener search popup is configured and foregrounded, then closed after browsing', async () => {
  const f = await localPopupFixture();
  const listeners = browser.listenerCount('targetcreated');
  try {
    let configured;
    let browsed;
    const flow = loadVisitFlow(false, {
      followSearchLink: (...args) => helpers.followSearchLink(...args, { timeoutMs: 2000 }),
      humanizePage: async page => {
        configured = page;
        await page.setViewport(f.page.viewport());
        page.screenshot = async () => {};
      },
      visitSite: async page => {
        browsed = page;
        assert.notEqual(page, f.page);
        assert.equal(configured, page);
        assert.equal(page.viewport().isMobile, true);
        assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
        assert.equal((await f.context.pages()).length, 2, 'search tab and single target tab');
      },
    });
    const result = await flow.findAndVisitTarget(f.page, '127.0.0.1', 'mobile');
    assert.equal(result.source, 'search');
    assert.equal(result.reason, 'new-tab-click');
    assert.ok(browsed);
    assert.equal(browsed.isClosed(), true);
    assert.equal((await f.context.pages()).length, 1);
    assert.equal(browser.listenerCount('targetcreated'), listeners);
  } finally { await f.close(); }
});
