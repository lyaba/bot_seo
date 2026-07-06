require('dotenv').config({ quiet: true });

const config = require('./config');
const proxies = require('./proxies');
const { checkPosition } = require('./services/rankChecker');
const { checkSite } = require('./services/siteChecker');

function selectedProxy() {
  if (!config.proxy.enabled) return null;
  return proxies[config.proxy.index] || proxies[0] || null;
}

async function run() {
  const keyword = config.keywords[0];
  const domain = config.targetDomain;
  const proxy = selectedProxy();

  console.log(`SEO diagnostic: ${keyword}`);
  console.log(`Target: ${domain}`);

  const rank = await checkPosition(keyword, domain, proxy, {
    maxPages: 1,
    resultsPerPage: 10,
    stopAfterResults: 2,
    clickResult: false
  });

  if (rank.error) {
    console.log(`Search error: ${rank.error}`);
  }

  console.log(`Top 2: ${rank.position && rank.position <= 2 ? 'YES' : 'NO'}`);
  console.log(`Position: ${rank.position ?? 'not_found'}`);
  console.log(`URL: ${rank.url || '-'}`);

  const site = await checkSite(rank.url || domain, null);
  console.log(`Site works: ${site.ok} (${site.status || 'no status'})`);
  if (site.screenshot) console.log(`Screenshot: ${site.screenshot}`);
}

run().catch(error => {
  if (error.code === 'GOOGLE_BLOCKED') {
    console.error('Google returned verification page. Top 2 cannot be checked from this IP.');
    if (process.env.KEEP_BROWSER_OPEN === 'true') {
      console.error('Browser is left open. Press Ctrl+C here when finished.');
      setInterval(() => {}, 1000);
      return;
    }
    process.exit(2);
  }

  console.error('Fatal:', error);
  process.exit(1);
});
