# Контекст работы — Fingerprint Fix

## Текущая задача
Исправить ошибки в fingerprint-модулях ботов (bot-haibo, bot-gir-master, bot-system).

## Найденные проблемы (41 issue)

### Критические (обязательно исправить):
1. Хардкод credentials прокси — вынести в .env
2. Canvas toDataURL возвращает случайные данные вместо детерминированного хеша
3. Canvas toBlob вызывает callback(null) — пустой canvas
4. Cookie domain mismatch — устанавливаются на google.com, а применяются к целевому сайту
5. Scroll bug — не учитывает scrollY (bot-haibo и bot-gir-master)
6. Нет Referer заголовка в базовых версиях
7. Нет Sec-Fetch заголовков в базовых версиях
8. Нет WebGL injection в базовых версиях

### Высокий приоритет:
9. Только 2 устройства — мало для PageSpeed Insights
10. Двойной WebGL patch конфликтует с puppeteer-extra-stealth (bot-system)
11. AudioContext только BiquadFilter — не проверяет другие ноды
12. Timezone injection повреждает Intl.DateTimeFormat конструктор

### Средний приоритет:
13. clickLinks получает domain но не использует
14. simulateTabBehavior не открывает в новой вкладке
15. simulateTyping хардкодит фразы

## Файлы для изменения

### bot-system (продвинутая версия):
- services/fingerprint/devices.js — добавить canvasHash генерацию, расширить AudioContext
- services/fingerprint/applyFingerprint.js — исправить Canvas toDataURL, cookie domain, WebGL patch
- services/fingerprint/behavior.js — исправить clickLinks, typing

### bot-haibo (базовая версия):
- services/fingerprint/devices.js — добавить WebGL, Canvas, AudioContext данные
- services/fingerprint/applyFingerprint.js — добавить все injection'ы из bot-system
- services/fingerprint/behavior.js — исправить scroll bug, добавить проверки ссылок

### bot-gir-master (базовая версия):
- services/fingerprint/devices.js — аналогично bot-haibo
- services/fingerprint/applyFingerprint.js — аналогично bot-haibo  
- services/fingerprint/behavior.js — аналогично bot-haibo

### Worker'ы:
- workers/worker.js (bot-haibo) — вынести credentials прокси в .env

## План исправлений (приоритет):

### Фаза 1: Критические
1. [ ] bot-system applyFingerprint.js — исправить Canvas toDataURL (детерминированный хеш)
2. [ ] bot-system applyFingerprint.js — исправить cookie domain (целевой домен вместо google.com)
3. [ ] bot-haibo worker.js — вынести credentials в .env
4. [ ] bot-haibo behavior.js — исправить scroll bug (учесть scrollY)
5. [ ] bot-gir-master behavior.js — исправить scroll bug

### Фаза 2: Синхронизация версий
6. [ ] bot-system devices.js — расширить fingerprint данные
7. [ ] bot-haibo devices.js — добавить WebGL, Canvas, AudioContext из bot-system
8. [ ] bot-gir-master devices.js — аналогично

### Фаза 3: Применение fingerprint'ов
9. [ ] bot-haibo applyFingerprint.js — добавить все injection'ы
10. [ ] bot-gir-master applyFingerprint.js — добавить все injection'ы

### Фаза 4: Улучшения behavior
11. [ ] bot-system behavior.js — исправить clickLinks, typing
12. [ ] bot-haibo behavior.js — улучшить поведение

## Текущий прогресс
- Анализ завершён ✅
- Контекст сохранён в THIS file ✅
- Исправления: В ПРОЦЕССЕ
