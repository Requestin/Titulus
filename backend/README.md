# backend/ — control plane API

Express + WS + SQLite. Auth, on-air, media, license, audit.

## Запуск

```bash
npm install
PORT=3002 TITULUS_DATA=/tmp/titulus-dev node src/index.js
```

Dev-стек: `./dev-start.sh` из корня репо.

Документация: `../docs/ARCHITECTURE.md`, `../docs/RUNBOOK.md`.
