const axios = require('axios');

async function checkSite(domain) {
  try {
    const res = await axios.get(`https://${domain}`, {
      timeout: 10000,
      validateStatus: () => true
    });

    return res.status === 200;

  } catch (e) {
    return false;
  }
}

module.exports = { checkSite };
