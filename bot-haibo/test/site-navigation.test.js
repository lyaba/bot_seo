const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const navigation = require('../site-navigation');

let browser;
before(async () => { browser = await puppeteer.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:0;min-height:3500px} a{display:inline-block;padding:20px}
  .ui-modal{position:fixed;inset:0;background:white;z-index:100} li{padding:30px;cursor:pointer}</style>
  <a href="/kazan/offers" style="display:none">Hidden duplicate</a>
  <a href="/kazan/offers" onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('h1').textContent='Offers'">Offers</a>
  <a href="/kazan/feedback" onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('h1').textContent='Feedback'">Feedback</a>
  <a href="/?ysclid=fixture">Tracking home</a><a href="/cart">Cart</a><a href="https://elsewhere.test/">External</a>
  <h1>Menu</h1>
  <div class="ui-modal"><h2>Здравствуйте! Выберите способ получения</h2>
    <li class="delivery-method__item" onclick="this.closest('.ui-modal').remove()">Самовывоз</li></div>`;

async function fixture(body = html, mobile = true) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: mobile, hasTouch: mobile });
  await page.setRequestInterception(true);
  page.on('request', request => request.respond({ contentType: 'text/html; charset=utf-8', body }));
  await page.goto('https://imperator-kzn.ru/');
  return { page, context };
}

test('mobile: modal blocks links until pickup is selected, then SPA route opens', async () => {
  const f = await fixture();
  try {
    const href = 'https://imperator-kzn.ru/kazan/offers';
    const blocked = await navigation.openInternalLink(f.page, href, 'imperator-kzn.ru', 'mobile');
    assert.equal(blocked.ok, false);
    assert.equal(await navigation.prepareSiteBrowsing(f.page, 'imperator-kzn.ru', 'mobile'), 'pickup-selected');
    const opened = await navigation.openInternalLink(f.page, href, 'imperator-kzn.ru', 'mobile');
    assert.equal(opened.ok, true);
    assert.equal(new URL(opened.url).pathname, '/kazan/offers');
    assert.equal(await f.page.$eval('h1', el => el.textContent), 'Offers');
  } finally { await f.context.close(); }
});

test('visible candidates exclude hidden duplicates, tracking self-links, cart and external URLs', async () => {
  const f = await fixture();
  try {
    const links = await navigation.collectVisibleInternalLinks(f.page, 'imperator-kzn.ru', []);
    assert.deepEqual(links.map(link => new URL(link.href).pathname), ['/kazan/offers', '/kazan/feedback']);
    const remaining = await navigation.collectVisibleInternalLinks(f.page, 'imperator-kzn.ru', ['https://imperator-kzn.ru/kazan/offers?ysclid=old']);
    assert.deepEqual(remaining.map(link => new URL(link.href).pathname), ['/kazan/feedback']);
  } finally { await f.context.close(); }
});

test('mobile FoodSoul delivery-choice buttons support uppercase text and hidden old dialogs', async () => {
  const f = await fixture(`<div class="ui-modal" style="display:none">Old dialog</div>
    <div class="delivery-choice" style="position:fixed;inset:0;background:white;z-index:5">
      <h2>Выберите способ получения</h2>
      <button onclick="this.closest('.delivery-choice').remove()">САМОВЫВОЗ</button>
    </div>`);
  try {
    assert.equal(await navigation.prepareSiteBrowsing(f.page, 'imperator-kzn.ru', 'mobile'), 'pickup-selected');
    assert.equal(await navigation.prepareSiteBrowsing(f.page, 'imperator-kzn.ru', 'mobile'), 'not-needed');
  } finally { await f.context.close(); }
});

test('mobile cookie sheet above delivery choice is acknowledged before selecting pickup', async () => {
  const f = await fixture(`<div class="delivery-choice" style="position:fixed;inset:0;background:white;z-index:5">
      <h2>Выберите способ получения</h2><button onclick="this.closest('.delivery-choice').remove()">Самовывоз</button></div>
    <div class="bottom-sheet" style="position:fixed;inset:0;background:white;z-index:100">
      <p class="cookie-notification">Мы используем cookies</p>
      <button onclick="this.closest('.bottom-sheet').remove()">ХОРОШО</button></div>`);
  try {
    assert.equal(await navigation.prepareSiteBrowsing(f.page, 'imperator-kzn.ru', 'mobile'), 'pickup-selected');
    assert.equal(await f.page.$('.cookie-notification'), null);
    assert.equal(await f.page.$('.delivery-choice'), null);
  } finally { await f.context.close(); }
});

test('unrecognized dialog is not dismissed or clicked', async () => {
  const f = await fixture('<div class="ui-modal">Подтвердите оплату<button>Продолжить</button></div>');
  try {
    assert.equal(await navigation.prepareSiteBrowsing(f.page, 'imperator-kzn.ru', 'mobile'), 'unrecognized-dialog');
    assert.equal(await f.page.$eval('.ui-modal', el => el.textContent.includes('оплату')), true);
  } finally { await f.context.close(); }
});

test('prevented click without a route change is not a confirmed navigation', async () => {
  const f = await fixture('<a href="/kazan/offers" onclick="return false">Offers</a>', false);
  try {
    const result = await navigation.openInternalLink(f.page, 'https://imperator-kzn.ru/kazan/offers', 'imperator-kzn.ru', 'desktop', { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-confirmed-navigation');
  } finally { await f.context.close(); }
});

test('a different same-domain route is not credited as the requested page', async () => {
  const f = await fixture('<a href="/kazan/offers" onclick="event.preventDefault();history.pushState({},\'\',\'/kazan/popular\')">Offers</a>', false);
  try {
    const result = await navigation.openInternalLink(f.page, 'https://imperator-kzn.ru/kazan/offers', 'imperator-kzn.ru', 'desktop', { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expected-route-not-reached');
  } finally { await f.context.close(); }
});

const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
const redactSensitive = vm.runInNewContext(source.slice(source.indexOf('function redactSensitive('), source.indexOf('function extractPythonJson(')) + ';redactSensitive');
function loadVisit(logs) {
  const code = source.slice(source.indexOf('async function visitSite('), source.indexOf('main().catch('));
  return vm.runInNewContext(code + ';visitSite', {
    ...navigation, redactSensitive, console: { log: line => logs.push(line) },
    buildDomains: domain => [domain], rand: min => min, sleep: async () => {},
    humanActivity: async () => {}, scrollToBottom: async () => {},
    collectInternalFallbackUrls: async () => [], tryOpenMobileMenu: async () => false,
    matchesTarget: require('../visit-result').matchesTarget,
  });
}

test('actual visitSite counts two opened routes and does not count blocked clicks', async () => {
  const f = await fixture();
  try {
    f.page.screenshot = async () => {};
    const logs = [];
    const result = await loadVisit(logs)(f.page, 'imperator-kzn.ru', 'mobile');
    assert.equal(result.confirmed, 2);
    assert.equal(result.clicks, 2);
    assert.equal(result.directOpens, 0);
    assert.equal(logs.filter(line => line.startsWith('  Confirmed internal page:')).length, 2);
  } finally { await f.context.close(); }
  const blocked = await fixture('<a href="/kazan/offers" onclick="return false">Offers</a>', false);
  try {
    blocked.page.screenshot = async () => {};
    const logs = [];
    // Use a shorter observation budget for this intentionally non-navigating fixture.
    const original = navigation.openInternalLink;
    const code = source.slice(source.indexOf('async function visitSite('), source.indexOf('main().catch('));
    const visit = vm.runInNewContext(code + ';visitSite', {
      ...navigation, openInternalLink: (...args) => original(...args, { timeoutMs: 100 }),
      console: { log: line => logs.push(line) }, buildDomains: domain => [domain], rand: min => min,
      sleep: async () => {}, humanActivity: async () => {}, scrollToBottom: async () => {},
      collectInternalFallbackUrls: async () => [], tryOpenMobileMenu: async () => false,
      matchesTarget: require('../visit-result').matchesTarget,
    });
    const result = await visit(blocked.page, 'imperator-kzn.ru', 'desktop');
    assert.equal(result.confirmed, 0);
    assert.equal(result.clicks, 0);
  } finally { await blocked.context.close(); }
});

test('actual mobile swipe API emits touch events and changes scroll position', async () => {
  const f = await fixture(html.replace(/<div class="ui-modal">[\s\S]*$/, ''), true);
  try {
    await f.page.evaluate(() => {
      window.fixtureTouches = 0;
      document.addEventListener('touchmove', () => { window.fixtureTouches++; }, { passive: true });
    });
    const code = source.slice(source.indexOf('async function touchSwipe('), source.indexOf('const TRANSIENT_NET_ERRORS'));
    const gestures = vm.runInNewContext(code + ';({touchSwipe,scrollToBottom})', {
      console, readScrollState: navigation.readScrollState, rand: min => min, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 40))),
    });
    await gestures.touchSwipe(f.page, 190, 700, 190, 250, 10);
    await f.page.waitForFunction(() => scrollY > 0);
    assert.ok(await f.page.evaluate(() => window.fixtureTouches > 0));
    assert.ok(await f.page.evaluate(() => scrollY > 0));
  } finally { await f.context.close(); }
});

test('ProtocolError during a swipe recovers native scrolling and leaves subsequent gestures usable', async () => {
  const f = await fixture('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{height:6000px}</style>');
  try {
    const logs = [];
    const code = source.slice(source.indexOf('async function touchSwipe('), source.indexOf('const TRANSIENT_NET_ERRORS'));
    const redactCode = source.slice(source.indexOf('function redactSensitive('), source.indexOf('function extractPythonJson('));
    const gestures = vm.runInNewContext(redactCode + code + ';({touchSwipe})', {
      console: { log: message => logs.push(message) }, rand: min => min,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 40))),
    });
    await f.page.evaluate(() => {
      window.moves = 0;
      document.addEventListener('touchmove', () => window.moves++, { passive: true });
    });
    const touchscreen = f.page.touchscreen;
    const start = touchscreen.touchStart.bind(touchscreen);
    let inject = true;
    touchscreen.touchStart = async (...args) => {
      const handle = await start(...args);
      if (inject) {
        inject = false;
        handle.move = async () => {
          const error = new Error('Input.dispatchTouchEvent fixture failure http://user:fixture-password@proxy.test');
          error.name = 'ProtocolError';
          throw error;
        };
      }
      return handle;
    };
    assert.equal(await gestures.touchSwipe(f.page, 190, 700, 190, 250, 10), true, logs.join('\n'));
    await f.page.waitForFunction(() => scrollY > 0);
    assert.ok(await f.page.evaluate(() => window.moves > 0));
    assert.ok(logs.some(line => line.includes('recovered')));
    assert.ok(logs.some(line => line.includes('touchMove') && line.includes('Input.dispatchTouchEvent')));
    assert.ok(logs.some(line => line.includes('[REDACTED]')));
    assert.ok(logs.every(line => !line.includes('fixture-password')));
    assert.equal(await gestures.touchSwipe(f.page, 190, 700, 190, 250, 10), true);
  } finally { await f.context.close(); }
});

test('unrecoverable touch input stops the scroll loop and reports the failed recovery stage', async () => {
  const logs = [];
  let starts = 0;
  let detached = false;
  const protocolError = () => Object.assign(new Error('fixture transport failure'), { name: 'ProtocolError' });
  const page = {
    viewport: () => ({ width: 390, height: 844 }), isClosed: () => false,
    touchscreen: { touchStart: async () => { starts++; throw protocolError(); } },
    createCDPSession: async () => ({ send: async () => { throw protocolError(); }, detach: async () => { detached = true; } }),
  };
  const code = source.slice(source.indexOf('async function touchSwipe('), source.indexOf('const TRANSIENT_NET_ERRORS'));
  const gestures = vm.runInNewContext(code + ';({scrollToBottom})', {
    console: { log: message => logs.push(message) }, redactSensitive: value => value,
    rand: min => min, sleep: async () => {},
  });
  await gestures.scrollToBottom(page, 'mobile');
  assert.equal(starts, 1);
  assert.equal(detached, true);
  assert.ok(logs.some(line => line.includes('recovery failed at touchCancel')));
  assert.ok(logs.some(line => line.includes('scrolling stopped')));
});

test('mobile reading scrolls an internal MAIN container while window scrollY stays zero', async () => {
  const f = await fixture('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;overflow:hidden}main{height:100vh;overflow-y:auto}article{height:6000px}</style><main><article>Menu</article></main>');
  try {
    const code = source.slice(source.indexOf('async function touchSwipe('), source.indexOf('const TRANSIENT_NET_ERRORS'));
    const gestures = vm.runInNewContext(code + ';({scrollToBottom})', {
      console, readScrollState: navigation.readScrollState, rand: min => min,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 80))),
    });
    await gestures.scrollToBottom(f.page, 'mobile');
    const state = await navigation.readScrollState(f.page);
    assert.ok(state.top > 0);
    assert.equal(await f.page.evaluate(() => scrollY), 0);
    assert.ok(state.max > 0);
  } finally { await f.context.close(); }
});

test('initialization leaves native maxTouchPoints readable', async () => {
  const f = await fixture();
  try {
    const code = source.slice(source.indexOf('function buildStealthInitScript('), source.indexOf('async function humanizePage('));
    const makeInit = vm.runInNewContext(code + ';buildStealthInitScript');
    await f.page.evaluate(makeInit());
    assert.equal(typeof await f.page.evaluate(() => navigator.maxTouchPoints), 'number');
    assert.ok(await f.page.evaluate(() => navigator.maxTouchPoints > 0));
  } finally { await f.context.close(); }
});

test('mobile internal noopener popup is confirmed and later source-tab taps still work', async () => {
  const server = require('node:http').createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<meta name="viewport" content="width=device-width,initial-scale=1">
      <a href="/privacy" target="_blank" rel="noopener">Privacy</a>
      <a href="/next" onclick="event.preventDefault();history.pushState({},'',this.href)">Next</a>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  try {
    await page.goto(origin);
    const result = await navigation.openInternalLink(page, origin + '/privacy', '127.0.0.1', 'mobile', { timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.notEqual(result.page, page);
    assert.equal(new URL(result.page.url()).pathname, '/privacy');
    const next = await navigation.openInternalLink(page, origin + '/next', '127.0.0.1', 'mobile', { timeoutMs: 1000 });
    assert.equal(next.ok, true);
    await result.page.close();
    await page.goto(origin);
    page.screenshot = async () => {};
    const logs = [];
    const visit = await loadVisit(logs)(page, '127.0.0.1', 'mobile');
    assert.equal(visit.confirmed, 2);
    assert.equal((await context.pages()).length, 1, 'visited popups are closed');

    // A background page that already has the expected URL must not be credited.
    const unrelated = await context.newPage();
    await unrelated.goto(origin + '/privacy');
    await page.goto(origin);
    await page.$eval('a', el => el.onclick = event => { event.preventDefault(); window.open('/wrong'); });
    const wrong = await navigation.openInternalLink(page, origin + '/privacy', '127.0.0.1', 'mobile', { timeoutMs: 300 });
    assert.equal(wrong.ok, false);
    assert.equal(unrelated.isClosed(), false);
    assert.equal((await context.pages()).length, 2, 'unconfirmed popup is closed, unrelated tab remains');
    await unrelated.close();

    await page.goto(origin);
    await page.setViewport({ width: 1000, height: 800, isMobile: false, hasTouch: false });
    const desktop = await navigation.openInternalLink(page, origin + '/privacy', '127.0.0.1', 'desktop', { timeoutMs: 2000 });
    assert.equal(desktop.ok, true);
    await desktop.page.close();

    await page.goto(origin);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    page.touchscreen.tap = async () => { throw Object.assign(new Error('Input.dispatchTouchEvent fixture http://user:fixture-secret@proxy.test'), { name: 'ProtocolError' }); };
    const failures = [];
    const failedVisit = await loadVisit(failures)(page, '127.0.0.1', 'mobile');
    assert.equal(failedVisit.confirmed, 0);
    assert.ok(failures.some(line => line.includes('ProtocolError') && line.includes('Input.dispatchTouchEvent') && line.includes('[REDACTED]')));
    assert.ok(failures.every(line => !line.includes('fixture-secret')));

  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
});
