require('dotenv').config({ quiet: true });

const config = require('./config');
const rankChecker = require('./services/rankChecker');
const fs = require('fs');
const path = require('path');
const { checkSite } = require('./services/siteChecker');
const proxies = require('./proxies');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function selectedProxy() {
  if (!config.proxy.enabled) return null;
  return proxies[config.proxy.index] || proxies[0] || null;
}

function writeResult(record) {
  fs.appendFileSync(
    path.join(__dirname, 'results-gir-master.txt'),
    `${new Date().toISOString()} | ${record.keyword} | position=${record.position ?? 'not_found'} | ` +
      `url=${record.url || '-'} | ok=${record.site.ok} | status=${record.site.status || '-'} | ` +
      `final=${record.site.finalUrl || '-'} | screenshot=${record.site.screenshot || '-'} | ` +
      `clicked=${record.clicked || false} | rank_error=${record.rankError || '-'} | ` +
      `site_error=${record.site.error || '-'}\n`
  );
}

function isProxyError(error) {
  const message = error && error.message ? error.message : String(error);
  return message.includes('ERR_INVALID_AUTH_CREDENTIALS') ||
    message.includes('ERR_PROXY') ||
    message.includes('ERR_TUNNEL_CONNECTION_FAILED');
}

async function checkPositionWithFallback(keyword, domain, proxy) {
  try {
    return await rankChecker.checkPosition(keyword, domain, proxy);
  } catch (e) {
    if (!proxy || !isProxyError(e)) throw e;

    console.log(`Прокси недоступен (${e.message}), повторяю без прокси`);
    return rankChecker.checkPosition(keyword, domain, null);
  }
}

async function run() {
  const proxy = selectedProxy();

  for (const keyword of config.keywords) {

    console.log('Checking:', keyword);

    let rank;

    try {
      rank = await checkPositionWithFallback(keyword, config.targetDomain, proxy);
    } catch (e) {
      if (e.code !== 'GOOGLE_BLOCKED') throw e;

      console.log('Google вернул страницу проверки, позиция не определена');
      rank = {
        keyword,
        domain: config.targetDomain,
        position: null,
        page: null,
        url: null,
        title: null,
        error: e.code
      };
    }

    console.log(`Позиция: ${rank.position ?? 'не найдено'}`);
    if (rank.url) console.log(`URL: ${rank.url}`);

    const site = rank.finalUrl || rank.url
      ? await checkSite(rank.finalUrl || rank.url, null)
      : await checkSite(config.targetDomain, null);

    console.log(`Сайт: ${site.ok ? 'работает' : 'ошибка'} (${site.status || 'no status'})`);
    console.log(`Клик по результату: ${rank.clicked ? 'да' : 'нет'}`);
    if (site.screenshot) console.log(`Скрин: ${site.screenshot}`);

    writeResult({
      keyword,
      position: rank.position,
      url: rank.finalUrl || rank.url,
      clicked: rank.clicked,
      rankError: rank.error,
      site
    });

    console.log('----------');

    await sleep(10000 + Math.random() * 10000);
  }
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
