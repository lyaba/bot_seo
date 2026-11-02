const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');
const { limitWarmupTraffic } = require('../warmup-traffic');

test('warm-up blocks media and fetch-based video downloads while ordinary resources and other pages work', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push(request.url);
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Fixture</title>OK');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage();
    await limitWarmupTraffic(page);
    await page.goto(origin);
    const results = await page.evaluate(async () => {
      const paths = ['/clip.mp4?token=fixture', '/playlist.m3u8', '/audio.mp3', '/style.css', '/image.png', '/script.js'];
      return Promise.all(paths.map(async path => {
        try { return (await fetch(path)).ok; } catch { return false; }
      }));
    });
    assert.deepEqual(results, [false, false, false, true, true, true]);
    const failedMedia = new Promise(resolve => {
      page.on('requestfailed', request => {
        if (request.url().endsWith('/stream')) resolve(request.resourceType());
      });
    });
    await page.evaluate(() => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.src = '/stream';
      document.body.append(video);
      video.load();
    });
    assert.equal(await failedMedia, 'media');
    assert.ok(!received.some(path => /clip|playlist|audio|stream/.test(path)));
    const targetPage = await browser.newPage();
    assert.equal((await targetPage.goto(origin + '/clip.mp4')).ok(), true);
    assert.ok(received.includes('/clip.mp4'));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('warm-up blocks Dzen, Kinopoisk and Rythm subdomains without sending requests', async () => {
  let handler;
  const page = { setRequestInterception: async () => {}, on: (event, callback) => { handler = callback; } };
  await limitWarmupTraffic(page);
  for (const url of ['https://dzen.ru/', 'https://www.kinopoisk.ru/lists/pick/', 'https://cdn.dzen.ru/video', 'https://rythm.yandex.ru/businesses/', 'https://cdn.rythm.yandex.ru/stream', 'https://yandex.ru/rythm/businesses/@demiand.ru?utm_source=yaru_morda_touch', 'https://www.yandex.ru/rythm/']) {
    let aborted = false;
    handler({ isInterceptResolutionHandled: () => false, resourceType: () => 'document', url: () => url,
      abort: async () => { aborted = true; }, continue: async () => assert.fail('Blocked host was allowed') });
    assert.equal(aborted, true);
  }
});
