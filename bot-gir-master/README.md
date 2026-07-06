# bot-gir-master

Клон `bot-system` под проверку сайта `gir-master.ru` в Google.

## Что делает

- ищет домен `gir-master.ru` в Google по ключевой фразе;
- фиксирует позицию, найденный URL и title результата;
- открывает найденный URL через браузер и проверяет, что страница отвечает;
- сохраняет лог в `results-gir-master.txt`;
- сохраняет скриншот открытой страницы в `screenshots/`.

## Настройки

Основной файл: `config.js`.

```js
module.exports = {
  targetDomain: 'gir-master.ru',
  keywords: [
    'спилить дерево Казань'
  ],
  google: {
    maxPages: 10,
    resultsPerPage: 10,
    language: 'ru',
    country: 'ru'
  },
  proxy: {
    enabled: true,
    index: 0
  }
};
```

Прокси берутся из `proxies.js`.

## Запуск

Создайте `.env` по примеру `.env.example` и заполните:

```bash
GOOGLE_PROVIDER=custom-search
GOOGLE_API_KEY=your_google_api_key
GOOGLE_CX=your_custom_search_engine_id
```

Запуск:

```bash
npm run check
```

Режим `GOOGLE_PROVIDER=browser` оставлен только для диагностики браузерного сценария. Если Google показывает verification-страницу, скрипт не пытается обходить ее.

API-режим:

```bash
npm run worker
npm run server
```

Поставить задачу:

```bash
curl -X POST http://127.0.0.1:3000/rank \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"спилить дерево Казань"}'
```
