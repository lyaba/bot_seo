const puppeteer = require('puppeteer');
const axios = require('axios');
const https = require('https');

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const PROFILES = [
  {
    name: 'desktop',
    viewport: { width: 1920, height: 1080, isMobile: false },
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120 Safari/537.36'
  },
  {
    name: 'mobile',
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
  }
];

async function humanMouse(page) {
  for (let i = 0; i < rand(4, 7); i++) {
    await page.mouse.move(rand(50, 1200), rand(80, 700), { steps: rand(8, 20) });
    await sleep(rand(200, 800));
  }
}

async function closeCookie(page) {
  try {
    const buttons = await page.$$('button, a');
    for (const el of buttons) {
      const txt = (await page.evaluate(e => (e.innerText || '').toLowerCase(), el)) || '';
      if (txt.includes('accept') || txt.includes('agree') ||
          txt.includes('принять') || txt.includes('соглас')) {
        await el.click({ delay: rand(50, 150) });
        await sleep(rand(500, 1200));
        console.log('cookie закрыт');
        break;
      }
    }
  } catch {}
}

async function scrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let last = 0;
      const timer = setInterval(() => {
        const step = 200 + Math.random() * 200;
        window.scrollBy(0, step);
        const h = document.body.scrollHeight;

        if (h === last) {
          clearInterval(timer);
          resolve();
        }
        last = h;
      }, 400);
    });
  });
}

async function clickInternalLink(page, domain) {
  try {
    const links = await page.$$('a[href]');
    for (const link of links) {
      const href = await page.evaluate(el => el.href, link);
      if (href && href.includes(domain)) {
        console.log('переход:', href);

        await Promise.all([
          page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
          link.click({ delay: rand(50, 150) })
        ]);

        return true;
      }
    }
  } catch {}
  return false;
}






async function browseProducts(page) {
  try {

    const productLinks = await page.$$(
      'a[href*="/product/"]'
    );

    if (!productLinks.length) {
      console.log(' Карточки не найдены');
      return;
    }

    // сколько карточек открыть
    const count = rand(1, 3);

    for (let i = 0; i < count; i++) {

      const links = await page.$$(
        'a[href*="/product/"]'
      );

      const randomLink =
        links[rand(0, links.length)];

      const href = await page.evaluate(
        el => el.href,
        randomLink
      );

      console.log(' Открываем товар:', href);

      await Promise.all([
        page.waitForNavigation({
          timeout: 30000
        }).catch(() => {}),
        randomLink.click({
          delay: rand(50, 150)
        })
      ]);

      // читаем страницу
      await sleep(rand(3000, 7000));

      // скроллим товар
      await scrollToBottom(page);

      await sleep(rand(2000, 5000));

      // иногда немного вверх
      await page.evaluate(() => {
        window.scrollBy(0, -500);
      });

      await sleep(rand(1000, 3000));

      // назад в каталог
      await page.goBack({
        waitUntil: 'domcontentloaded'
      }).catch(() => {});

      await sleep(rand(2000, 4000));
    }

  } catch (e) {
    console.log('browseProducts error:', e.message);
  }
}






async function takeScreenshot(domain, proxy, keyword) {



const { HttpsProxyAgent } = require('https-proxy-agent');

try {
  const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;

  const agent = new HttpsProxyAgent(proxyUrl);

  const ipRes = await axios.get('https://api.ipify.org?format=json', {
    httpsAgent: agent,
    timeout: 10000
  });

  console.log(" Proxy IP:", ipRes.data.ip);

} catch (e) {
  console.log(" Proxy IP error:", e.message);
}

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      `--proxy-server=http://${proxy.host}:${proxy.port}`
    ]
  });

  const page = await browser.newPage();

  //  авторизация прокси
  if (proxy && proxy.username) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password
    });
  }

  const profile = pick(PROFILES);
  await page.setViewport(profile.viewport);
  await page.setUserAgent(profile.ua);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Referer': 'https://yandex.ru/'
  });

  const url = `https://${domain}`;
  console.log(`[${profile.name}] Открываю:`, url);

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  } catch {
    console.log('goto timeout, продолжаем');
  }

  //  ПРАВИЛЬНАЯ ПРОВЕРКА IP (через прокси)


  // пауза
  await sleep(rand(2000, 4000));

  if (!profile.viewport.isMobile) {
    await humanMouse(page);
  }

  await closeCookie(page);

  await scrollToBottom(page);
 

await sleep(rand(1500, 3000));  
await browseProducts(page);


const clicked = await clickInternalLink(page, domain);

  if (clicked) {
    await sleep(rand(2000, 4000));
 await scrollToBottom(page);
   
  }






  const file = `screenshots/${domain}-${Date.now()}.png`;
  await page.screenshot({ path: file, fullPage: true });

  console.log('Скрин сохранён:', file);

  await browser.close();
  return file;
}

module.exports = { takeScreenshot };
