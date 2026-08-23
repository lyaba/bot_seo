#!/bin/bash
# Запуск Yandex-бота по проекту rem-kazan
# Использование: ./run-rem-kazan.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project rem-kazan
