const axios = require('axios');

const MAX_PAGES = 10;
const PER_PAGE = 10;

async function checkPosition(keyword, domain) {

  for (let page = 0; page < MAX_PAGES; page++) {

    const url = `https://xmlriver.com/search_yandex/xml?user=15338&key=d1deed1289c61524e62df8d5481fbf8777416e8e&query=${encodeURIComponent(keyword)}&lr=43&groupby=attr%3Dd.mode%3Dflat.groups-on-page%3D10&page=${page}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(` API (страница ${page}) попытка ${attempt}`);

        const res = await axios.get(url, {
          timeout: 60000
        });

        const xml = res.data;

        const matches = [...xml.matchAll(/<url>(.*?)<\/url>/g)].map(m => m[1]);

        for (let i = 0; i < matches.length; i++) {
          if (matches[i].includes(domain)) {
            return page * PER_PAGE + i + 1;
          }
        }

        break;

      } catch (e) {
        console.log(` ошибка попытка ${attempt}:`, e.message);

        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  return null;
}

//  ВОТ ЭТО САМОЕ ГЛАВНОЕ
module.exports = { checkPosition };
