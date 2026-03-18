# ST VILLAGE AdminPanel v2.2.0

Веб-панель управления MTG прокси серверами (Telegram MTPROTO proxy). Управление нодами, клиентами, тарифами и платежами через единый интерфейс. Включает клиентский сайт с регистрацией, оплатой через YooKassa и личным кабинетом.

![Version](https://img.shields.io/badge/version-2.2.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Docker](https://img.shields.io/badge/docker-required-blue)

---

## Содержание

- [Возможности](#возможности)
- [Архитектура](#архитектура)
- [Требования](#требования)
- [Установка](#установка)
- [Установка MTG Agent на ноды](#установка-mtg-agent-на-ноды)
- [Настройка нод в панели](#настройка-нод-в-панели)
- [Клиентский сайт](#клиентский-сайт)
- [Структура проекта](#структура-проекта)
- [API Reference](#api-reference)
- [Переменные окружения](#переменные-окружения)
- [Фоновые задачи](#фоновые-задачи)
- [Обновление](#обновление)
- [Changelog](#changelog)

---

## Возможности

### Админ-панель
- Дашборд: сводная статистика нод, клиентов и подключений в реальном времени (авто-обновление каждые 15 сек)
- Управление нодами: добавление, редактирование, удаление, SSH (пароль / ключ), статус онлайн/офлайн, флаги стран
- Управление прокси-клиентами: создание/удаление MTG контейнеров, синхронизация, QR-коды, ссылки для подключения
- Лимит устройств — автоматический стоп прокси при превышении
- Автосброс трафика — ежедневно / ежемесячно / ежегодно
- Накопленный трафик — хранится в базе данных
- Автоудаление просроченных клиентов
- Ролевая система: admin, moderator, support
- TOTP двухфакторная авторизация
- Управление тарифными планами, заказами и платежами
- Управление базой данных: статистика таблиц, оптимизация (VACUUM), очистка
- Объявления для клиентов
- Changelog — журнал обновлений
- Проверка обновлений панели, MTG прокси и агента через GitHub

### Клиентский сайт
- Лендинг, регистрация, вход (email + пароль или Telegram)
- Подтверждение email, сброс пароля
- Каталог тарифов с выбором локации
- Подтверждение заказа — модальное окно со сводкой перед оплатой
- Оплата через YooKassa (автоматические webhook'и)
- Личный кабинет: мои прокси, статистика, QR-код для подключения
- Пинг серверов — отображение задержки до сервера с цветовой индикацией в дашборде и карточке прокси
- Навигация на главную для авторизованных пользователей (кнопка «Личный кабинет» на лендинге)
- История платежей
- Автопродление заказов
- PWA с мобильной навигацией

### MTG Agent
- Лёгкий HTTP агент на каждой ноде (Python FastAPI)
- Метрики MTG контейнеров через Docker SDK
- Подсчёт уникальных IP через `/proc/{pid}/net/tcp6`
- Эндпоинты: `/version`, `/health`, `/metrics`
- Docker с `pid: host` + `network_mode: host`
- Установка и обновление через панель одной кнопкой

---

## Архитектура

```
┌──────────────────────────────────────┐
│     ST VILLAGE AdminPanel            │
│     Node.js + Express + React        │
│     SQLite (better-sqlite3)          │
│     Порт: 3000                       │
│                                      │
│  ┌────────────┐  ┌────────────────┐  │
│  │ Admin SPA  │  │ Client React   │  │
│  │ public/    │  │ Vite + Tailwind│  │
│  │ index.html │  │ client/        │  │
│  └────────────┘  └────────────────┘  │
└──────────┬───────────────────────────┘
           │ SSH / HTTP
    ┌──────┴────────────────────────────┐
    │           Ноды                     │
    │  ┌─────────────┐  ┌────────────┐  │
    │  │  MTG Agent  │  │  MTG Proxy │  │
    │  │  Port 8081  │  │  mtg-user1 │  │
    │  │  FastAPI    │◄─│  mtg-user2 │  │
    │  │  pid: host  │  │  mtg-user3 │  │
    │  └─────────────┘  └────────────┘  │
    └───────────────────────────────────┘
```

### Логика метрик

1. **С агентом** (рекомендуется): Панель → HTTP к агенту → агент читает `/proc/{pid}/net/tcp6` → уникальные IP к порту 3128
2. **Без агента** (SSH fallback): Панель → SSH → shell → медленнее, нет онлайн-устройств

---

## Требования

### Панель
- Docker и Docker Compose
- Доступ к нодам по SSH (пароль или ключ)
- Порт 3000 (или другой, настраивается)

### Ноды
- Docker и Docker Compose
- SSH доступ с сервера панели
- Порт 8081 открыт для MTG Agent (опционально)

---

## Установка

### Вариант 1: Автоматическая установка (рекомендуется)

```bash
curl -fsSL https://raw.githubusercontent.com/Reibik/-mtg-adminpanel/main/deploy.sh | bash
```

Скрипт `deploy.sh` автоматически:
- Установит Docker (если нет)
- Запросит параметры: токен авторизации, порт, YooKassa, SMTP, Telegram бот, домен/SSL
- Клонирует репозиторий
- Сгенерирует `.env`
- Соберёт и запустит Docker-контейнер
- Опционально настроит Nginx + Let's Encrypt SSL + UFW firewall

### Вариант 2: Ручная установка

```bash
git clone https://github.com/Reibik/-mtg-adminpanel.git /opt/mtg-adminpanel
cd /opt/mtg-adminpanel
cp .env.example .env
nano .env  # Заполнить параметры
docker compose up -d --build
```

Панель доступна по адресу `http://your-server:3000`

---

## Установка MTG Agent на ноды

### Через панель (рекомендуется)

1. Панель → Ноды → ✏️ нужная нода
2. В секции **MTG Agent** скопируй команду установки
3. Выполни на ноде:

```bash
mkdir -p /opt/mtg-agent && cd /opt/mtg-agent && curl -fsSL https://raw.githubusercontent.com/Reibik/-mtg-adminpanel/main/mtg-agent/install-agent.sh | bash
```

4. В настройках ноды укажи **Порт агента**: `8081`
5. Нажми **Проверить** → сохрани

### Ручная установка

```bash
ssh root@your-node.com
mkdir -p /opt/mtg-agent && cd /opt/mtg-agent
wget -q https://raw.githubusercontent.com/Reibik/-mtg-adminpanel/main/mtg-agent/install-agent.sh -O install.sh
bash install.sh your-agent-token
```

### Обновление агента

Через панель: Версии → кнопка обновления агента на нужной ноде.

Вручную:
```bash
cd /opt/mtg-agent
wget -q https://raw.githubusercontent.com/Reibik/-mtg-adminpanel/main/mtg-agent/main.py -O main.py
docker compose down && docker compose up -d
```

---

## Настройка нод в панели

### Структура MTG на ноде

```
/opt/mtg/users/
├── user1/
│   ├── config.toml          # secret, bind-to
│   └── docker-compose.yml   # образ, порт
├── user2/
│   ├── config.toml
│   └── docker-compose.yml
└── ...
```

### Параметры ноды

| Параметр | Описание | Пример |
|----------|----------|--------|
| Название | Отображаемое имя | `Helsinki` |
| Host / IP | Адрес сервера | `hel.example.com` |
| Domain | Домен (для ссылок клиентам) | `hel.example.com` |
| SSH User | Пользователь | `root` |
| SSH Port | Порт | `22` |
| Base Dir | Директория клиентов | `/opt/mtg/users` |
| Start Port | Начальный порт | `4433` |
| Флаг | ISO 3166-1 alpha-2 | `fi` |
| Порт агента | MTG Agent | `8081` |

---

## Клиентский сайт

React SPA (`client/`) — Vite + Tailwind CSS + Zustand + React Router.

### Страницы

| Страница | Описание |
|----------|----------|
| Landing | Главная / лендинг |
| Register | Регистрация (email / Telegram) |
| Login | Авторизация |
| VerifyEmail | Подтверждение email |
| ResetPassword | Сброс пароля |
| Dashboard | Личный кабинет |
| Plans | Каталог тарифов |
| Proxies | Мои прокси |
| ProxyDetail | Детали прокси: статистика, QR-код |
| Payments | История платежей |
| PaymentResult | Результат оплаты |
| Profile | Профиль (пароль, email, Telegram) |
| Changelog | История обновлений |
| Offer | Публичная оферта |
| Privacy | Политика конфиденциальности |

---

## Структура проекта

```
mtg-adminpanel/
├── backend/
│   └── src/
│       ├── app.js              # Express сервер, API, фоновые задачи
│       ├── db.js               # SQLite: 12 таблиц
│       ├── ssh.js              # SSH, логика агента
│       ├── auth-customer.js    # JWT аутентификация клиентов
│       ├── mailer.js           # Отправка email (SMTP)
│       ├── totp.js             # TOTP 2FA для админки
│       ├── yookassa.js         # Интеграция с YooKassa
│       └── routes/
│           ├── admin-extra.js  # Тарифы, заказы, клиенты, БД, объявления
│           └── client.js       # Клиентские API (auth, заказы, прокси)
├── client/                     # React клиентский сайт (Vite + Tailwind)
│   └── src/
│       ├── pages/              # 15 страниц
│       ├── components/         # Layout, UI, Telegram
│       ├── store/              # Zustand (auth)
│       └── api/                # Axios клиент
├── public/
│   └── index.html              # Админ-панель (React SPA, Babel standalone)
├── mtg-agent/
│   ├── main.py                 # FastAPI агент
│   ├── docker-compose.yml      # Docker конфиг агента
│   └── install-agent.sh        # Скрипт установки
├── deploy.sh                   # Автоустановка (6 шагов + SSL + firewall)
├── install.sh                  # Обёртка над deploy.sh
├── update.sh                   # Быстрое обновление
├── uninstall.sh                # Удаление
├── docker-compose.yml          # Docker конфиг панели
├── Dockerfile                  # Multi-stage сборка
└── CHANGELOG.md
```

---

## API Reference

### Аутентификация

**Админ-панель:** заголовок `x-auth-token: YOUR_AUTH_TOKEN` + опционально `x-totp-code`

**Клиентский API:** JWT Bearer токен (15 мин access + 30 дней refresh)

### Публичные эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/version` | Версия панели |
| GET | `/api/check-updates` | Проверка обновлений (GitHub API) |
| POST | `/api/admin/login` | Логин админа (username + password) |

### TOTP 2FA

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/totp/status` | Статус TOTP |
| POST | `/api/totp/setup` | Генерация секрета + QR |
| POST | `/api/totp/verify` | Активация TOTP |
| POST | `/api/totp/disable` | Отключение TOTP |

### Ноды (admin)

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/nodes` | Список нод |
| POST | `/api/nodes` | Создать ноду |
| PUT | `/api/nodes/:id` | Обновить |
| DELETE | `/api/nodes/:id` | Удалить |
| GET | `/api/nodes/:id/check` | Проверить SSH |
| GET | `/api/nodes/:id/check-agent` | Проверить агент |
| POST | `/api/nodes/:id/update-agent` | Обновить агент |
| GET | `/api/nodes/:id/traffic` | Трафик ноды |
| GET | `/api/nodes/:id/mtg-version` | Версия MTG образа |
| GET | `/api/nodes/:id/agent-version` | Версия агента |
| POST | `/api/nodes/:id/mtg-update` | Docker pull MTG |
| GET | `/api/status` | Статус всех нод |

### Прокси-пользователи (admin)

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/nodes/:id/users` | Список клиентов |
| POST | `/api/nodes/:id/users` | Создать клиента |
| PUT | `/api/nodes/:id/users/:name` | Обновить |
| DELETE | `/api/nodes/:id/users/:name` | Удалить |
| POST | `/api/nodes/:id/users/:name/stop` | Остановить |
| POST | `/api/nodes/:id/users/:name/start` | Запустить |
| POST | `/api/nodes/:id/users/:name/reset-traffic` | Сброс трафика |
| GET | `/api/nodes/:id/users/:name/history` | История подключений |
| POST | `/api/nodes/:id/sync` | Синхронизация |

### Админ-пользователи

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/admin/role` | Текущая роль |
| GET | `/api/admin/users` | Список админов |
| POST | `/api/admin/users` | Создать (admin/moderator/support) |
| PUT | `/api/admin/users/:id` | Обновить |
| DELETE | `/api/admin/users/:id` | Удалить |

### Тарифы, заказы, клиенты (admin)

| Метод | URL | Описание |
|-------|-----|----------|
| GET/POST | `/api/plans` | Список / создание тарифов |
| PUT/DELETE | `/api/plans/:id` | Обновить / удалить |
| GET | `/api/customers` | Список клиентов |
| GET/PUT/DELETE | `/api/customers/:id` | Детали / обновление / удаление |
| PUT | `/api/customers/:id/status` | Бан / разбан |
| GET | `/api/orders` | Все заказы |
| PUT | `/api/orders/:id/status` | Изменить статус |
| DELETE | `/api/orders/:id` | Удалить |
| GET | `/api/payments` | Все платежи |
| POST | `/api/payments/:id/check` | Проверить через YooKassa |

### БД и уведомления (admin)

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/db/stats` | Статистика БД |
| POST | `/api/db/optimize` | VACUUM + integrity check |
| POST | `/api/db/cleanup` | Очистка |
| GET/POST | `/api/announcements` | Объявления |
| PUT/DELETE | `/api/announcements/:id` | Обновить / удалить |
| GET/POST | `/api/changelog` | Журнал обновлений |
| PUT/DELETE | `/api/changelog/:id` | Обновить / удалить |

### Клиентский API (`/api/client/...`)

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/auth/register` | Регистрация |
| POST | `/auth/login` | Вход |
| POST | `/auth/telegram` | Вход через Telegram |
| POST | `/auth/refresh` | Обновление JWT |
| POST | `/auth/logout` | Выход |
| POST | `/auth/forgot-password` | Сброс пароля |
| POST | `/auth/reset-password` | Новый пароль |
| GET | `/auth/verify-email` | Подтверждение email |
| GET | `/profile` | Данные профиля |
| PUT | `/profile` | Обновить имя |
| PUT | `/profile/password` | Сменить пароль |
| POST | `/profile/link-telegram` | Привязать Telegram |
| POST | `/profile/unlink-telegram` | Отвязать Telegram |
| GET | `/plans` | Тарифы |
| GET | `/locations` | Локации |
| GET/POST | `/orders` | Заказы |
| PUT | `/orders/:id/auto-renew` | Автопродление |
| GET | `/proxies` | Мои прокси |
| GET | `/proxies/:orderId/stats` | Статистика прокси |
| GET | `/proxies/:orderId/ping` | Пинг сервера (задержка в ms) |
| POST | `/payments/create` | Создать платёж YooKassa |
| GET | `/payments` | История платежей |
| GET | `/changelog` | Обновления |
| GET | `/announcements` | Объявления |
| POST | `/webhook/yookassa` | Webhook (IP-verified) |

### MTG Agent API (на ноде, порт 8081)

| Метод | URL | Заголовок | Описание |
|-------|-----|-----------|----------|
| GET | `/version` | — | Версия агента |
| GET | `/health` | — | Проверка доступности |
| GET | `/metrics` | `x-agent-token: TOKEN` | Метрики контейнеров |

---

## Переменные окружения

### Панель (`.env`)

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `AUTH_TOKEN` | Токен авторизации в админку | — (обязательно) |
| `PORT` | Порт панели | `3000` |
| `DATA_DIR` | Директория базы данных | `/data` |
| `JWT_SECRET` | Секрет для JWT токенов клиентов | — |
| `AGENT_TOKEN` | Токен для MTG Agent | `mtg-agent-secret` |
| `AGENT_PORT` | Порт агента | `8081` |
| `YOOKASSA_SHOP_ID` | ID магазина YooKassa | — |
| `YOOKASSA_SECRET_KEY` | Секретный ключ YooKassa | — |
| `SMTP_HOST` | SMTP хост | — |
| `SMTP_PORT` | SMTP порт | `465` |
| `SMTP_USER` | SMTP логин | — |
| `SMTP_PASS` | SMTP пароль | — |
| `SMTP_FROM` | Email отправителя | — |
| `SITE_URL` | URL сайта (для писем и ссылок) | — |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота | — |
| `TELEGRAM_BOT_USERNAME` | Username бота (без @) | — |

### Агент (`.env` в `/opt/mtg-agent/`)

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `AGENT_TOKEN` | Токен авторизации | `mtg-agent-secret` |

---

## Фоновые задачи

| Задача | Интервал | Описание |
|--------|----------|----------|
| `recordHistory` | 5 мин | Запись подключений, контроль лимита устройств, автосброс трафика |
| `cleanExpiredUsers` | 1 час | Удаление просроченных прокси-клиентов |
| `processAutoRenewals` | 1 час | Автопродление заказов |
| `checkPendingPayments` | 2 мин | Проверка pending-платежей через YooKassa |

---

## База данных

SQLite через `better-sqlite3`. 12 таблиц:

| Таблица | Описание |
|---------|----------|
| `nodes` | Серверы / ноды |
| `users` | Прокси-пользователи на нодах |
| `connections_history` | История подключений |
| `settings` | Настройки (key-value, TOTP) |
| `customers` | Клиенты (покупатели) |
| `plans` | Тарифные планы |
| `orders` | Заказы клиентов |
| `payments` | Платежи (YooKassa) |
| `sessions` | Refresh-токены клиентов |
| `changelog` | Журнал обновлений |
| `customer_changelog_seen` | Прочитанные версии |
| `announcements` | Объявления |
| `admin_users` | Администраторы (роли) |

---

## Обновление

### Быстро через скрипт

```bash
cd /opt/mtg-adminpanel
bash update.sh
```

### Вручную

```bash
cd /opt/mtg-adminpanel
git pull origin main
docker compose down && docker compose up -d --build
```

### Проверка обновлений

В админ-панели: кнопка **Версии** в боковом меню — показывает текущую и последнюю версию панели, MTG прокси и агента на каждой ноде. Обновления проверяются через GitHub Releases API.

---

## Changelog

### v2.2.0 (2026-03-18)
- Навигация на главную для авторизованных пользователей, кнопка «Личный кабинет» на лендинге
- Пинг серверов — отображение задержки (ms) в дашборде и детальной карточке прокси
- Новый API-эндпоинт `/proxies/:orderId/ping` — TCP-пинг до сервера
- Подтверждение заказа — модальное окно со сводкой перед оплатой
- Ссылка «Главная» в футере личного кабинета

### v2.1.0 (2026-03-18)
- Проверка обновлений панели, MTG прокси и агента через GitHub API
- Эндпоинты: `/api/check-updates`, `/api/nodes/:id/agent-version`
- Агент: `/version` эндпоинт
- Расширенный блок «Версии» в админ-панели
- Все URL перенесены на новый репозиторий

### v2.0.0 (2026-03-15)
- MTG Agent — HTTP агент на каждой ноде
- Лимит устройств с автостопом
- Автосброс трафика (день / месяц / год)
- Клиентский сайт: React + Vite + Tailwind
- Регистрация, авторизация (email / Telegram), JWT
- Тарифные планы, заказы, оплата через YooKassa
- Ролевая система: admin, moderator, support
- TOTP двухфакторная авторизация
- Дашборд с реальным временем (polling 15 сек)
- Управление БД: статистика, оптимизация, очистка
- Объявления для клиентов
- Changelog / журнал обновлений
- SEO + Open Graph мета-теги
- PWA: manifest.json, иконки, мобильная навигация
- Deploy скрипт v2.0: автоустановка, SSL, firewall

---

## Лицензия

MIT
