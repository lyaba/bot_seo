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
function loadVisitFlow(failTarget = false) {
  const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
  const find = source.slice(source.indexOf('async function findAndVisitTarget('), source.indexOf('async function visitSite('));
  const run = source.slice(source.indexOf('async function runSearchAndVisit('), source.indexOf('function buildDomains('));
  return vm.runInNewContext(`${find}\n${run}\n({findAndVisitTarget, runSearchAndVisit})`, {
    ...helpers, URL, console: { log() {} },
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
    const result = await loadVisitFlow(true).runSearchAndVisit(fakeBrowser, {}, 'query', 'target.test');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'direct-navigation-failed');
  } finally { await f.context.close(); }
});
