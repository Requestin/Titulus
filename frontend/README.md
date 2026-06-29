# `frontend/` - React SPA (operator + editor shell)

Stack:

- React 18 + TypeScript 5
- Vite 5
- React Router 6
- Zustand + zundo
- Tailwind CSS 3
- `@dnd-kit` for rundown interactions

## Current routes

- `/login` - auth entry
- `/templates` - template list/CRUD entrypoint
- `/editor/:id` - WYSIWYG template editor
- `/control` - operator TAKE/UPDATE/CLEAR workflow
- `/settings` - admin-only channels/license/entitlements/audit
- `/renderer` - render surface (no app chrome)

## Notes

- Render logic is imported from `@runtime` (single source of truth with engine).
- Control WS connects with auth token to `/ws/control`.
- Settings route is role-guarded (`admin`).
