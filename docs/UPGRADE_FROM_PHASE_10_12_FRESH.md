# Замена сервера Phase 10–12 на current main без миграции данных

Этот документ предназначен для сервера со старой установкой Titulus примерно
эпохи Phase 10–12. Он **не обновляет старую рабочую копию на месте** и не
переносит её SQLite-базу, шаблоны, uploads, CEF cache или engine build.

Вместо этого процедура:

```text
заархивировать старый стенд → остановить его дерево процессов →
развернуть рядом чистый current main → проверить новый стек →
переключить Nginx → оставить старый стенд как rollback
```

Это исключает смешение ABI CEF, старых `node_modules`, старого
`bg-runtime.js`, SQLite-схем и legacy pacing.

Полный bootstrap нового DeckLink-хоста описан в
[DEPLOYMENT_DECKLINK_TEST_SERVER.md](DEPLOYMENT_DECKLINK_TEST_SERVER.md).
Этот документ добавляет к нему безопасную замену **существующего** старого
стенда и покрывает browser, stream и DeckLink modes.

## 1. Что изменилось после старого стенда

| Старый путь | Current path |
|---|---|
| `start.sh` / `stop.sh` | `dev-start.sh` / `dev-stop.sh` |
| frontend `:3000`, backend `:3001` | frontend `:3011`, backend `:3002` |
| engine запускался отдельно или вручную | `dev-start.sh → run-engines.sh → run-channel.sh → bg_engine` |
| произвольный CEF/build/cache | чистая CEF/engine сборка с закреплённым archive |
| `accumulator` мог включиться по default | DeckLink visual deployment фиксирует `one_tick` |

Не используйте `git pull` в старом дереве. Не копируйте из него
`node_modules`, `engine/build`, `engine/third_party/cef`, `backend/public`,
`data`, `/tmp/titulus-*` или CEF cache в новую установку.

## 2. Граница операции и rollback decision

Перед началом подтвердите:

- старые templates, rundowns, users, channels и uploads **не** мигрируются;
- на новом серверном stack будет пустая SQLite-база и новый admin;
- старые SDI connector assignments записаны или сфотографированы в Desktop
  Video Setup;
- у вас есть локальный доступ к серверу на случай Desktop Video/MOK reboot;
- старый стенд не будет удалён до завершения согласованного тестового периода.

Если нужно сохранить старые данные, остановитесь: это другая операция миграции,
а не этот guide.

## 3. Инвентаризация старого стенда

Запишите пути, процессы и сетевую конфигурацию **до** остановки. Подставьте
фактический путь старой установки и при необходимости path её data:

```bash
export OLD_ROOT=/home/old-user/Titulus
export OLD_DATA=/tmp/titulus-dev
export BACKUP_DIR="/var/backups/titulus-phase10-12-$(date +%F-%H%M%S)"

sudo install -d -m 0700 "$BACKUP_DIR"
git -C "$OLD_ROOT" rev-parse HEAD 2>/dev/null | sudo tee "$BACKUP_DIR/old-git-sha.txt"
git -C "$OLD_ROOT" status --short 2>/dev/null | sudo tee "$BACKUP_DIR/old-git-status.txt"
pgrep -af 'start\.sh|dev-start|run-engines|run-channel|bg_engine|vite|node src/index' \
  | sudo tee "$BACKUP_DIR/processes-before.txt"
ss -ltnp | rg ':(3000|3001|3011|3012|3002|3003|80|443|9222)\b' \
  | sudo tee "$BACKUP_DIR/listeners-before.txt"
```

Сохраните configuration и старое дерево как rollback evidence:

```bash
sudo tar -czf "$BACKUP_DIR/old-tree.tgz" "$OLD_ROOT"
sudo cp -a /etc/nginx/sites-available "$BACKUP_DIR/nginx-sites-available" 2>/dev/null || true
sudo cp -a /etc/nginx/sites-enabled "$BACKUP_DIR/nginx-sites-enabled" 2>/dev/null || true
sudo systemctl list-unit-files | rg -i 'titulus|nginx' \
  | sudo tee "$BACKUP_DIR/systemd-units.txt"
```

Если `OLD_DATA` существует, архивируйте его только как cold backup. Новый
stack его не читает:

```bash
test -d "$OLD_DATA" && sudo tar -czf "$BACKUP_DIR/old-data.tgz" "$OLD_DATA"
sudo chmod -R go-rwx "$BACKUP_DIR"
```

Не архивируйте SDK/license credentials в общедоступное место. Сохраните версию
Desktop Video/SDK, CEF archive и схему физического SDI-подключения отдельно в
защищённом operational record.

## 4. Штатно остановить старый stack

Сначала остановите известный service, если он существует:

```bash
sudo systemctl stop titulus.service 2>/dev/null || true
```

Затем используйте script **той копии**, из которой старый stack был запущен:

```bash
if test -x "$OLD_ROOT/dev-stop.sh"; then
  (cd "$OLD_ROOT" && ./dev-stop.sh)
fi

# Legacy `start.sh` era: только :3000/:3001, без engine supervisor.
if test -x "$OLD_ROOT/stop.sh"; then
  (cd "$OLD_ROOT" && ./stop.sh)
fi
```

Проверьте состояние. Особо внимательно смотрите на supervisor-дерево:

```bash
pgrep -af 'run-engines|run-channel|bg_engine' || true
ss -ltnp | rg ':(3000|3001|3011|3012|3002|3003|9222)\b' || true
```

Если процессы остались, сначала определите их точный command line и
принадлежность старому `$OLD_ROOT`. Останавливайте в таком порядке:

1. PID `run-engines.sh`;
2. оставшиеся PID `run-channel.sh`;
3. оставшиеся PID `bg_engine`;
4. backend/frontend по PID слушателя, полученному из `ss -ltnp`.

Используйте `kill <pid>` только после этой проверки. Не применяйте
`pkill -f 'PORT=…'`, не убивайте только `bg_engine` и не трогайте чужой
DeckLink process: `run-channel.sh` может перезапустить engine примерно через
три секунды.

До запуска новой установки это должно ничего не вывести:

```bash
pgrep -af 'run-engines|run-channel|bg_engine' || true
```

Если требуется SDI rollback, не меняйте Desktop Video connector profile до
завершения проверки нового stack.

## 5. Развернуть чистый current main рядом

Создайте изолированные current paths. Не переиспользуйте `$OLD_ROOT`,
`$OLD_DATA` или старый cache:

```bash
sudo adduser --disabled-password --gecos "" titulus
sudo install -d -o titulus -g titulus -m 0750 /opt/titulus /var/lib/titulus
sudo install -d -o titulus -g titulus -m 0750 /var/cache/titulus/engines
sudo install -d -o root -g titulus -m 0750 /etc/titulus

sudo -iu titulus
cd /opt/titulus
git clone https://github.com/Requestin/Titulus.git
cd Titulus
git fetch origin
DEPLOY_SHA="$(git rev-parse origin/main)"
git checkout --detach "$DEPLOY_SHA"
printf '%s\n' "$DEPLOY_SHA" | tee DEPLOYED_GIT_SHA
```

Точный SHA из `DEPLOYED_GIT_SHA` — единственная версия, которую следует
диагностировать и откатывать. Не разворачивайте непроверенную branch или
грязную локальную копию.

## 6. Пересобрать все generated artifacts

На старом сервере Phase 10–12 обязательно пересобираются:

| Артефакт | Действие |
|---|---|
| Node dependencies | `npm ci` для `runtime`, `backend`, `frontend` |
| Runtime bundle | `runtime npm run build` → `backend/public/bg-runtime.js` |
| CEF | скачать current закреплённый archive заново |
| Engine + CEF resources | новая CMake Release build |
| SQLite/data | новая `/var/lib/titulus`, не старая БД |
| Engine cache | новая `/var/cache/titulus/engines`, не `/tmp/titulus-engines` |
| systemd/Nginx | current config с 3011/3002, не legacy 3000/3001 |

Следуйте разделам 2–5
[DEPLOYMENT_DECKLINK_TEST_SERVER.md](DEPLOYMENT_DECKLINK_TEST_SERVER.md):

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

### CEF и engine

Не используйте latest CEF implicit selection и не копируйте старую CEF tree.
Current deployment pins:

```bash
export TITULUS_CEF_ARCHIVE='cef_binary_151.3.16+gbe1e15d+chromium-151.0.7922.109_linux64_minimal.tar.bz2'
rm -rf engine/build engine/third_party/cef
./engine/third_party/fetch-cef.sh
```

Для browser/stream host соберите engine без DeckLink SDK:

```bash
cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build engine/build -j"$(nproc)"
```

Для DeckLink host сначала установите Desktop Video 16.0 и DeckLink SDK 16.0,
затем собирайте именно так:

```bash
cmake -S engine -B engine/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBG_ENABLE_DECKLINK=ON \
  -DDECKLINK_SDK_INCLUDE=/opt/blackmagic/DeckLinkSDK/Linux/include \
  | tee /tmp/titulus-cmake.log
rg 'DeckLink consumer ENABLED' /tmp/titulus-cmake.log
cmake --build engine/build -j"$(nproc)"
```

Для stream mode также проверьте `ffmpeg`:

```bash
ffmpeg -encoders 2>/dev/null | rg 'libvpx-vp9|libx264'
```

Подробные OS packages, Node 20, Secure Boot/MOK, driver/SDK, Nginx и systemd
steps находятся в fresh deployment guide. Они обязательны и для замены
старого server.

## 7. Создать новую конфигурацию и переключить proxy

Создайте `/etc/titulus/titulus.env` и `titulus.service` из разделов 6 и 8
fresh deployment guide. Для любого current host обязательны:

