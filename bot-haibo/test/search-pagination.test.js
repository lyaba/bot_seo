const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const pagination = require('../search-pagination');

const base = 'https://ya.ru/search/touch?text=fixture&lr=43';
let browser;
before(async () => { browser = await puppeteer.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

test('pages 2 through 7 use p=1 through p=6 and preserve query/region/path', () => {
  for (let n = 2; n <= 7; n++) {
    const url = new URL(pagination.resultsPageUrl(base + '&page=9&p=0#bottom', n));
    assert.equal(url.searchParams.get('p'), String(n - 1));
    assert.equal(url.searchParams.has('page'), false);
    assert.equal(url.searchParams.get('text'), 'fixture');
    assert.equal(url.searchParams.get('lr'), '43');
    assert.equal(url.pathname, '/search/touch');
    assert.equal(url.hash, '');
  }
  assert.throws(() => pagination.resultsPageUrl('https://ya.ru/showcaptcha?key=fixture', 2));
});

async function fixture(mode = 'normal', mobile = false) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: mobile ? 390 : 1280, height: 800, isMobile: mobile, hasTouch: mobile });
  const requested = [];
  let challenged = false;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const index = Number(url.searchParams.get('p') || 0);
    if (request.isNavigationRequest()) requested.push(url.href);
    if (mode === 'network-error' && index > 0) return request.abort();
    if (mode === 'http-error' && index > 0) return request.respond({ status: 503, body: 'Unavailable' });
    if (mode === 'redirect-first' && index > 0) return request.respond({ status: 302, headers: { location: base } });
    if ((mode === 'captcha' || mode === 'captcha-403') && index > 0 && !challenged) {
      challenged = true;
      return request.respond({ status: 302, headers: { location: 'https://ya.ru/showcaptcha' } });
    }
    const body = url.pathname === '/showcaptcha' ? '<form id="checkbox-captcha-form">Challenge fixture</form>' :
      `<div class="serp-item"><a href="https://result.test/${mode === 'repeat' ? 0 : index}">Result ${mode === 'repeat' ? 0 : index}</a></div>`;
    return request.respond({ status: mode === 'captcha-403' && url.pathname === '/showcaptcha' ? 403 : 200, contentType: 'text/html; charset=utf-8', body });
  });
  await page.goto(base);
  return { context, page, requested };
}

async function openSecond(f, overrides = {}) {
  const first = await pagination.readSearchPage(f.page);
  return pagination.openResultsPage(f.page, base, 2, {
    seen: new Set([first.signature]),
    navigate: (page, url) => page.goto(url),
    solveCaptcha: async () => true,
    ...overrides,
  });
}

test('desktop and mobile confirm actual second-page results', async () => {
  for (const mobile of [false, true]) {
    const f = await fixture('normal', mobile);
    try {
      const result = await openSecond(f);
      assert.equal(result.ok, true);
      assert.match(result.state.signature, /result.test\/1/);
      assert.equal(new URL(result.state.url).searchParams.get('p'), '1');
    } finally { await f.context.close(); }
  }
});

test('unchanged results are rejected even if URL contains requested p', async () => {
  const f = await fixture('repeat');
  try {
    assert.equal((await openSecond(f)).reason, 'pagination-repeated-results');
  } finally { await f.context.close(); }
});

test('redirect to first page retries only once and is never confirmed', async () => {
  const f = await fixture('redirect-first');
  try {
    assert.equal((await openSecond(f)).reason, 'pagination-page-mismatch');
    assert.equal(f.requested.filter(url => new URL(url).searchParams.has('p')).length, 2);
  } finally { await f.context.close(); }
});

test('network and HTTP failures cannot count as a next page', async () => {
  for (const mode of ['network-error', 'http-error']) {
    const f = await fixture(mode);
    try {
      const result = await openSecond(f);
      assert.equal(result.ok, false);
      assert.equal(result.reason, mode === 'http-error' ? 'pagination-http-error' : 'pagination-navigation-failed');
    } finally { await f.context.close(); }
  }
});

test('CAPTCHA redirect restores exact requested page from original search URL', async () => {
 for (const mode of ['captcha', 'captcha-403']) {
  const f = await fixture(mode);
  try {
    const result = await openSecond(f, {
      solveCaptcha: async page => {
        if (page.url().includes('/showcaptcha')) await page.goto(base + '&p=0');
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(new URL(result.state.url).searchParams.get('p'), '1');
    assert.equal(f.requested.filter(url => new URL(url).searchParams.get('p') === '1').length, 2);
  } finally { await f.context.close(); }
 }
});

test('uncleared CAPTCHA and wrong query cannot be confirmed as requested page', async () => {
  const f = await fixture('captcha');
  try {
    assert.equal((await openSecond(f, { solveCaptcha: async () => false })).reason, 'pagination-captcha');
    const wrongQuery = { url: base.replace('fixture', 'different') + '&p=1', signature: 'other results', ready: 'complete' };
    assert.equal(pagination.confirmedSearchPage(wrongQuery, 2, 'fixture'), false);
    assert.equal(pagination.confirmedSearchPage({ ...wrongQuery, url: base + '&p=2' }, 2, 'fixture'), false);
  } finally { await f.context.close(); }
});

const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
const runCode = source.slice(source.indexOf('async function runSearchAndVisit('), source.indexOf('function buildDomains('));
function loadFlow(f, scans, logs, overrides = {}) {
  return vm.runInNewContext(runCode + ';runSearchAndVisit', {
    ...pagination, URL, console: { log: (...args) => logs.push(args.join(' ')) },
    sleep: async () => {}, rand: min => min, humanizePage: async () => {},
    authenticateIfNeeded: async () => {}, humanActivity: async () => {}, scrollToBottom: async () => {},
    searchViaForm: async page => { await page.goto(base); return true; },
    gotoWithRetry: (page, url) => page.goto(url), isCaptchaPage: url => url.includes('/showcaptcha'),
    findAndVisitTarget: async page => { scans.push(page.url()); return null; },
    arrivalResult: async () => ({ ok: false, reason: 'fixture-direct-stop' }),
    failedVisit: reason => ({ ok: false, reason }),
    ...overrides,
  });
}

test('actual query flow scans seven different pages in order', async () => {
  const f = await fixture();
  const scans = [], logs = [];
  try {
    await loadFlow(f, scans, logs)({ newPage: async () => f.page }, {}, 'fixture', 'target.test');
    assert.deepEqual(scans.map(url => Number(new URL(url).searchParams.get('p') || 0)), [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(logs.some(line => line.includes('7 confirmed results pages')));
  } finally { await f.context.close(); }
});

test('actual query flow never rescans first page or claims seven pages after failure', async () => {
  for (const mode of ['repeat', 'redirect-first', 'network-error']) {
    const f = await fixture(mode);
    const scans = [], logs = [];
    try {
      await loadFlow(f, scans, logs)({ newPage: async () => f.page }, {}, 'fixture', 'target.test');
      assert.equal(scans.length, 1);
      assert.ok(logs.some(line => line.includes('1 confirmed results pages')));
      assert.ok(logs.some(line => line.includes('Stopping pagination')));
    } finally { await f.context.close(); }
  }
});
