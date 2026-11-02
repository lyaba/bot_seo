const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const state = require('../captcha-state');

let browser;
before(async () => { browser = await puppeteer.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

const search = '<textarea name="text" id="text"></textarea><div class="serp-item">Result</div>';
const challenge = `<form id="checkbox-captcha-form" action="/checkcaptcha">
  <button type="button" id="js-button" class="CheckboxCaptcha-Button" onclick="location.replace('/search/touch?text=fixture')">Continue</button></form>`;
async function fixture(initial = '/showcaptcha', body = challenge) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => request.respond({ contentType: 'text/html; charset=utf-8',
    body: new URL(request.url()).pathname.startsWith('/search') ? search : body }));
  await page.goto('https://ya.ru' + initial);
  return { page, context };
}

const source = fs.readFileSync(path.join(__dirname, '../yandex_search_visit.js'), 'utf8');
const solveCode = source.slice(source.indexOf('async function solveCaptcha(page,'), source.indexOf('// Yandex search accepts'));
const checkboxCode = source.slice(source.indexOf('async function tryClickCaptchaCheckbox('), source.indexOf('\n/**', source.indexOf('async function tryClickCaptchaCheckbox(')));
const pythonCode = source.slice(source.indexOf('async function solveCaptchaWithPython('), source.indexOf('async function getCaptchaSiteKey('));
function loadFlow(overrides = {}) {
  return vm.runInNewContext(`${checkboxCode}\n${solveCode}\n${pythonCode}\n({ solveCaptcha, tryClickCaptchaCheckbox, solveCaptchaWithPython })`, {
    ...state, console: { log() {} }, path, __dirname: '/fixture', process: { env: {} },
    fs: { existsSync: () => true }, sleep: async () => {}, rand: min => min,
    captchaCleared: (page, stage) => state.captchaCleared(page, stage, { log() {}, timeoutMs: 1500, pollMs: 20 }),
    isCaptchaPage: url => /showcaptcha|checkcaptcha/.test(url),
    solveCaptchaLocally: async () => { throw new Error('Local solver must not run'); },
    getCaptchaImageBase64: async () => null,
    getCaptchaSiteKey: async () => 'public-fixture-sitekey',
    runPythonProcess: async () => { throw new Error('Python must not start'); },
    applyCaptchaToken: async () => { throw new Error('No token should be applied to search results'); },
    extractPythonJson: output => JSON.parse(output),
    redactSensitive: value => value,
    SOLVER_TRANSPORT_ERRORS: /fixture-transport-only/,
    SOLVER_TERMINAL_RETRY_ERRORS: /fixture-terminal-only/,
    ...overrides,
  });
}

test('classifier distinguishes search, active challenge and unknown/error documents', () => {
  const loaded = { ready: 'complete', hasBody: true };
  assert.equal(state.classifyCaptchaDocument({ ...loaded, url: 'https://ya.ru/search/touch?text=robot', results: true }), 'clear');
  assert.equal(state.classifyCaptchaDocument({ ...loaded, url: 'https://ya.ru/search/touch', results: true, challenge: true }), 'captcha');
  assert.equal(state.classifyCaptchaDocument({ ...loaded, url: 'https://ya.ru/showcaptcha' }), 'captcha');
  assert.equal(state.classifyCaptchaDocument({ ...loaded, url: 'chrome-error://chromewebdata/' }), 'unknown');
  assert.equal(state.classifyCaptchaDocument({ ...loaded, ready: 'loading', url: 'https://ya.ru/search/touch', results: true }), 'unknown');
  assert.equal(state.classifyCaptchaDocument({ ...loaded, url: 'https://ya.ru/search/touch' }), 'unknown');
});

