#!/bin/bash
# Запуск Yandex-бота по проекту haibomotor (haibomotor.ru)
# Использование: ./haibomotor.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project haibomotor
