#!/bin/bash
# Запуск Yandex-бота по проекту remont-forsunok (kzndiesel.ru)
# Использование: ./remont-forsunok.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project remont-forsunok
