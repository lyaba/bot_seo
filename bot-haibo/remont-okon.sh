#!/bin/bash
# Запуск Yandex-бота по проекту remont-okon (remont-okonkzn.ru)
# Использование: ./remont-okon.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project remont-okon
