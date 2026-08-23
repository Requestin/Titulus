# Развёртывание DeckLink-тестового сервера

Этот документ описывает **чистое** развёртывание текущего `main` на новом
Ubuntu-сервере с картой DeckLink. Результат — отдельный тестовый стенд с пустой
SQLite-базой, UI для тестеров через HTTPS и DeckLink-каналами с актуальным
визуальным pacing `one_tick`.

Документ не переносит шаблоны, пользователей, media uploads, CEF cache,
`engine/build` или `/tmp` со старого сервера. Если требуется перенести
состояние, это отдельная миграция, а не шаги ниже.

Если сервер уже работает на очень старой версии Titulus (примерно Phase 10–12)
и его состояние можно заменить пустым, сначала выполните
[UPGRADE_FROM_PHASE_10_12_FRESH.md](UPGRADE_FROM_PHASE_10_12_FRESH.md).
Он безопасно архивирует и отключает legacy stack перед шагами этого документа.

## 0. Что именно будет развёрнуто

| Компонент | Роль |
|---|---|
| `frontend` | Vite UI на `127.0.0.1:3011` |
| `backend` | API, WebSocket, SQLite и uploads на `127.0.0.1:3002` |
| `runtime` | Сборка `backend/public/bg-runtime.js` для channel page |
| `bg_engine` | Один CEF/DeckLink process на сохранённый channel |
| Nginx | Единственная публичная точка входа на 80/443 |
| systemd `titulus.service` | Запускает и штатно останавливает текущие `dev-start.sh` / `dev-stop.sh` |

Используйте только:

```text
dev-start.sh → run-engines.sh → run-channel.sh → bg_engine
```

Не используйте корневые `start.sh` / `stop.sh`: это устаревшие entrypoint'ы с
другими портами и без полного engine supervisor.

### Обязательные условия

- Ubuntu 24.04+ x86_64.
- Карта DeckLink, кабель Reference In и подключение SDI согласно модели карты.
- Не менее двух физических CPU-ядер на каждый одновременно работающий
  DeckLink-channel; для трёх каналов — не менее шести физических ядер.
- Доступ администратора к серверу, DNS-имя и TCP 80/443, если тестеры будут
  подключаться через интернет.
- Blackmagic Desktop Video **16.0** и DeckLink SDK **16.0** — версия,
  использованная текущим проверенным стендом.

> DeckLink SDK и Desktop Video не входят в Git: их лицензии и бинарные файлы
> намеренно не хранятся в репозитории.

## 1. Зафиксировать версию перед началом

Все команды ниже выполняйте из-под отдельного Unix-пользователя `titulus`,
кроме явно помеченных `sudo`.

Создайте пользователя, каталоги и постоянные data/cache пути:

```bash
sudo adduser --disabled-password --gecos "" titulus
sudo install -d -o titulus -g titulus -m 0750 /opt/titulus /var/lib/titulus
sudo install -d -o titulus -g titulus -m 0750 /var/cache/titulus/engines
sudo install -d -o root -g titulus -m 0750 /etc/titulus
```

Клонируйте `main`, сохраните точный SHA, затем работайте только с ним:

```bash
sudo -iu titulus
cd /opt/titulus
git clone https://github.com/Requestin/Titulus.git
cd Titulus
git fetch origin
DEPLOY_SHA="$(git rev-parse origin/main)"
git checkout --detach "$DEPLOY_SHA"
printf '%s\n' "$DEPLOY_SHA" | tee DEPLOYED_GIT_SHA
git status --short --branch
```

`DEPLOYED_GIT_SHA` — запись того, что реально запущено. Не используйте
непроверенную ветку, локальные изменения или старую рабочую копию другого
сервера.

## 2. Установить системные зависимости

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl jq ripgrep openssl ca-certificates ffmpeg python3 \
  build-essential cmake pkg-config \
  libx11-dev libxcomposite-dev libxdamage-dev libxrandr-dev libxext-dev \
  libglib2.0-dev libnss3-dev libatk1.0-dev libatk-bridge2.0-dev libcups2-dev \
  libxkbcommon-dev libdrm-dev \
  libgtk-3-0 libgbm1 libasound2t64 libpango-1.0-0 libxfixes3 libatspi2.0-0 \
  nginx certbot python3-certbot-nginx
