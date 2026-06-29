# Titulus

Titulus is a proprietary cloud/on-prem broadcast graphics system:

- **Control plane**: React editor, operator control UI, channels/rundowns/settings, REST + WebSocket.
- **Render plane**: `bg_engine` (C++20 + CEF OSR), CasparCG-aligned producer->mixer->consumer model.
- **Runtime contract**: one shared `@titulus/runtime` implementation for editor and on-air rendering (WYSIWYG).

## Current Status

- Phase 0-5: done.
- Phase 6.1-6.3: done (license foundation, auth/RBAC, billing + audit baseline).
- Phase 6.4: handoff-ready, waiting final hardware execution on DeckLink + genlock host.
- Phase 7: documentation/rules consolidation + historical report delivered.

## Quick Start (Dev)

```bash
./dev-start.sh
```

Default local endpoints:

- Frontend: `http://127.0.0.1:3011`
- Backend: `http://127.0.0.1:3002`

Default auth bootstrap:

- username: `admin`
- password: `admin123`

Stop:

```bash
./dev-stop.sh
```

## Key Docs

- `DEVELOPMENT_PROMPT.md` - canonical product/engineering spec.
- `docs/ARCHITECTURE.md` - up-to-date architecture overview.
- `docs/RUNBOOK.md` - setup/operations/run procedures.
- `docs/phase6-decklink-validation-closure.md` - Phase 6.4 hardware acceptance handoff.
- `docs/PHASE_REPORT_PHASE1_TO_PHASE7.md` - detailed historical report from Phase 1 onward.
- `.cursor/rules/10-development-plan.mdc` - current phase plan and next actions.

## License

Proprietary software. All rights reserved.  
(c) 2026 Karen Darchiniants. Not open source.

For licensing inquiries: [k.darchiniants@gyhyry.com]
