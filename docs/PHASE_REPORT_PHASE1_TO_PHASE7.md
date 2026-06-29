# Titulus Detailed Delivery Report (Phase 1 -> Phase 7)

This report captures the project trajectory from the moment shared runtime work
started (Phase 1) through documentation consolidation (Phase 7).

Scope note:

- Phase 0 established render-plane proof and benchmark baseline.
- This document focuses on **Phase 1 onward**, as requested.

---

## 1) Executive summary

From Phase 1 to Phase 7, Titulus moved from a runtime prototype to an
operationally coherent product baseline:

- shared runtime + engine channel page were unified (WYSIWYG parity),
- control plane reached end-to-end operator workflow (TAKE/UPDATE/CLEAR),
- render plane gained stream and DeckLink code-complete output paths,
- backend hardening/security baseline was completed,
- SaaS foundations (license, auth/RBAC, billing hooks, audit) were delivered,
- DeckLink hardware acceptance was formalized into a repeatable handoff process,
- project docs/rules were fully synchronized with the actual repository state.

The only major external blocker remains Phase 6.4 runtime execution on a real
DeckLink + genlock host.

---

## 2) Phase-by-phase breakdown

## Phase 1 - Shared runtime + channel page

### Goal

Create one render logic implementation (`@titulus/runtime`) used by engine and
editor, and prove engine-side HTML runtime integration.

### Delivered

- Runtime modules: schema, timeline, easing, transform, stack order, clock, fonts.
- `TemplateRenderer` and `ChannelClient` foundation.
- Runtime bundling pipeline (`build.mjs` -> `backend/public/bg-runtime.js`).
- `backend/public/channel.html` integration path for engine/browser rendering.

### Operational impact

- Established WYSIWYG architecture principle.
- Removed need for duplicated rendering logic across layers.

### Milestones

- PRs #8, #9, #10, #11, #12, #13

---

## Phase 2 - Control plane completion

### Goal

Build full operator-grade control plane around runtime/engine contracts.

### Delivered

- Backend core: templates/channels/rundowns/settings.
- On-air manager + WS hubs + replay-on-connect persistence.
- Media upload/transcode path (VP9/WebM alpha compatible).
- Frontend shell + editor + control panel + output-mode settings.
- Engine supervisor (`run-engines.sh`/`run-channel.sh`) integrated with channel config.

### Operational impact

- End-to-end loop became usable in real workflow:
  - prepare template -> TAKE -> UPDATE -> CLEAR.
- On-air state survives backend restarts (NFR-1 behavior).

### Milestones

- PRs #14, #15, #17, #18, #19, #20, #21, #22, #23

---

## Phase 3 - DeckLink SDI code-complete (deferred runtime validation)

### Goal

Implement DeckLink consumer path with CasparCG parity model despite no hardware
on dev host.

### Delivered

- `decklink_consumer` implementation (scheduled playback callback model, keyer,
  interlace weave handling, telemetry, restart signaling).
- Build guards and runtime loading approach for DeckLink SDK/libs.
- Deferred validation contract document (`docs/phase3-decklink-validation-deferred.md`).

### Operational impact

- SDI path is compile/link complete.
- Runtime validation moved to explicit external acceptance stage.

### Status

- Code-complete, validation deferred until hardware host availability.

---

## Phase 4 - Backend hardening

### Goal

Increase reliability/safety of API and WS control paths under real operator load.

### Delivered

- Deterministic on-air replay ordering (`order_index`).
- Hardened upload route (MIME/ext/size checks, structured errors).
- Transcode retries/timeouts and bounded diagnostics.
- Structured template validation API payloads.
- Security and protocol hardening in WS control route.
- Global HTTP security header baseline.

### Operational impact

- Lower runtime fragility for malformed payloads and upload edge cases.
- More deterministic restart behavior and better operator diagnostics.

### Milestones

- PRs #28, #29, #30, #31

---

## Phase 5 - Cloud output + schema finalization + docs foundation

### Goal

Complete cloud-output path and lock down AI-ready schema/contracts.

### Delivered

- `ffmpeg_consumer` stream path (`stream` output mode).
- Final AI-ready `shared/template.schema.json` with stricter constraints.
- Architecture and runbook documentation package.

### Operational impact

- Stream output became first-class output mode.
- Schema became stable for AI-assisted template generation workflows.

### Milestones

- PRs #32, #33, #34

---

## Phase 6 - SaaS/enterprise foundation

## Phase 6.1 - License foundation

- Added persistent `license_state`.
- Implemented `/api/license` contract + Settings UI block.
- Established baseline local activation flow.

Milestone: PR #35.

## Phase 6.2 - Auth + RBAC baseline

- Added users/sessions/tenants schema.
- Added auth routes (`login/logout/me`) and user management baseline.
- Guarded REST mutating/admin-sensitive routes by role.
- Enforced auth token on `/ws/control`.
- Added frontend login flow + session persistence + route guarding.

## Phase 6.3 - Billing hooks + audit baseline

- Added billing entitlements endpoint and webhook skeleton.
- Added persisted `audit_events` with redaction-safe payload handling.
- Added audit listing endpoint + Settings UI visibility.

Milestone: PR #36.

## Phase 6.4 - DeckLink closure handoff

- Added dedicated validation closure doc.
- Added `engine/collect-decklink-evidence.sh` to standardize evidence collection.
- Updated runbook with handoff flow.

Milestone: PR #37.

Current state: handoff-ready, waiting hardware execution.

---

## Phase 7 - Documentation/rules consolidation

### Goal

Bring all major documentation and rules to current project reality and remove
historic drift.

### Delivered

- Synchronized `.cursor/rules` status maps (`10-development-plan`, `99-session-history`,
  `01-architecture`, `11-skills-map`, workflow/conventions updates).
- Updated top-level and package-level README files to remove stale
  "not implemented" statements.
- Refreshed `docs/ARCHITECTURE.md` and `docs/RUNBOOK.md` with auth-aware,
  current operational flow and endpoint map.
- Added this detailed report (`docs/PHASE_REPORT_PHASE1_TO_PHASE7.md`).

### Operational impact

- New contributors/agents now see one consistent project narrative.
- Reduced onboarding ambiguity and execution mistakes during continuation work.

---

## 3) Cumulative technical outcomes (Phase 1 -> 7)

- **Single runtime truth** across editor and on-air engine.
- **Stable control loop** for operators (template lifecycle + persistence).
- **Dual output readiness**:
  - cloud/stream path operational,
  - SDI path code-complete with explicit hardware acceptance workflow.
- **Security/compliance baseline**:
  - auth + RBAC,
  - audit trail,
  - hardened input validation.
- **Operational maturity**:
  - scripted supervisors,
  - explicit runbook,
  - structured handoff/evidence process.

---

## 4) Remaining gaps / external dependencies

Primary unresolved item:

- Phase 6.4 final hardware execution (DeckLink + genlock host).

Expected final closure outputs:

- completed validation checklist,
- evidence bundle with lock/parity/soak artifacts,
- final acceptance verdict in docs.

---

## 5) Recommended next action

1. Run Phase 6.4 checklist on hardware host.
2. Attach evidence bundle and verdict to project docs/release milestone.
3. Mark Phase 6 complete and open next roadmap milestone (Phase 8+ scope planning).
