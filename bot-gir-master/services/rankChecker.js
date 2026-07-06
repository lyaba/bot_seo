const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { startProxyBridge } = require('./proxyBridge');

puppeteer.use(StealthPlugin());

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeDomain(value) {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function proxyArgs(proxyUrl) {
  if (!proxyUrl) return [];
  return [`--proxy-server=${proxyUrl}`];
}

async function acceptGoogleConsent(page) {
  const labels = [
    'принять все',
    'принимаю',
    'accept all',
    'i agree'
  ];

  try {
    const buttons = await page.$$('button, input[type="submit"]');
    for (const button of buttons) {
      const text = await page.evaluate((el) => {
        return (el.innerText || el.value || '').trim().toLowerCase();
      }, button);

      if (labels.some(label => text.includes(label))) {
        await button.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await sleep(1000);
        return;
      }
    }
  } catch (e) {
    console.log('Google consent пропущен:', e.message);
  }
}

async function saveGoogleDebug(page, reason) {
  const dir = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });

  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const file = path.join(dir, `google-${safeReason}-${Date.now()}.png`);

  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`Google debug screenshot: ${file}`);
  return file;
}

async function isGoogleBlockedPage(page) {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return location.pathname.includes('/sorry') ||
      text.includes('unusual traffic') ||
      text.includes('подозрительный трафик') ||
      text.includes('не робот');
  });
}

async function waitForManualGoogleVerification(page, google) {
  console.log('Google verification is open. Solve it manually in the browser window.');
  console.log('After verification is solved, the script will continue automatically.');

  const startedAt = Date.now();
  const timeout = google.manualVerificationTimeoutMinutes * 60 * 1000;

  while (Date.now() - startedAt < timeout) {
    await sleep(3000);

    let blocked = true;

    try {
      blocked = await isGoogleBlockedPage(page);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context with specified id') ||
        message.includes('Navigating frame was detached')
      ) {
        await sleep(2000);
        continue;
      }

      throw error;
    }

    if (!blocked) {
      await sleep(1500);
      return;
    }
  }

  const error = new Error(`Google verification was not solved within ${google.manualVerificationTimeoutMinutes} minutes`);
  error.code = 'GOOGLE_BLOCKED';
  throw error;
}

async function extractOrganicResults(page) {
  if (await isGoogleBlockedPage(page)) {
    await saveGoogleDebug(page, 'blocked');
    const error = new Error('Google returned anti-bot verification page');
    error.code = 'GOOGLE_BLOCKED';
    throw error;
  }

  return page.evaluate(() => {
    function cleanGoogleUrl(rawHref) {
      try {
        const parsed = new URL(rawHref, window.location.href);

        if (parsed.pathname === '/url' && parsed.searchParams.get('q')) {
          return parsed.searchParams.get('q');
        }

        return parsed.href;
      } catch {
        return rawHref;
      }
    }

    function isGoogleServiceUrl(url) {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        return host === 'google.com' ||
          host.endsWith('.google.com') ||
          host === 'gstatic.com' ||
          host.endsWith('.gstatic.com');
      } catch {
        return true;
      }
    }

    const seen = new Set();
    const results = [];
    const anchors = Array.from(document.querySelectorAll('a[href]'));

    for (const anchor of anchors) {
      const href = cleanGoogleUrl(anchor.getAttribute('href'));
      if (!href || !/^https?:\/\//i.test(href) || isGoogleServiceUrl(href)) continue;

      const titleNode = anchor.querySelector('h3') || anchor.closest('div')?.querySelector('h3');
      const title = (titleNode?.innerText || anchor.innerText || '').trim();
      if (!title || seen.has(href)) continue;

      seen.add(href);
      results.push({ title, url: href });
    }

    return results;
  });
}

async function searchFromGoogleHome(page, keyword, google) {
  console.log(`Google home: ${keyword}`);

  await page.goto('https://www.google.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await acceptGoogleConsent(page);

  const inputSelector = 'textarea[name="q"], input[name="q"]';
  await page.waitForSelector(inputSelector, { timeout: 30000 });
  await sleep(1000);

  await page.click(inputSelector, { delay: 80 });
  await page.keyboard.type(keyword, { delay: 80 });
  await sleep(600);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.keyboard.press('Enter')
  ]);

  await sleep(2000);
}

