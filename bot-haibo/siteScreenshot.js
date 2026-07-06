const puppeteer = require('puppeteer');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanScroll(page, count = 8) {

  for (let i = 0; i < count; i++) {

    await page.evaluate((y) => {

      window.scrollBy({
        top: y,
        behavior: 'smooth'
      });

    }, random(300, 900));

    await sleep(random(2000, 5000));
  }
}

async function randomMouse(page) {

  await page.mouse.move(
    random(100, 800),
    random(100, 700),
    { steps: 20 }
  );

  await sleep(random(500, 1500));

  await page.mouse.move(
    random(100, 1200),
    random(100, 700),
    { steps: 25 }
  );
}


async function takeScreenshot(domain, proxy, keyword) {
 console.log('NEW VERSION LOADED');

  // MOBILE / DESKTOP RANDOM
  const devices = [

    {
      width: 390,
      height: 844,
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    },

    {
      width: 412,
      height: 915,
      ua: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
    },

    {
      width: 1366,
      height: 768,
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    }

  ];

  const device = devices[random(0, devices.length - 1)];

  const browser = await puppeteer.launch({
    headless: "new",

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--proxy-server=http://${proxy.host}:${proxy.port}`
    ]
  });

  const page = await browser.newPage();

  // PROXY AUTH
  await page.authenticate({
    username: proxy.username,
    password: proxy.password
  });

  await page.setViewport({
    width: device.width,
    height: device.height
  });

  await page.setUserAgent(device.ua);

  console.log('Открываю:', domain);

  await page.goto(`https://${domain}`, {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  await sleep(random(4000, 7000));

  // COOKIE
  try {

    const buttons = await page.$$('button, a');

    for (const btn of buttons) {

      try {

        const text = await page.evaluate(
          el => el.innerText.toLowerCase(),
          btn
        );

        if (
          text.includes('accept') ||
          text.includes('agree') ||
          text.includes('ok') ||
          text.includes('принять') ||
          text.includes('соглас')
        ) {

          await btn.click();

          console.log('Cookie accepted');

          await sleep(3000);

          break;
        }

      } catch(e) {}
    }

  } catch(e) {}

  // ДВИЖЕНИЕ МЫШИ
  await randomMouse(page);

  // ПЕРВЫЙ СКРОЛЛ  
await humanScroll(page, 6);

// ЖДЕМ ПРОГРУЗКУ ТОВАРОВ
await sleep(5000);

// РЕАЛЬНЫЕ ПЕРЕХОДЫ ПО СТРАНИЦАМ
const pages = [
  '/elektromotory/',
  '/aksessuary/',
  '/kontakty/',
  '/usloviya-oplaty/'
];

for (const p of pages) {

  try {

    console.log('Открываю страницу:', p);

    await page.goto(`https://${domain}${p}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await sleep(random(10000, 20000));

    await humanScroll(page, 6);

    await randomMouse(page);

    // ЖДЕМ КАРТОЧКИ
    await page.waitForSelector('.btn-more-products', {
      timeout: 10000
    }).catch(() => {});

    // КЛИК ПОДРОБНЕЕ
    try {

      const details =
        await page.$$('.btn-more-products');

      console.log('Карточек найдено:', details.length);

      if (details.length > 0) {

        const btn =
          details[random(0, details.length - 1)];

        await btn.click();

        console.log('Открыл подробнее');

        await sleep(random(8000, 15000));

        await humanScroll(page, 4);

        await page.keyboard.press('Escape');

        await sleep(3000);
      }

    } catch(e) {
      console.log('Ошибка карточек');
    }

  } catch(e) {
    console.log('Ошибка страницы:', p);
  }
}

  // МЕНЮ
  try {

    const menuLinks = await page.$$('#top-nav-ul a');

    console.log('Меню:', menuLinks.length);

    for (let i = 0; i < Math.min(menuLinks.length, 4); i++) {

      try {

        const text = await page.evaluate(
          el => el.innerText,
          menuLinks[i]
        );

        console.log('Открываю меню:', text);

        await Promise.all([

          page.waitForNavigation({
            waitUntil: 'networkidle2',
            timeout: 15000
          }).catch(() => {}),

          menuLinks[i].click()

        ]);

        await sleep(random(5000, 12000));

        await humanScroll(page, 4);

        await randomMouse(page);

        // КЛИК ПОДРОБНЕЕ
        try {

          const details = await page.$$('.btn-more-products');

          if (details.length > 0) {

            const btn =
              details[random(0, details.length - 1)];

            await btn.click();

            console.log('Открыл подробнее');

            await sleep(random(6000, 12000));

            await humanScroll(page, 3);

            await page.keyboard.press('Escape');

            await sleep(3000);
          }

        } catch(e) {}

        // ВОЗВРАТ
        await page.goBack({
          waitUntil: 'networkidle2'
        }).catch(() => {});

        await sleep(random(4000, 8000));

      } catch(e) {

        console.log('Ошибка меню');

      }
    }

  } catch(e) {

    console.log('Меню не найдено');

  }

  // WHATSAPP
  try {

    const wa = await page.$('.whatsapp');

    if (wa) {

      console.log('WhatsApp click');

      await wa.click();

      await sleep(random(5000, 9000));
    }

  } catch(e) {}

  // TELEGRAM
  try {

    const tg = await page.$('.telegram');

    if (tg) {

      console.log('Telegram click');

      await tg.click();

      await sleep(random(5000, 9000));
    }

  } catch(e) {}

  // КНОПКА КУПИТЬ
  try {

    const buyBtn = await page.$('.btn.scroll');

    if (buyBtn) {

      await buyBtn.click();

      console.log('Клик купить');

      await sleep(random(5000, 10000));

      await humanScroll(page, 4);
    }

  } catch(e) {}

  // ДОПОЛНИТЕЛЬНЫЙ СКРОЛЛ
  await humanScroll(page, 8);

  // ВВЕРХ
  await page.evaluate(() => {

    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });

  });

  await sleep(random(4000, 7000));

  // ИТОГОВОЕ ВРЕМЯ
  await sleep(random(15000, 30000));

  // SCREENSHOT
  const file =
    `screenshot-${domain}-${Date.now()}.png`;

  await page.screenshot({
    path: file,
    fullPage: true
  });

  console.log('Скрин сохранен:', file);

  await browser.close();

  return file;
}

module.exports = { takeScreenshot };
