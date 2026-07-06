const express = require('express');
const queue = require('./queue');

const app = express();
app.use(express.json());

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


app.listen(3000, () => {
  console.log('API started on 3000');
});
