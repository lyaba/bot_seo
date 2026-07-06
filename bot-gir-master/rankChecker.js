// 1. открываем главную Яндекса
await page.goto('https://yandex.ru', {
  waitUntil: 'domcontentloaded'
});

// 2. небольшая пауза (человек думает)
await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

// 3. ждём поле поиска
await page.waitForSelector('input[name="text"]');

// 4. вводим текст как человек
await page.type('input[name="text"]', keyword, {
  delay: 80 + Math.random() * 100
});

// 5. пауза перед нажатием Enter
await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

// 6. нажимаем Enter
await page.keyboard.press('Enter');

// 7. ждём загрузку выдачи
await page.waitForNavigation({
  waitUntil: 'domcontentloaded'
});

// 8. даём странице "подышать"
await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
