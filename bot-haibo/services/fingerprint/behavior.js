function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function random(min, max) {
  return Math.random() * (max - min) + min;
}

async function simulateBehavior(page) {

  // задержка как будто загрузился сайт
  await sleep(random(3000, 7000));

  // скролл вниз
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 100;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });

  // пауза внизу
  await sleep(random(4000, 8000));

  // пробуем кликнуть по внутренней ссылке
  const links = await page.$$('a');

  if (links.length > 0) {
    const randomLink = links[Math.floor(Math.random() * links.length)];

    try {
      await randomLink.click();
      await sleep(random(3000, 6000));
    } catch (e) {}
  }
}

module.exports = { simulateBehavior };
