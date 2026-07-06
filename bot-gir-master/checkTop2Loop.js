require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('./config');
const proxies = require('./proxies');
const { checkPosition } = require('./services/rankChecker');
const { checkSite } = require('./services/siteChecker');

const stateFile = path.join(__dirname, '.top2-loop-state.json');
const resultFile = path.join(__dirname, 'results-top2-loop.txt');

function selectedProxy() {
  if (!config.proxy.enabled) return null;
  return proxies[config.proxy.index] || proxies[0] || null;
}

function describeProxy(proxy) {
  if (!proxy) return 'direct';
  return `${proxy.host}:${proxy.port}`;
}

async function getSearchIp(proxy) {
  try {
    const requestConfig = {
      timeout: 20000
    };

    if (proxy && proxy.host && proxy.port) {
      const proxyUrl = proxy.username
        ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
        : `http://${proxy.host}:${proxy.port}`;

      requestConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
      requestConfig.proxy = false;
    }

    const response = await axios.get('https://api.ipify.org?format=json', requestConfig);
    return response.data.ip || 'unknown';
  } catch (error) {
    console.log(`Search IP check failed: ${error.message}`);
    return 'unknown';
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { index: 0 };
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function nextKeyword() {
  const state = readState();
  const index = state.index % config.keywords.length;
  const keyword = config.keywords[index];

  writeState({
    index: index + 1,
    lastKeyword: keyword,
    updatedAt: new Date().toISOString()
  });

  return keyword;
}

function writeResult(record) {
  fs.appendFileSync(
    resultFile,
    `${new Date().toISOString()} | ${record.keyword} | top2=${record.top2} | ` +
      `provider=${record.provider || 'browser'} | proxy=${record.proxy || '-'} | ` +
      `search_ip=${record.searchIp || '-'} | device=${record.device || '-'} | ` +
      `position=${record.position ?? 'not_found'} | url=${record.url || '-'} | ` +
      `site_ok=${record.siteOk ?? '-'} | status=${record.status || '-'} | ` +
      `error=${record.error || '-'}\n`
  );
}

async function runOnce() {
  const keyword = nextKeyword();
  const domain = config.targetDomain;
  const proxy = selectedProxy();
  const proxyLabel = describeProxy(proxy);
  const searchIp = await getSearchIp(proxy);

  console.log('='.repeat(60));
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`SEO top-2 diagnostic: ${keyword}`);
  console.log(`Target: ${domain}`);
  console.log(`Provider: browser`);
  console.log(`Proxy: ${proxyLabel}`);
  console.log(`Search IP: ${searchIp}`);

  try {
    const rank = await checkPosition(keyword, domain, proxy, {
      maxPages: 1,
      resultsPerPage: 10,
      stopAfterResults: 2,
      clickResult: false
    });

    const top2 = Boolean(rank.position && rank.position <= 2);
    const site = await checkSite(rank.url || domain, null);

    console.log(`Top 2: ${top2 ? 'YES' : 'NO'}`);
    console.log(`Position: ${rank.position ?? 'not_found'}`);
    console.log(`URL: ${rank.url || '-'}`);
    console.log(`Device: ${rank.device || '-'}`);
    console.log(`Site works: ${site.ok} (${site.status || 'no status'})`);

    writeResult({
      keyword,
      top2,
      provider: 'browser',
      proxy: proxyLabel,
      searchIp,
      device: rank.device,
      position: rank.position,
      url: rank.url,
      siteOk: site.ok,
      status: site.status
    });
  } catch (error) {
    const message = error.code === 'GOOGLE_BLOCKED'
      ? 'GOOGLE_BLOCKED'
      : error.message;

    console.log(`Diagnostic failed: ${message}`);
    writeResult({
      keyword,
      top2: false,
      provider: 'browser',
      proxy: proxyLabel,
      searchIp,
      device: '-',
      position: null,
      url: null,
      error: message
    });
  }
}

async function runLoop() {
  const intervalMs = config.google.intervalMinutes * 60 * 1000;

  while (true) {
    await runOnce();

    console.log(`Next run in ${config.google.intervalMinutes} minutes`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

runLoop().catch(error => {
  console.error('Fatal:', error);
  process.exit(1);
});
