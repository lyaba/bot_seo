const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { startProxyBridge } = require('./proxyBridge');

function proxyArgs(proxyUrl) {
  if (!proxyUrl) return [];
  return [`--proxy-server=${proxyUrl}`];
}

async function checkSite(targetUrl, proxy) {
  const url = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
  const bridge = proxy && proxy.username ? await startProxyBridge(proxy) : null;
  const proxyUrl = bridge
    ? bridge.url
    : proxy && proxy.host && proxy.port
      ? `http://${proxy.host}:${proxy.port}`
      : null;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...proxyArgs(proxyUrl)
    ]
  });

  try {
    const page = await browser.newPage();

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const status = response ? response.status() : null;
    const title = await page.title().catch(() => '');
    const screenshot = path.join(
      __dirname,
      '..',
      'screenshots',
      `gir-master-${Date.now()}.png`
    );

    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});

    return {
      ok: Boolean(status && status >= 200 && status < 400),
      status,
      finalUrl: page.url(),
      title,
      screenshot
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      finalUrl: url,
      title: '',
      error: e.message
    };
  } finally {
    await browser.close();
    if (bridge) await bridge.close();
  }
}

module.exports = { checkSite };
