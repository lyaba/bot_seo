const { Worker } = require('bullmq');

//  ВАЖНО: используем puppeteer-extra
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// включаем антидетект
puppeteer.use(StealthPlugin());

const { checkPosition } = require('../services/rankChecker');
const { buildFingerprint } = require('../services/fingerprint/generator');
const { applyFingerprint } = require('../services/fingerprint/applyFingerprint');
const { simulateBehavior } = require('../services/fingerprint/behavior');
const proxies = require('../proxies');

// Allowed job names
const ALLOWED_JOB_NAMES = new Set(['rank-check', 'visit']);

let shuttingDown = false;

function getPrimaryProxy() {
  const proxy = proxies && proxies[0];
  if (!proxy || !proxy.host || !proxy.port) return null;
  return proxy;
}

async function authenticateIfNeeded(page, proxy) {
  if (proxy && proxy.username && proxy.password) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password
    });
  }
}

const worker = new Worker('tasks', async job => {
  // --- Job name validation ---
  if (!job.name || !ALLOWED_JOB_NAMES.has(job.name)) {
    throw new Error(`Unsupported job name: ${String(job?.name ?? '')}`);
  }

  // --- Job data validation ---
  if (!job.data) {
    throw new Error('Missing job.data');
  }

  try {
    console.log('WORKER STARTED');

    // =========================
    //  ПРОВЕРКА ПОЗИЦИИ
    // =========================
    if (job.name === 'rank-check') {
      const { keyword, domain, proxy } = job.data;

      if (!keyword || !domain) {
        throw new Error('rank-check requires job.data.keyword and job.data.domain');
      }

      const pos = await checkPosition(keyword, domain, proxy);

      console.log(`Keyword: ${keyword}`);
      console.log(`Position: ${pos}`);
    }

    // =========================
      //  VISIT
      //  =========================
      if (job.name === 'visit') {

        if (!job.data.url) {
          throw new Error('visit requires job.data.url');
        }

        // прокси берём из job.data или из конфига (.env)
        const proxy = job.data.proxy || getPrimaryProxy();
        if (!proxy) {
          throw new Error(
            'No proxy configured. Set HAIBO_PROXY_HOST/HAIBO_PROXY_PORT (and HAIBO_PROXY_USERNAME/HAIBO_PROXY_PASSWORD if auth is required) or pass proxy in job data.'
          );
        }

        const fp = buildFingerprint(proxy);

        const browser = await puppeteer.launch({
          headless: process.env.HEADLESS !== 'false',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            `--proxy-server=http://${proxy.host}:${proxy.port}`
          ]
        });

        try {
          const page = await browser.newPage();

          //  прокси авторизация (только если заданы креды)
          await authenticateIfNeeded(page, proxy);

          //  применяем fingerprint ДО перехода
          await applyFingerprint(page, fp);

          // =========================
          //  ПРОВЕРКА IP
          //  =========================
          await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded', timeout: 30000 });
          const ip = await page.evaluate(() => document.body.innerText);
          console.log('BROWSER IP:', ip);

          // =========================
          //  ПЕРЕХОД НА САЙТ
          //  =========================
          await page.goto(job.data.url, {
            waitUntil: 'domcontentloaded'
          });

          console.log({
            device: fp.name,
            proxy: `${proxy.host}:${proxy.port}`,
            url: job.data.url
          });

          // =========================
          //  ПОВЕДЕНИЕ
          //  =========================
          await simulateBehavior(page);

          console.log(`Visited ${job.data.url}`);
        } finally {
          await browser.close();
        }
        }

  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : String(e);
    console.error('ERROR:', msg);
    throw e;
  }

}, {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379)
  }
});

// Graceful shutdown
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker.close();
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT',  gracefulShutdown);