```

Установите Node.js 20 для пользователя `titulus`. Проект документирует nvm:

```bash
sudo -iu titulus
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 20
nvm alias default 20
nvm use 20
node --version
npm --version
```

Проверьте кодеки, нужные video ingest и stream consumer:

```bash
ffmpeg -encoders 2>/dev/null | rg 'libvpx-vp9|libx264'
```

Обе строки должны быть найдены. `libvpx-vp9` нужен для ingest-видео,
`libx264` — для stream-channel.

## 3. Установить Desktop Video и DeckLink SDK

1. Скачайте с сайта Blackmagic Design Linux `.deb` Desktop Video 16.0 для
   используемой модели карты.
2. Установите скачанный пакет (замените путь фактическим именем файла):

```bash
sudo apt install /path/to/Desktop_Video_16.0*.deb
```

   Если `apt` сообщит о недостающих зависимостях, исправьте их через
   `sudo apt -f install`, затем повторите установку.
3. Перезагрузите сервер, если установщик/DKMS этого требует.
4. При включённом Secure Boot завершите MOK enrollment на консоли при первой
   перезагрузке. Не переходите дальше, пока модуль драйвера не загружен.
5. Распакуйте DeckLink SDK 16.0, например в
   `/opt/blackmagic/DeckLinkSDK`, и сделайте его доступным на чтение:

```bash
sudo install -d -m 0755 /opt/blackmagic
sudo chown -R root:root /opt/blackmagic/DeckLinkSDK
test -f /opt/blackmagic/DeckLinkSDK/Linux/include/DeckLinkAPI.h
```

Проверки драйвера и runtime library:

```bash
lsmod | rg -i 'blackmagic|decklink'
ldconfig -p | rg 'libDeckLinkAPI\.so'
```

Также убедитесь в Desktop Video Setup или Media Express, что карта видна,
прошивка совместима, назначение коннекторов сохранено, а для genlock-сценария
подан reference signal. CMake использует только SDK header на build-этапе;
`libDeckLinkAPI.so` находится во время работы через `dlopen`.

## 4. Установить JavaScript зависимости и собрать runtime

```bash
sudo -iu titulus
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20
cd /opt/titulus/Titulus

(cd runtime && npm ci && npm run build)
(cd backend && npm ci)
(cd frontend && npm ci)

test -s backend/public/bg-runtime.js
```

`backend/public/bg-runtime.js` создаётся из `runtime` и намеренно не хранится
в Git. Без него Program Monitor и `channel.html` не соответствуют текущему
runtime.

## 5. Собрать CEF и DeckLink engine детерминированно

Текущий проверенный стенд использует CEF archive:

```text
cef_binary_151.3.16+gbe1e15d+chromium-151.0.7922.109_linux64_minimal.tar.bz2
```

`fetch-cef.sh` по умолчанию выбирает latest stable. Для воспроизводимого
развёртывания **обязательно** передайте зафиксированное имя через
`TITULUS_CEF_ARCHIVE`; скрипт возьмёт SHA-1 из официального CEF index и
проверит скачанный архив.

```bash
sudo -iu titulus
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20
cd /opt/titulus/Titulus

rm -rf engine/build engine/third_party/cef
export TITULUS_CEF_ARCHIVE='cef_binary_151.3.16+gbe1e15d+chromium-151.0.7922.109_linux64_minimal.tar.bz2'
./engine/third_party/fetch-cef.sh
test "$(awk 'NR == 1 { print; exit }' engine/third_party/cef/.cef_fetched)" = "$TITULUS_CEF_ARCHIVE"

cmake -S engine -B engine/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE=/opt/blackmagic/DeckLinkSDK/Linux/include \
  | tee /tmp/titulus-cmake.log
rg 'DeckLink consumer ENABLED' /tmp/titulus-cmake.log

