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

new Worker('tasks', async job => {
  try {
console.log('WORKER STARTED');
    // =========================
    //  ПРОВЕРКА ПОЗИЦИИ
    // =========================
    if (job.name === 'rank-check') {
      const { keyword, domain, proxy } = job.data;

      const pos = await checkPosition(keyword, domain, proxy);

      console.log(`Keyword: ${keyword}`);
      console.log(`Position: ${pos}`);
    }

    // =========================
    //  VISIT
    // =========================
    if (job.name === 'visit') {

      const fp = buildFingerprint(job.data.proxy);

      const browser = await puppeteer.launch({
        headless: true, //  важно (не true!)
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--proxy-server=http://res.geonix.com:10000'
        ]
      });

      const page = await browser.newPage();

      //  прокси авторизация
      await page.authenticate({
        username: 'dd2f0998bd27fe74',
        password: 'J9vgzyZDfBoq8sL7'
      });

      //  применяем fingerprint ДО перехода
      await applyFingerprint(page, fp);

      // =========================
      //  ПРОВЕРКА IP
      // =========================
      await page.goto('https://api.ipify.org');
      const ip = await page.evaluate(() => document.body.innerText);
      console.log('BROWSER IP:', ip);

      // =========================
      //  ПЕРЕХОД НА САЙТ
      // =========================
      await page.goto(job.data.url, {
        waitUntil: 'domcontentloaded'
      });

      console.log({
        device: fp.name,
        proxy: 'res.geonix.com',
        url: job.data.url
      });

      // =========================
      //  ПОВЕДЕНИЕ
      // =========================
      await simulateBehavior(page);

      await browser.close();

      console.log(`Visited ${job.data.url}`);
    }

  } catch (e) {
    console.error('ERROR:', e);
  }

}, {
  connection: {
    host: '127.0.0.1',
    port: 6379
  }
});
