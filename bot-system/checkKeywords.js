const { checkPosition } = require('./services/rankChecker');
const fs = require('fs');
const { takeScreenshot } = require('./services/siteScreenshot');

function shouldVisit(pos) {
  if (!pos) return false;

  if (pos <= 10) return Math.random() < 0.9;
  if (pos <= 20) return Math.random() < 0.7;
  if (pos <= 30) return Math.random() < 0.5;
  if (pos <= 50) return true;

  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const keywords = [
  "заказать авто из китая в россию",
  "заказать авто из китая в Казань",
  "volkswagen golf 8 280tsi dsg pro",
  "заказать авто из китая под ключ",
  "заказать авто из китая цена",
  "заказать авто напрямую из китая",
  "заказать авто под заказ из китая",
"заказать авто из китая под ключ Казань",
"заказать авто из китая цена Казань",
 "заказать авто напрямую из китая в Казань",
"заказать авто под заказ из китая в Казань",
];

const domain = "horgos-auto.com";

async function run() {

  for (const keyword of keywords) {

    console.log("Checking:", keyword);

    const pos = await checkPosition(keyword, domain);

    console.log(`Позиция: ${pos}`);

    fs.appendFileSync(
      'results.txt',
      `${new Date().toISOString()} | ${keyword} | ${pos}\n`
    );

    if (shouldVisit(pos)) {

      console.log("Заходим на сайт");

      const proxy = {
        host: 'res.geonix.com',
        port: '10000',
        username: 'ad5b4adb1240604a',
        password: '17e0UIjWRqhTN3J4'
      };

      //  ПЕРЕДАЁМ KEYWORD
      const screenshot = await takeScreenshot(
        domain,
        proxy,
        keyword
      );

      console.log("Скрин:", screenshot);

    } else {

      console.log("Пропуск");

    }

    console.log("----------");

    await sleep(10000 + Math.random() * 10000);
  }
}

run();
