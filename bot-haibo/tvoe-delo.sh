#!/bin/bash
# Запуск Yandex-бота по проекту tvoe-delo (твое-дело.com)
# Использование: ./tvoe-delo.sh
cd "$(dirname "$0")"
node yandex_search_visit.js --project tvoe-delo
