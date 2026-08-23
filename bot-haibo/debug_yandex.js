const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const proxies = require('./proxies');

async function main() {
  const proxy = proxies[0];

  console.log('=== Dumping Yandex page structure ===');
  console.log('Proxy:', `${proxy.host}:${proxy.port}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--proxy-server=http://${proxy.host}:${proxy.port}`
    ]
  });

  try {
    const page = await browser.newPage();

    await page.authenticate({
      username: proxy.username,
      password: proxy.password
    });

    // Set mobile fingerprint to match the bot
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    await page.setViewport({
      width: 1080,
      height: 2220,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });

    console.log('--- Loading Yandex ---');
    await page.goto('https://yandex.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait a bit for all dynamic content
    await new Promise(r => setTimeout(r, 3000));

    // Get all input/textarea elements with their attributes
    const inputs = await page.evaluate(() => {
      const elements = document.querySelectorAll('input, textarea');
      return Array.from(elements).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || 'N/A',
        name: el.name || 'N/A',
        title: el.title || 'N/A',
        placeholder: el.placeholder || 'N/A',
        className: el.className || 'N/A',
        id: el.id || 'N/A',
        dataAttrs: Object.keys(el.attributes).filter(k => k.startsWith('data-')).reduce((a, k) => { a[k] = el.getAttribute(k); return a; }, {}),
        visible: el.offsetParent !== null,
        ariaLabel: el.getAttribute('aria-label') || 'N/A'
      }));
    });

    console.log('\n=== ALL INPUT/TEXTAREA ELEMENTS ===');
    inputs.forEach((el, i) => {
      console.log(`\n[${i}] tag=${el.tag}, type=${el.type}, name=${el.name}, title=${el.title}`);
      console.log(`    placeholder=${el.placeholder}, class=${el.className}`);
      console.log(`    id=${el.id}, aria-label=${el.ariaLabel}`);
      console.log(`    dataAttrs:`, JSON.stringify(el.dataAttrs));
      console.log(`    visible=${el.visible}`);
    });

    // Also get all elements with "search" or "input" in class/id/name
    const searchRelated = await page.evaluate(() => {
      const allEls = document.querySelectorAll('*');
      return Array.from(allEls).filter(el => {
        const str = (el.className || '') + ' ' + (el.id || '') + ' ' + (el.name || '');
        return /search|input|поиск/i.test(str);
      }).slice(0, 30).map(el => ({
        tag: el.tagName,
        class: el.className || '',
        id: el.id || '',
        name: el.name || '',
        text: (el.textContent || '').substring(0, 100),
        children: el.children.length
      }));
    });

    console.log('\n=== SEARCH-RELATED ELEMENTS ===');
    searchRelated.forEach(el => {
      console.log(`<${el.tag}> class="${el.class}" id="${el.id}" name="${el.name}" text="${el.text}"`);
    });

    // Save full HTML for inspection
    const html = await page.content();
    require('fs').writeFileSync('./yandex_page_dump.html', html);
    console.log('\n=== Full HTML saved to yandex_page_dump.html ===');

    // Also save a screenshot
    await page.screenshot({ path: './yandex_debug.png', fullPage: true });
    console.log('Screenshot saved: yandex_debug.png');

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
