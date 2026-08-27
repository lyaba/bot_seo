#!/bin/bash
# Запуск Yandex-бота по проекту horgos-auto (horgos-auto.com)
# Использование: ./horgos-auto.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project horgos-auto
