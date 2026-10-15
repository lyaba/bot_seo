const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { searchViaForm } = require('../search-input');

let browser;
before(async () => {
  browser = await puppeteer.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); });

async function fixture(html, mobile = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, isMobile: mobile, hasTouch: mobile });
  await page.setRequestInterception(true);
  // Every request is answered locally; no search engine, proxy or solver runs.
  page.on('request', request => request.respond({
    contentType: 'text/html; charset=utf-8',
    body: request.url().includes('/search?') ? '<div class="serp-item">Result</div>' : html,
  }));
  await page.goto('https://search.test/');
  return page;
}

test('mobile: skips hidden/readonly fields, resolves #text wrapper and taps own submit', async () => {
  const page = await fixture(`
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <form action="/wrong"><button type="submit">Unrelated submit</button></form>
    <input name="text" style="display:none"><input name="text" readonly>
    <form action="/search"><div id="text"><textarea name="text">old query</textarea></div>
      <button type="submit">Search</button></form>
    <script>
      document.querySelector('textarea').addEventListener('touchstart', () => sessionStorage.setItem('tap', 'yes'));
      document.querySelector('textarea').addEventListener('input', e => sessionStorage.setItem('typed', e.target.value));
    </script>`, true);
  try {
    assert.equal(await searchViaForm(page, 'роллы', 'mobile'), true);
    assert.equal(new URL(page.url()).pathname, '/search');
    assert.equal(new URL(page.url()).searchParams.get('text'), 'роллы');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('tap')), 'yes');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('typed')), 'роллы');
  } finally { await page.close(); }
});

test('desktop: clears stale text and submits with Enter when no button exists', async () => {
  const page = await fixture('<form action="/search"><input name="text" value="stale text"></form>');
  try {
    assert.equal(await searchViaForm(page, 'test'), true);
    assert.equal(new URL(page.url()).searchParams.get('text'), 'test');
  } finally { await page.close(); }
});

test('focus redirected to another input: does not type or erase that input', async () => {
  const page = await fixture(`<input id="other" value="keep">
    <form action="/search"><input name="text" onfocus="document.getElementById('other').focus()"></form>`);
  try {
    assert.equal(await searchViaForm(page, 'test'), false);
    assert.equal(await page.$eval('#other', el => el.value), 'keep');
    assert.equal(await page.$eval('[name=text]', el => el.value), '');
  } finally { await page.close(); }
});

test('rejects a partial query even if its first eight characters match', async () => {
  const page = await fixture('<form action="/search"><input name="text" maxlength="8"></form>');
  try {
    assert.equal(await searchViaForm(page, '123456789'), false);
    assert.equal(new URL(page.url()).pathname, '/');
  } finally { await page.close(); }
});

test('focus lost during typing: stops before more keys reach another field', async () => {
  const page = await fixture(`<input id="other" value="keep">
    <form action="/search"><input name="text" oninput="if(this.value) document.getElementById('other').focus()"></form>`);
  try {
    assert.equal(await searchViaForm(page, 'test'), false);
    assert.equal(await page.$eval('#other', el => el.value), 'keep');
    assert.equal(new URL(page.url()).pathname, '/');
  } finally { await page.close(); }
});

test('reports a submit with no response as failure', async () => {
  const page = await fixture('<form onsubmit="event.preventDefault()"><input name="text"><button>Search</button></form>');
  try {
    assert.equal(await searchViaForm(page, 'test'), false);
    assert.equal(new URL(page.url()).pathname, '/');
  } finally { await page.close(); }
});
