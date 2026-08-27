#!/bin/bash
# Запуск Yandex-бота по проекту gir-master (gir-master.ru)
# Использование: ./gir-master.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project gir-master
