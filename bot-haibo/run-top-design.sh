#!/bin/bash
# Запуск Yandex-бота по проекту top-design-remont (топ-дизайн-ремонт.рф)
cd "$(dirname "$0")"
node yandex_search_visit.js --project top-design-remont