cmake --build engine/build -j"$(nproc)"
test -x engine/build/Release/bg_engine
engine/build/Release/bg_engine --help | rg 'consumer=.*decklink'
```

Не заменяйте эти шаги копированием `engine/build`, CEF runtime или CEF cache с
другого хоста. Проверяйте, что build log содержит `DeckLink consumer ENABLED`;
иначе binary будет работать для browser/null, но не сможет открыть SDI-output.

## 6. Создать постоянную конфигурацию

`/tmp/titulus-dev` — default удобный для локальной разработки, но не для
сервера: `/tmp` может очищаться при reboot. Создайте env-файл **до первого
старта** базы:

```bash
sudo tee /etc/titulus/titulus.env >/dev/null <<'EOF'
TITULUS_HOST=127.0.0.1
TITULUS_CONNECT_HOST=127.0.0.1
TITULUS_FE_PORT=3011
TITULUS_BE_PORT=3002
TITULUS_DATA=/var/lib/titulus
CACHE_ROOT=/var/cache/titulus/engines
ENGINE_BIN=/opt/titulus/Titulus/engine/build/Release/bg_engine

# Replace both placeholders with the same newly generated strong password
# before the first start. Keep this file readable only by root:titulus.
TITULUS_ADMIN_USER=admin
TITULUS_ADMIN_PASSWORD=REPLACE_WITH_A_NEW_PASSWORD
TITULUS_API_USER=admin
TITULUS_API_PASSWORD=REPLACE_WITH_A_NEW_PASSWORD

# Phase 20 visual deployment default. Do not set accumulator here.
TITULUS_DEV_PACING_MODE=one_tick
TITULUS_PACING_MODE=one_tick