```text
TITULUS_HOST=127.0.0.1
TITULUS_CONNECT_HOST=127.0.0.1
TITULUS_FE_PORT=3011
TITULUS_BE_PORT=3002
TITULUS_DATA=/var/lib/titulus
CACHE_ROOT=/var/cache/titulus/engines
TITULUS_DEV_PACING_MODE=one_tick
TITULUS_PACING_MODE=one_tick
```

Задайте новый admin/API password до первого start новой пустой базы. Не
используйте старые password, token или sessions.

Проверьте Nginx до переключения:

```text
/                    → 127.0.0.1:3011
/api/, /ws           → 127.0.0.1:3002
/uploads/, /fonts/   → 127.0.0.1:3002
/channel.html        → 127.0.0.1:3002
/bg-runtime.js       → 127.0.0.1:3002
```

Не оставляйте active proxy на `:3000`/`:3001`. Не публикуйте 3011 или 3002
напрямую в интернет. Current Nginx/systemd snippets приведены в fresh
deployment guide.

## 8. Первый boot и конфигурация channels

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now titulus.service
sudo systemctl status titulus.service --no-pager
curl -sf http://127.0.0.1:3002/api/health | jq
test -s /var/lib/titulus/app.db
```

В новом UI создайте channels заново:

- browser/OBS: `output_mode=browser` или `obs_vmix`;
- stream: `output_mode=stream` и новый `stream_url`;
- DeckLink: `output_mode=decklink`, корректные `device_index`,
  `display_mode`, keyer и physical SDI wiring.

Первый запуск с пустой БД обычно не находит channels. После их сохранения
выполните controlled restart:

```bash
sudo systemctl restart titulus.service
```

Не запускайте второй `run-engines.sh` поверх `titulus.service`.

## 9. Current acceptance gate

Общие проверки:

```bash
pgrep -af 'run-engines|run-channel|bg_engine'
curl -sf http://127.0.0.1:3002/api/health | jq
test -s /opt/titulus/Titulus/backend/public/bg-runtime.js
```

Проверьте UI: login, WebSocket status, template editor, image/video upload,
Program Monitor и rundown/TAKE.

### Browser и stream

Browser/stream channels используют self-timer/rAF и намеренно не получают
`pacing_mode=one_tick` в URL. Для stream дополнительно проверьте listener,
stream URL и firewall. Не интерпретируйте отсутствие `pacing_mode=one_tick`
как ошибку для этих output modes.

### DeckLink

DeckLink visual path обязан использовать `one_tick`:

```bash
cd /opt/titulus/Titulus
rg -n 'pacing=one_tick' logs/engine-*.log
pgrep -af bg_engine | rg 'pacing_mode=one_tick'
rg -n 'reference signal locked|telemetry .*late=0.*dropped=0.*flushed=0' logs/engine-*.log
```

Не запускайте bare `run-engines.sh` без `TITULUS_PACING_MODE=one_tick`: его
fallback — `accumulator`. Не используйте P20 research harness или
`--decklink-token-armed-wait`, `--decklink-absolute-field-grid`,
`--decklink-one-pair-reservoir` как deployment defaults.

## 10. Переключение тестеров и rollback

Включайте Nginx site/current DNS только после успешных checks из раздела 9.
До этого Nginx может оставаться на старом upstream, а новый stack проверяется
локально.

Если новый stack не проходит acceptance:

1. `sudo systemctl stop titulus.service`;
2. убедитесь, что `pgrep -af 'run-engines|run-channel|bg_engine'` пуст;
3. восстановите Nginx site из `$BACKUP_DIR`;
4. верните старый Desktop Video connector profile, если его меняли;
5. запустите archived старый tree прежним известным способом;
6. проверьте его старые ports (`3000/3001` либо `3011/3002`) и SDI.

После current acceptance оставьте `$BACKUP_DIR` и старую рабочую копию
read-only на согласованный период. Их окончательное удаление — отдельное
ручное решение владельца, не автоматический шаг этого guide.

## 11. Краткая таблица ловушек

| Неправильно | Почему | Правильно |
|---|---|---|
| `git pull` в старом tree | смешивает старый build/cache/data с новым кодом | fresh clone + detached current SHA |
| `start.sh` / `stop.sh` | legacy 3000/3001, engines отдельно | `dev-start.sh` / `dev-stop.sh` через systemd |
| Только kill `bg_engine` | supervisor его вернёт | остановить supervisor tree |
| `pkill -f 'PORT=…'` | может затронуть чужие процессы | `ss -ltnp` → проверить → точный PID |
| Старый `node_modules`/CEF/build/cache | несовместимость native/CEF/runtime | fresh `npm ci`, CEF pin, CMake build, new cache |
| Старый `bg-runtime.js` | channel page не соответствует runtime | `runtime npm run build` |
| Proxy на 3000/3001 | current UI/API не достигнуты | 3011/3002 |
| `/tmp/titulus-dev` как data | очистится при reboot | `/var/lib/titulus` |
| Bare `run-engines.sh` | defaults 3001/accumulator | `dev-start.sh` + explicit one_tick |
| P20 research flags в service | не verified deployment default | обычный `one_tick` path |
