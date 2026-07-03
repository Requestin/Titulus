# Fix: persistent data directory `/var/lib/titulus`

> **Дата:** 3 июля 2026  
> **Ветка:** `sergey-v1`  
> **Коммит:** `fix db folder`

---

## Проблема

Шаблоны, настройки каналов и прочие данные control plane хранятся в SQLite (`app.db`) и папке `uploads/`. Ранее при запуске через `./dev-start.sh` backend использовал **`/tmp/titulus-dev`** — каталог в `/tmp` **очищается при перезагрузке**, из‑за чего пропадали все шаблоны и каналы.

При запуске `node src/index.js` без env дефолтом был **`<repo>/data/`** — данные сохранялись, но путь отличался от dev-скрипта.

---

## Решение

Единый persistent путь по умолчанию: **`/var/lib/titulus`**.

| Компонент | Путь |
|-----------|------|
| SQLite (templates, channels, rundowns, settings, on_air, users, license, audit…) | `/var/lib/titulus/app.db` |
| Загруженные медиа | `/var/lib/titulus/uploads/` |

Переопределение (тесты, CI): переменная окружения **`TITULUS_DATA`**.

---

## Изменённые файлы

| Файл | Изменение |
|------|-----------|
| `backend/src/index.js` | Default `DATA_DIR` → `/var/lib/titulus` (вместо `<repo>/data`) |
| `dev-start.sh` | `TITULUS_DATA` default → `/var/lib/titulus` (вместо `/tmp/titulus-dev`); подсказка при ошибке создания каталога |
| `start.sh` | Явный `TITULUS_DATA=/var/lib/titulus`, проверка/создание каталога перед стартом backend |

---

## Первичная настройка (один раз на машине)

```bash
sudo mkdir -p /var/lib/titulus/uploads
sudo chown $USER:$USER /var/lib/titulus
```

Перезапуск стека:

```bash
./dev-stop.sh && ./dev-start.sh
```

В логе backend:

```
[titulus-backend] db: /var/lib/titulus/app.db
```

---

## Миграция со старых путей (опционально)

**Из `/tmp/titulus-dev`** (данные до reboot, если файл ещё есть):

```bash
cp /tmp/titulus-dev/app.db /var/lib/titulus/app.db
cp -r /tmp/titulus-dev/uploads/* /var/lib/titulus/uploads/ 2>/dev/null || true
```

**Из `<repo>/data/`** (старый default без `TITULUS_DATA`):

```bash
cp data/app.db /var/lib/titulus/app.db
cp -r data/uploads/* /var/lib/titulus/uploads/ 2>/dev/null || true
```

---

## Что не в git

`app.db` и `uploads/` по-прежнему в `.gitignore` — данные **не коммитятся** в репозиторий. Бэкап — копирование `/var/lib/titulus/`.

---

## Проверка

- [ ] `ls -la /var/lib/titulus/` — есть `app.db`, `uploads/`
- [ ] Создать шаблон и канал в UI → перезагрузка машины → данные на месте
- [ ] `curl -s http://127.0.0.1:3002/api/health` (или ваш BE port) — backend жив
