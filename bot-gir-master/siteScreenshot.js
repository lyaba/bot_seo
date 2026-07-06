const puppeteer = require('puppeteer');

async function takeScreenshot(domain) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  console.log(" Открываю сайт:", domain);

  await page.goto(`https://${domain}`, {
    waitUntil: 'networkidle2',
    timeout: 20000
  });

  await new Promise(r => setTimeout(r, 3000));

  //  Пытаемся закрыть cookie / consent
  try {
    const buttons = await page.$$('button, a');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.innerText.toLowerCase(), btn);
      if (
        text.includes('accept') ||
        text.includes('agree') ||
        text.includes('принять') ||
        text.includes('соглас')
      ) {
        await btn.click();
        console.log(' Закрыл cookie баннер');
        break;
      }
    }
  } catch (e) {}

  // небольшие движения мыши (без агрессии)
  await page.mouse.move(200, 200);
  await new Promise(r => setTimeout(r, 500));
  await page.mouse.move(500, 400);

  //  Плавный скролл вниз
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let lastHeight = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, 300);
        const newHeight = document.body.scrollHeight;

        if (newHeight === lastHeight) {
          clearInterval(timer);
          resolve();
        }

        lastHeight = newHeight;
      }, 400);
    });
  });

  await new Promise(r => setTimeout(r, 2000));

  const file = `screenshot-${domain}.png`;

  await page.screenshot({
    path: file,
    fullPage: true
  });

  console.log(" Скрин сохранён:", file);

  await browser.close();
  return file;
}

module.exports = { takeScreenshot };
