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
  "gps розетка haibomotor",
"аккумулятор haibomotor",
"аккумулятор haibomotor",
"быстросъемная пластина для лодки haibomotor",
"компас nav sensor haibomotor",
"крепления ram для пвх лодки haibomotor",
"купить haibo ipenguin haibomotor",
"лодочный электромотор haibomotor",
"электромотор купить haibomotor",
"электромотор для лодки haibomotor"
];

const domain = "haibomotor.ru";

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
        username: '5df416f249c6d735',
        password: 'WQCaA7JhOEu69oSs'
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
