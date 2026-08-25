# Flutter Demo Application

Это демонстрационное приложение на Flutter, показывающее базовую начальную страницу.

## Функциональность

- Отображение начальной страницы с заголовком
- Отображение иконки и приветственного текста
- Адаптивный дизайн с использованием Material Design

## Структура проекта

```
lib/
├── main.dart          # Точка входа приложения
pubspec.yaml           # Файл зависимостей
README.md              # Этот файл
```

## Запуск приложения

Для запуска приложения выполните команду:

```bash
flutter run
```

## Зависимости

- flutter: sdk flutter

## bot-haibo: проекты и CapMonster

Ключевые запросы для основного сценария `yandex_search_visit.js` редактируются в `bot-haibo/projects.json`. Для проекта ремонта квартир используется блок `rem-kazan`, поле `queries`.

Запуск проектов:

- `bot-haibo/run-rem-kazan.sh` — проект `rem-kazan`
- `bot-haibo/run-top-design.sh` — проект `top-design-remont`
- `bot-haibo/remont-okon.sh` — проект `remont-okon`

Текущая схема CapMonster:

- `solve_captcha.py --self-test` проверяет запуск Python, импорт `requests` и runtime-конфиг без создания платной задачи.
- `yandex_search_visit.js` запускает preflight перед solver-попытками.
- CapMonster API transport идёт напрямую с Mac: `route_api_via_proxy: false`.
- Мобильный прокси передаётся только в payload задачи CapMonster как task proxy.
- После transient transport error solver продолжает polling того же `taskId`.
- Если CapMonster остаётся в `processing` до wall-clock timeout, JS останавливает дальнейшие solver retries, чтобы не создавать новые платные задачи.

## Лицензия

Этот проект лицензирован под MIT лицензией.
