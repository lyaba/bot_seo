const express = require('express');
const queue = require('./queue');
const config = require('./config');
const proxies = require('./proxies');

const app = express();
app.use(express.json());

function defaultProxy() {
  if (!config.proxy.enabled) return null;
  return proxies[config.proxy.index] || proxies[0] || null;
}

app.post('/rank', async (req, res) => {
  const keyword = req.body.keyword || config.keywords[0];
  const domain = req.body.domain || config.targetDomain;
  const proxy = req.body.proxy || defaultProxy();

  await queue.add('rank-check', { keyword, domain, proxy });

  res.json({ status: 'queued', keyword, domain });
});

app.post('/check-site', async (req, res) => {
  const url = req.body.url || config.targetDomain;
  const proxy = req.body.proxy || defaultProxy();

  await queue.add('site-check', { url, proxy });

  res.json({ status: 'queued', url });
});

app.listen(3000, () => {
  console.log('Gir Master API started on 3000');
});
