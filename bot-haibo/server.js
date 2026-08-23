const express = require('express');
const queue = require('./queue');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);

app.post('/visit', async (req, res) => {
  const { url, proxy } = req.body;

  await queue.add('visit', { url, proxy });

  res.json({ status: 'queued' });
});



app.post('/rank', async (req, res) => {
  const { keyword, domain } = req.body;

  await queue.add('rank-check', { keyword, domain });

  res.json({ status: 'queued' });
});


app.get('/health', (req, res) => {
  let redis = 'unknown';
  try {
    redis = queue.client ? queue.client.status : 'unknown';
  } catch (e) {
    redis = 'error';
  }

  res.json({
    ok: true,
    redis,
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`API started on ${PORT}`);
});