async function clickMatchingResult(page, target) {
  const links = await page.$$('a[href]');

  for (const link of links) {
    const data = await page.evaluate((anchor) => {
      function cleanGoogleUrl(rawHref) {
        try {
          const parsed = new URL(rawHref, window.location.href);
          if (parsed.pathname === '/url' && parsed.searchParams.get('q')) {
            return parsed.searchParams.get('q');
          }
          return parsed.href;
        } catch {
          return rawHref;
        }
      }

      const href = cleanGoogleUrl(anchor.getAttribute('href'));
      const titleNode = anchor.querySelector('h3') || anchor.closest('div')?.querySelector('h3');

      return {
        href,
        title: (titleNode?.innerText || anchor.innerText || '').trim()
      };
    }, link);

    if (!data.href || !/^https?:\/\//i.test(data.href)) continue;

    const host = normalizeDomain(data.href);
    if (host !== target && !host.endsWith(`.${target}`)) continue;

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      link.click({ delay: 120 })
    ]);

    await sleep(2000);

    return {
      url: data.href,
      title: data.title,
      finalUrl: page.url()
    };
  }

  return null;
}

async function goNextPage(page) {
  const nextSelectors = [
    'a#pnnext',
    'a[aria-label="Следующая"]',
    'a[aria-label="Next"]'
  ];

  for (const selector of nextSelectors) {
    const next = await page.$(selector);
    if (!next) continue;

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      next.click({ delay: 100 })
    ]);

    await sleep(2000);
    return true;
  }

  const clicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const next = links.find(link => {
      const text = (link.innerText || '').trim().toLowerCase();
      return text === 'следующая' || text === 'next';
    });

    if (!next) return false;
    next.click();
    return true;
  });

  if (!clicked) return false;

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2000);
  return true;
}

async function checkPosition(keyword, domain, proxy, options = {}) {
  const google = {
    ...config.google,
    ...options
  };
  const stopAfterResults = options.stopAfterResults || null;
  const shouldClickResult = options.clickResult !== false;

  const bridge = proxy && proxy.username ? await startProxyBridge(proxy) : null;
  const proxyUrl = bridge
    ? bridge.url
    : proxy && proxy.host && proxy.port
      ? `http://${proxy.host}:${proxy.port}`
      : null;

  const browser = await puppeteer.launch({
    headless: google.headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      ...proxyArgs(proxyUrl)
    ]
  });

  const target = normalizeDomain(domain);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': `${google.language}-${google.country.toUpperCase()},${google.language};q=0.9,en;q=0.8`
    });

    await searchFromGoogleHome(page, keyword, google);

    for (let pageIndex = 0; pageIndex < google.maxPages; pageIndex++) {
      const start = pageIndex * google.resultsPerPage;
      console.log(`Google results page ${pageIndex + 1}: ${keyword}`);

      let results;

      try {
        results = await extractOrganicResults(page);
      } catch (error) {
        if (error.code !== 'GOOGLE_BLOCKED' || !google.waitForManualVerification) {
          throw error;
        }

        await waitForManualGoogleVerification(page, google);
        results = await extractOrganicResults(page);
      }

      console.log(`Найдено результатов на странице: ${results.length}`);

      const limit = stopAfterResults
        ? Math.min(results.length, stopAfterResults - start)
        : results.length;

      for (let index = 0; index < limit; index++) {
        const result = results[index];
        const resultHost = normalizeDomain(result.url);

        if (resultHost === target || resultHost.endsWith(`.${target}`)) {
          const clicked = shouldClickResult ? await clickMatchingResult(page, target) : null;

          return {
            keyword,
            domain,
            position: start + index + 1,
            page: pageIndex + 1,
            url: clicked?.url || result.url,
            title: clicked?.title || result.title,
            finalUrl: clicked?.finalUrl || null,
            clicked: Boolean(clicked)
          };
        }
      }

      if (stopAfterResults && start + limit >= stopAfterResults) break;

      if (pageIndex < google.maxPages - 1) {
        const hasNext = await goNextPage(page);
        if (!hasNext) break;
      }
    }

    return {
      keyword,
      domain,
      position: null,
      page: null,
      url: null,
      title: null
    };
  } finally {
    if (google.keepBrowserOpen) {
      console.log('Browser left open because KEEP_BROWSER_OPEN=true');
    } else {
      await browser.close();
    }
    if (bridge && !google.keepBrowserOpen) await bridge.close();
  }
}

module.exports = { checkPosition };
