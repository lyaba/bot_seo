const { Worker } = require('bullmq');
const { checkPosition } = require('../services/rankChecker');
const { checkSite } = require('../services/siteChecker');

function isProxyError(error) {
  const message = error && error.message ? error.message : String(error);
  return message.includes('ERR_INVALID_AUTH_CREDENTIALS') ||
    message.includes('ERR_PROXY') ||
    message.includes('ERR_TUNNEL_CONNECTION_FAILED');
}

async function checkPositionWithFallback(keyword, domain, proxy) {
  try {
    return await checkPosition(keyword, domain, proxy);
  } catch (e) {
    if (!proxy || !isProxyError(e)) throw e;

    console.log(`Proxy failed (${e.message}), retrying without proxy`);
    return checkPosition(keyword, domain, null);
  }
}

new Worker('tasks', async job => {
  try {
    console.log('WORKER STARTED');

    if (job.name === 'rank-check') {
      const { keyword, domain, proxy } = job.data;

      let rank;

      try {
        rank = await checkPositionWithFallback(keyword, domain, proxy);
      } catch (e) {
        if (e.code !== 'GOOGLE_BLOCKED') throw e;

        rank = {
          position: null,
          url: null,
          error: e.code
        };
      }

      const site = rank.url
        ? await checkSite(rank.url, null)
        : await checkSite(domain, null);

      console.log(`Keyword: ${keyword}`);
      console.log(`Position: ${rank.position ?? 'not found'}`);
      console.log(`URL: ${rank.url || '-'}`);
      console.log(`Rank error: ${rank.error || '-'}`);
      console.log(`Site OK: ${site.ok} (${site.status || 'no status'})`);
    }

    if (job.name === 'site-check') {
      const site = await checkSite(job.data.url, job.data.proxy);

      console.log(`URL: ${job.data.url}`);
      console.log(`Site OK: ${site.ok} (${site.status || 'no status'})`);
      console.log(`Final URL: ${site.finalUrl}`);
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