# Extra filesystem roots for /api/files. Default empty: only
# $TITULUS_DATA/data-files is readable/writable.
# TITULUS_FILE_ROOTS=
EOF
sudo chown root:titulus /etc/titulus/titulus.env
sudo chmod 0640 /etc/titulus/titulus.env
```

Сгенерируйте пароль локально и замените оба placeholder до продолжения:

```bash
openssl rand -base64 36
sudoedit /etc/titulus/titulus.env
```

Bootstrap password применяется только если в новой БД ещё нет admin. Смена
`TITULUS_ADMIN_PASSWORD` после первого запуска не меняет существующего
пользователя.

## 7. Nginx и firewall

Не публикуйте 3011 и 3002 в интернет. Nginx должен быть единственной внешней
точкой входа. Замените `titulus.example.net` на настоящее DNS-имя:

```nginx
# /etc/nginx/sites-available/titulus-test
server {
    listen 80;
    server_name titulus.example.net;
    client_max_body_size 200M;

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }

    location /uploads/ { proxy_pass http://127.0.0.1:3002; }
    location /thumbnails/ { proxy_pass http://127.0.0.1:3002; }
    location /fonts/ { proxy_pass http://127.0.0.1:3002; }
    location = /channel.html { proxy_pass http://127.0.0.1:3002; }
    location = /bg-runtime.js { proxy_pass http://127.0.0.1:3002; }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/titulus-test /etc/nginx/sites-enabled/titulus-test
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo certbot --nginx -d titulus.example.net
```

Для закрытого LAN без DNS/TLS допускается временно открыть `3011/tcp`; не
открывайте `3002/tcp`, если browser source не должен обращаться к backend
напрямую. Готовый `ops/nginx/graphics.gyhyry.com.conf` привязан к чужому
домену и Let’s Encrypt paths, поэтому не копируйте его как есть.

## 8. Установить systemd wrapper

В репозитории нет готового production systemd unit. Следующий минимальный
wrapper использует поддерживаемые entrypoint'ы, сохраняет текущую топологию и
позволяет штатно завершить всю process group engines.

```bash
sudo install -d -m 0755 /usr/local/lib/titulus
sudo tee /usr/local/lib/titulus/start.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR=/home/titulus/.nvm
. "$NVM_DIR/nvm.sh"
nvm use 20 >/dev/null
exec /opt/titulus/Titulus/dev-start.sh
EOF
sudo chmod 0755 /usr/local/lib/titulus/start.sh

sudo tee /etc/systemd/system/titulus.service >/dev/null <<'EOF'
[Unit]
Description=Titulus DeckLink test stack
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=titulus
Group=titulus
WorkingDirectory=/opt/titulus/Titulus
EnvironmentFile=/etc/titulus/titulus.env
ExecStart=/usr/local/lib/titulus/start.sh
ExecStop=/opt/titulus/Titulus/dev-stop.sh
RemainAfterExit=yes
TimeoutStartSec=15min
TimeoutStopSec=90s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now titulus.service
```

`Type=oneshot` отражает текущий `dev-start.sh`: он создаёт backend, Vite и
engine supervisor в своей cgroup и затем завершается. После любого
неожиданного process crash проверяйте логи и выполняйте
`sudo systemctl restart titulus`; это тестовый deployment, не HA supervisor.

## 9. Первый запуск с пустой базой

Проверки сервиса:

```bash
sudo systemctl status titulus --no-pager
curl -sf http://127.0.0.1:3002/api/health | jq
test -s /var/lib/titulus/app.db
test -s /opt/titulus/Titulus/backend/public/bg-runtime.js
sudo -u titulus test -w /var/lib/titulus/uploads
sudo -u titulus mkdir -p /var/lib/titulus/data-files /var/lib/titulus/thumbnails
sudo -u titulus test -w /var/lib/titulus/data-files
sudo -u titulus test -w /var/lib/titulus/thumbnails
```

Откройте `https://titulus.example.net`, войдите под
`TITULUS_ADMIN_USER`/`TITULUS_ADMIN_PASSWORD` и в Settings создайте нужные
DeckLink channels. Для каждого проверьте:

- `output_mode=decklink`;
- назначенный для этой карты `device_index`;
- нужный `display_mode` (на текущем стенде — `HD1080i50`);
- требуемый keyer mode;
- соответствие физической SDI-схеме в Desktop Video Setup.

На первом boot `run-engines.sh` увидит ноль channels и корректно завершится.
После сохранения channels выполните **полный** controlled restart, чтобы
supervisor считал новую конфигурацию:

```bash
sudo systemctl restart titulus
```

Не запускайте второй `run-engines.sh` вручную поверх уже работающего сервиса.

## 10. Обязательный acceptance gate: one_tick и DeckLink

После создания channels остановите старый supervisor и убедитесь, что не
осталось его дочерних processes:

```bash
sudo systemctl stop titulus
pgrep -af 'bg_engine|run-channel|run-engines' || true
sudo systemctl start titulus
```

После старта ожидается один `run-engines.sh`, один
`run-channel.sh` и один `bg_engine` на каждый созданный channel. Проверьте
точный visual-pacing:

```bash
cd /opt/titulus/Titulus
rg -n 'pacing=one_tick' logs/engine-*.log
pgrep -af bg_engine | rg 'pacing_mode=one_tick'
```

Обе проверки обязательны для DeckLink-channel. `dev-start.sh` передаёт
`TITULUS_DEV_PACING_MODE=one_tick` в `TITULUS_PACING_MODE`, а
`run-channel.sh` добавляет `pacing_mode=one_tick` в его `channel.html` URL.

Если нужно выполнить dry-run supervisor отдельно, всегда указывайте pacing
явно:

```bash
sudo -u titulus env \
  BACKEND_URL=http://127.0.0.1:3002 \
  ENGINE_BIN=/opt/titulus/Titulus/engine/build/Release/bg_engine \
  CACHE_ROOT=/var/cache/titulus/engines \
  TITULUS_API_USER=admin \
  TITULUS_API_PASSWORD='PASSWORD_FROM_ENV_FILE' \
  TITULUS_PACING_MODE=one_tick \
  /opt/titulus/Titulus/engine/run-engines.sh --dry-run
```

Не запускайте `run-engines.sh` без `TITULUS_PACING_MODE=one_tick`: его
fallback — `accumulator`. Также не добавляйте research-only flags
`--decklink-token-armed-wait`, `--decklink-absolute-field-grid` или
`--decklink-one-pair-reservoir`; они не являются default current deployment.

Проверьте DeckLink log:

```bash
rg -n 'reference signal locked|telemetry .*late=0.*dropped=0.*flushed=0' logs/engine-*.log
```

При отсутствии `reference signal locked`, ненулевых `late`, `dropped` или
`flushed`, либо при отсутствии `pacing_mode=one_tick` остановитесь и исправьте
hardware/configuration до начала тестов.

## 11. Дать доступ тестерам

Тестеры используют только URL Nginx:

```text
https://titulus.example.net
```

Создайте отдельные учётные записи через admin UI; не раздавайте bootstrap
пароль. Перед внешним тестированием проверьте:

1. login/logout и WebSocket status;
2. создание template и editor drag/resize;
3. upload изображения и видео; video job должен перейти в `ready`;
4. Program Monitor и TAKE/RUNDOWN;
5. SDI на физическом мониторе и отсутствие DeckLink telemetry errors.

## 12. Остановка, логи, update и rollback

Штатная остановка:

```bash
sudo systemctl stop titulus
pgrep -af 'bg_engine|run-channel|run-engines' || true
```

`dev-stop.sh` останавливает process group supervisor и затем дочерние
`run-channel.sh`/`bg_engine`. Не останавливайте только `bg_engine`: supervisor
перезапустит его.

Логи:

```bash
cd /opt/titulus/Titulus
tail -f logs/backend.log logs/frontend.log logs/engines.log
tail -f logs/engine-*.log
journalctl -u titulus -f
```

Backup пустого/тестового state делайте только при остановленном сервисе:

```bash
sudo systemctl stop titulus
sudo tar -C /var/lib -czf "/var/backups/titulus-$(date +%F-%H%M%S).tgz" titulus
sudo systemctl start titulus
```

Update на новый проверенный SHA:

```bash
sudo systemctl stop titulus
sudo -iu titulus
cd /opt/titulus/Titulus
PREVIOUS_SHA="$(git rev-parse HEAD)"
git fetch origin
NEXT_SHA="$(git rev-parse origin/main)"
git checkout --detach "$NEXT_SHA"
printf '%s\n' "$NEXT_SHA" | tee DEPLOYED_GIT_SHA

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20
(cd runtime && npm ci && npm run build)
(cd backend && npm ci)
(cd frontend && npm ci)
```

Если менялись `engine/`, CEF version или DeckLink integration, повторите чистую
сборку из раздела 5. Затем выйдите из shell и выполните:

```bash
sudo systemctl start titulus
```

Rollback — тот же порядок с `git checkout --detach "$PREVIOUS_SHA"`, затем
runtime build и, если менялся engine, его rebuild. Не используйте
`git reset --hard` для deployed копии.

## 13. Troubleshooting

| Симптом | Проверка и действие |
|---|---|
| UI/API не открывается | `systemctl status titulus`, health URL, `logs/backend.log`, `logs/frontend.log` |
| Engine не запускается | `logs/engines.log`, `logs/engine-*.log`, путь `ENGINE_BIN`, наличие channels |
| DeckLink unavailable | Desktop Video Setup, `lsmod`, `ldconfig`, CMake `DeckLink consumer ENABLED`, отсутствие второго владельца карты |
| `accumulator` или нет `pacing_mode=one_tick` | Проверить `/etc/titulus/titulus.env`, остановить сервис, затем restart; не стартовать bare `run-engines.sh` |
| Video upload failed | `ffmpeg -encoders`, `logs/backend.log`, свободное место в `/var/lib/titulus/uploads` |
| 401 для engine supervisor | Сверить `TITULUS_API_USER`/`TITULUS_API_PASSWORD` с созданным admin; после смены пароля обновить оба |
| Port already in use | `ss -ltnp | rg ':3011|:3002'`, затем `sudo systemctl stop titulus`; не использовать `pkill -f 'PORT=…'` |
| Engine возвращается после kill | Остановить `titulus.service`, а не только `bg_engine` |
| Nginx certificate error | Проверить DNS, `sudo nginx -t`, `journalctl -u nginx`, затем повторить certbot |

## 14. Почему здесь нет accumulator

`accumulator` сохраняется в коде и P20 research harness для исторических A/B
измерений. Для визуального DeckLink-тестового стенда он не является
приемлемым default: может давать `(2,0)` logical cadence. Поэтому этот guide
фиксирует `one_tick` в environment, service запуске и acceptance gate.