test('destroyed execution context is retried until the search document can be inspected', async () => {
  let calls = 0;
  const page = { isClosed: () => false, evaluate: async () => {
    if (++calls === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.');
    return { url: 'https://ya.ru/search/touch', ready: 'complete', results: true };
  } };
  assert.equal(await state.captchaCleared(page, 'fixture', { timeoutMs: 200, pollMs: 1, log() {} }), true);
  assert.equal(calls, 2);
});

test('unknown state never grants permission to run a solver', async () => {
  const page = { isClosed: () => false, evaluate: async () => ({ url: 'about:blank', ready: 'complete' }) };
  await assert.rejects(state.captchaCleared(page, 'fixture', { timeoutMs: 20, pollMs: 1, log() {} }), /solver not started/);
});

test('actual checkbox navigation returns to search without Python or local solving', async () => {
  const f = await fixture();
  try {
    const result = await loadFlow().solveCaptcha(f.page, {}, 'desktop');
    assert.equal(result, true);
    assert.equal(new URL(f.page.url()).pathname, '/search/touch');
  } finally { await f.context.close(); }
});

test('checkbox execution-context error followed by redirect is recovered', async () => {
  const f = await fixture();
  try {
    const realDollar = f.page.$.bind(f.page);
    let intercepted = false;
    f.page.$ = async selector => {
      if (!intercepted) {
        intercepted = true;
        await f.page.goto('https://ya.ru/search/touch');
        throw new Error('Execution context was destroyed, most likely because of a navigation.');
      }
      return realDollar(selector);
    };
    assert.equal(await loadFlow().solveCaptcha(f.page, {}, 'desktop'), true);
  } finally { await f.context.close(); }
});

test('Python wrapper skips both preflight and paid task on ordinary search results', async () => {
  const f = await fixture('/search/touch');
  try {
    assert.equal(await loadFlow().solveCaptchaWithPython(f.page, {}), state.CAPTCHA_ALREADY_CLEARED);
  } finally { await f.context.close(); }
});

test('redirect during free preflight prevents creation of a solver task', async () => {
  const f = await fixture();
  let preflights = 0;
  let paidAttempts = 0;
  try {
    const flow = loadFlow({ process: { env: { HAIBO_PYTHON: '/fixture/.venv/bin/python' } }, runPythonProcess: async (python, args) => {
      assert.equal(python, '/fixture/.venv/bin/python');
      if (args.includes('--self-test')) {
        preflights++;
        await f.page.goto('https://ya.ru/search/touch');
        return { code: 0, stdout: JSON.stringify({ status: 'ok', python: 'fixture', requests: 'fixture' }) };
      }
      paidAttempts++;
      throw new Error('Paid task must not start');
    } });
    assert.equal(await flow.solveCaptchaWithPython(f.page, {}), state.CAPTCHA_ALREADY_CLEARED);
    assert.equal(preflights, 1);
    assert.equal(paidAttempts, 0);
  } finally { await f.context.close(); }
});

test('redirect after local attempt stops before Python fallback', async () => {
  // No checkbox: exercise the local fallback branch without solving anything.
  const f = await fixture('/showcaptcha', '<form id="checkbox-captcha-form" action="/checkcaptcha">Challenge</form>');
  try {
    const flow = loadFlow({ solveCaptchaLocally: async page => {
      await page.goto('https://ya.ru/search/touch');
      return false;
    } });
    assert.equal(await flow.solveCaptcha(f.page, {}), true);
  } finally { await f.context.close(); }
});

test('genuine visible challenge is not marked cleared, even with a search URL', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => history.replaceState({}, '', '/search/touch'));
    assert.equal(await state.captchaCleared(f.page, 'fixture', { log() {} }), false);
  } finally { await f.context.close(); }
});

test('navigation during DOM challenge inspection continues search without solving', async () => {
  const f = await fixture('/showcaptcha', '<form id="checkbox-captcha-form">Challenge</form>');
  try {
    const evaluate = f.page.evaluate.bind(f.page);
    f.page.evaluate = async (fn, ...args) => {
      if (String(fn).includes('const powNames')) {
        await f.page.goto('https://ya.ru/search/touch');
        throw new Error('Execution context was destroyed, most likely because of a navigation.');
      }
      return evaluate(fn, ...args);
    };
    assert.equal(await loadFlow().solveCaptcha(f.page, {}), true);
  } finally { await f.context.close(); }
});

test('results reached during a failed solver attempt prevent another task/retry', async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    const flow = loadFlow({ runPythonProcess: async (python, args) => {
      if (args.includes('--self-test')) return { code: 0, stdout: JSON.stringify({ status: 'ok' }) };
      attempts++;
      await f.page.goto('https://ya.ru/search/touch');
      return { code: 1, stdout: JSON.stringify({ status: 'error', error: 'fixture solver failure' }) };
    } });
    assert.equal(await flow.solveCaptchaWithPython(f.page, {}, 3), state.CAPTCHA_ALREADY_CLEARED);
    assert.equal(attempts, 1);
  } finally { await f.context.close(); }
});
