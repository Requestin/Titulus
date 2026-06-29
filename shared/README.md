# `shared/` — cross-package contracts

`template.schema.json` — JSON Schema for templates (AI-friendly + validated by
backend `/api/templates/validate`). Shared between `runtime/` (TS types in
`schema.ts` mirror this) and `backend/` (ajv validation).

Populated starting **Phase 1** (`feature/phase-1-runtime-schema`) and finalized
in **Phase 5** (AI-ready fields + stricter timeline/variable constraints).
