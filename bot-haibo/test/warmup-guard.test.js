const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runBoundedWarmVisit, closeBrowserBounded } = require('../warmup-guard');

const never = () => new Promise(() => {});
const limits = { timeoutMs: 50, closeTimeoutMs: 20 };
function fakePage({ close = async () => {}, cdp = async () => ({ success: true }) } = {}) {
  return { close, isClosed: () => false, target: () => ({ createCDPSession: async () => ({
    send: async method => method === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'fixture' } } : cdp(),
    detach: async () => {},
  }) }) };
}

test('navigation error plus stalled page.close uses CDP and allows the next site', async () => {
  let cdpClosed = 0;
  let opened = 0;
  const first = fakePage({ close: never, cdp: async () => { cdpClosed++; return { success: true }; } });
  const browser = { newPage: async () => opened++ === 0 ? first : fakePage() };
  assert.equal(await runBoundedWarmVisit(browser, async () => { throw new Error('net::ERR_TIMED_OUT'); }, limits), false);
  assert.equal(cdpClosed, 1);
  assert.equal(await runBoundedWarmVisit(browser, async () => true, limits), true);
  assert.equal(opened, 2);
});

test('hanging navigation/scroll/setup steps are bounded and report their stage', async () => {
  for (const stage of ['navigation', 'scroll', 'page-setup']) {
    const messages = [];
    const result = await runBoundedWarmVisit({ newPage: async () => fakePage() },
      async (page, step) => step(stage, never), { ...limits, log: text => messages.push(text) });
    assert.equal(result, false);
    assert.match(messages.join('\n'), new RegExp(stage));
  }
});

test('late navigation cannot resume clicks after the deadline', async () => {
  let finish;
  let clicks = 0;
  const result = await runBoundedWarmVisit({ newPage: async () => fakePage() }, async (page, step) => {
    await step('navigation', () => new Promise(resolve => { finish = resolve; }));
    await step('click', async () => { clicks++; });
  }, limits);
  assert.equal(result, false);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 0);
});

test('failed normal and CDP close restart browser instead of silently continuing', async () => {
  let restarted = false;
  const page = fakePage({ close: never, cdp: never });
  const browser = { newPage: async () => page, close: async () => { restarted = true; } };
  await assert.rejects(runBoundedWarmVisit(browser, async () => true, limits), /session must restart/);
  assert.equal(restarted, true);
});

test('newPage timeout restarts browser; late page is cleaned without running visit', async () => {
  let finish;
  let visited = false;
  let closed = 0;
  let browserClosed = false;
  const browser = { newPage: () => new Promise(resolve => { finish = resolve; }), close: async () => { browserClosed = true; } };
  await assert.rejects(runBoundedWarmVisit(browser, async () => { visited = true; }, limits), /could not be created/);
  finish(fakePage({ close: async () => { closed++; } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browserClosed, true);
  assert.equal(visited, false);
  assert.equal(closed, 1);
});

test('stalled browser.close kills only the owned process and waits for exit', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let signal;
  child.kill = sent => { signal = sent; setImmediate(() => { child.signalCode = sent; child.emit('exit'); }); };
  await closeBrowserBounded({ close: never, process: () => child }, 20);
  assert.equal(signal, 'SIGKILL');
});

test('actual warm-up loop advances after a timed-out/uncleanly closed first site', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
  const visit = source.slice(source.indexOf('async function warmVisitPage('), source.indexOf('function warmEnabled('));
  const warm = source.slice(source.indexOf('async function warmUpProfile('), source.indexOf('async function launchBrowserSession('));
  let opened = 0;
  let cleanups = 0;
  const started = [];
  const first = fakePage({ close: never, cdp: async () => { cleanups++; return { success: true }; } });
  const second = { ...fakePage(), url: () => 'https://fixture.test/ok', evaluate: async () => null };
  const browser = { newPage: async () => opened++ === 0 ? first : second };
  const warmUp = vm.runInNewContext(`${visit}\n${warm}\nwarmUpProfile`, {
    process: { env: {} }, console: { log() {} }, path,
    fs: { writeFileSync() {} }, runSearchAndVisit: {},
    runBoundedWarmVisit: (browser, work, options) => runBoundedWarmVisit(browser, work, { ...options, ...limits }),
    humanizePage: async () => {}, authenticateIfNeeded: async () => {},
    limitWarmupTraffic: async () => {},
    gotoWithRetry: async (page, url, options, attempts) => {
      started.push(url); assert.equal(attempts, 1);
      if (page === first) throw new Error('net::ERR_TIMED_OUT');
      return { ok: () => true };
    },
    sleep: async () => {}, rand: min => min, humanActivity: async () => {}, scrollToBottom: async () => {},
    isCaptchaPage: () => false, redactSensitive: text => text,
    warmEnabled: () => true, shuffleArray: values => values,
    WARM_NEUTRAL_SITES: ['https://fixture.test/bad', 'https://fixture.test/ok'], warmSiteCount: () => 2,
    readWarmHistory: () => [], appendWarmHistory() {},
  });
  const result = await warmUp(browser, {}, 'mobile', '/fixture', 1);
  assert.deepEqual(started, ['https://fixture.test/bad', 'https://fixture.test/ok']);
  assert.equal(result.visited, 1);
  assert.equal(cleanups, 1);
});
