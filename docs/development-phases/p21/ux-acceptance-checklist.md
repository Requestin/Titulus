# Phase 21 UX acceptance checklist

This checklist converts the frozen `sergey-v1` UX documents into observable acceptance criteria. It does not record or imply that any software or hardware baseline run has passed.

Sources are frozen at current-main commit `91a5563770430b7558c856a92fdf5fc3a4db5c4a`; implementation reference is `sergey-v1` commit `7ca8823633b6a47e963f1b3377dcb0758d9734e9`.

## Gate recording rules

- **Automated gate** means the named test/build/fixture gate must produce an attached artifact or CI result.
- **Manual gate** means **USER VERDICT REQUIRED**. An agent observation, screenshot, or automated test cannot mark it PASS. Record `PASS` or `FAIL`, user, date, and evidence link/path.
- A criterion with both gate types requires both to pass.
- `excluded` criteria pass only when the forbidden surface remains absent; they are not deferred features.

Manual verdict record:

```text
Verdict: PASS | FAIL
User:
Date:
Evidence:
Notes:
```

## Shell and Templates

- [ ] **UX-SHELL-001 — Collapsible application navigation.** The user can collapse the left navigation to a narrow icon rail and restore it without losing the current Templates, Control, or Settings route.
  - Source: `new-interface.md` §1 General structure
  - Milestone: P21.2
  - Automated gate: `frontend-tests`, `frontend-typecheck-build`, `accessibility-keyboard`
  - Manual gate: **USER VERDICT REQUIRED** for route retention, readable icons/tooltips, and useful collapsed width.

- [ ] **UX-SHELL-002 — Resizable/collapsible editor panels.** The user can resize Tree and Properties/Data/Variables regions and collapse/restore the documented groups without obscuring the canvas or losing edits.
  - Source: `new-interface.md` §2 Template editor
  - Milestone: P21.2
  - Automated gate: `frontend-tests`, `frontend-typecheck-build`
  - Manual gate: **USER VERDICT REQUIRED** for usable min/max sizes and restoration behavior.

- [ ] **UX-TPL-001 — Template list operations.** The user can create, open, rename, duplicate, and delete a template; delete uses an in-app confirmation and the resulting list is immediately correct.
  - Source: `new-interface.md` §1 Templates list
  - Milestone: P21.2
  - Automated gate: `frontend-tests`, `backend-tests`
  - Manual gate: **USER VERDICT REQUIRED** for labels, confirmation wording, and list feedback.

- [ ] **UX-TPL-002 — Sort and view modes.** The user can sort templates by name or modified date and switch between list and thumbnail views without changing template data.
  - Source: `new-interface.md` §1 Templates list
  - Milestone: P21.2
  - Automated gate: `frontend-tests`, `frontend-typecheck-build`
  - Manual gate: **USER VERDICT REQUIRED** for stable ordering and useful list/thumbnail density.

- [ ] **UX-TPL-003 — Folder assignment and Control visibility.** The user sees All and Unassigned, can create one-level folders, drag a template into a folder, toggle folder visibility in Control, and choose whether folder deletion also deletes its templates or moves them to Unassigned.
  - Source: `new-interface.md` §1 Templates folders
  - Milestone: P21.7
  - Automated gate: `db-migration-rollback`, `backend-tests`, `frontend-tests`, `security`
  - Manual gate: **USER VERDICT REQUIRED** for drag feedback, visibility behavior, and both delete choices.

- [ ] **UX-TPL-004 — Persistent thumbnails.** Saving a template produces a persistent thumbnail that survives reload/restart and appears in thumbnail view without affecting the live channel.
  - Source: `new-interface.md` §1 Templates list
  - Milestone: P21.7
  - Automated gate: `backend-tests`, `visual-regression`, `resource-isolation`, `security`
  - Manual gate: **USER VERDICT REQUIRED** that the thumbnail represents the saved composition and never causes visible air disturbance.

- [ ] **UX-TPL-005 — Test mode channel selection.** In the documented template test workflow, the user can select a channel and TAKE/CLEAR the current template without navigating to an unrelated control surface.
  - Source: `new-interface.md` §1 Templates test mode
  - Milestone: P21.2
  - Automated gate: `frontend-tests`, `ws-protocol`
  - Manual gate: **USER VERDICT REQUIRED** for the end-to-end test-mode workflow.

## Tree and scene properties

- [ ] **UX-TREE-001 — Tree naming and z-order.** The editor labels the hierarchy Tree; items shown higher are observably closer to the viewer, and drag reordering changes saved/rendered order consistently.
  - Source: `new-interface.md` §2 Tree
  - Milestone: P21.2/P21.3
  - Automated gate: `old-template-fixtures`, `frontend-tests`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for order clarity and drag/drop feedback.

- [ ] **UX-TREE-002 — Unlimited nested groups.** The user can nest groups multiple levels deep, expand/collapse them, and move layers or groups between parents without changing world position at the active playhead.
  - Source: `new-interface.md` §2 Tree
  - Milestone: P21.3
  - Automated gate: `schema-contract`, `old-template-fixtures`, `new-template-fixtures`, `frontend-tests`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** after nested reparenting at base and animated frames.

- [ ] **UX-TREE-003 — Multi-select move.** In select mode the user can select layers/groups in different visible branches and drag them as one operation; descendants of a selected group are not moved twice.
  - Source: `new-interface.md` §2 Tree
  - Milestone: P21.3
  - Automated gate: `frontend-tests`, `new-template-fixtures`
  - Manual gate: **USER VERDICT REQUIRED** for multi-selection and grouped drag behavior.

- [ ] **UX-TREE-004 — Ctrl-drag subtree copy.** Ctrl-drag copies every selected layer/group subtree with new IDs and copies all associated tracks/keyframes while leaving originals unchanged.
  - Source: `new-interface.md` §2 Tree
  - Milestone: P21.3
  - Automated gate: `schema-contract`, `frontend-tests`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** after playing both original and copied animations.

- [ ] **UX-TREE-005 — Delete semantics.** Deleting a layer removes only that layer and its tracks; deleting a group follows the documented world-preserving child policy and never silently loses descendants.
  - Source: `new-interface.md` §2 Tree
  - Milestone: P21.3
  - Automated gate: `old-template-fixtures`, `frontend-tests`, `new-template-fixtures`
  - Manual gate: **USER VERDICT REQUIRED** for both layer and group deletion outcomes.

- [ ] **UX-TREE-006 — Edit locks.** A locked layer or group cannot be moved, resized, reparented, renamed, deleted, or changed through canvas, inspector, keyboard, or timeline gestures until unlocked; selection and inspection remain possible.
  - Source: `new-interface.md` §2 Tree
  - Milestone: P21.3
  - Automated gate: `frontend-tests`, `accessibility-keyboard`
  - Manual gate: **USER VERDICT REQUIRED** across every listed edit path.

- [ ] **UX-PROP-001 — Pivot/axis center.** L/C/R and B/C/T controls move the pivot without moving the object in world space; rotation and scale then occur around the selected pivot for layers and groups.
  - Source: `new-interface.md` §2 Properties / Axis center
  - Milestone: P21.3
  - Automated gate: `old-template-fixtures`, `new-template-fixtures`, `frontend-tests`, `runtime-tests-build`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for all nine pivot positions on rotated and nested objects.

- [ ] **UX-PROP-002 — Position Z.** The user can set and animate Z; zero preserves the current 2D result, nonzero gives consistent 2.5D depth in editor, browser, and air, including projected masks.
  - Source: `new-interface.md` §2 Properties / Position
  - Milestone: P21.3
  - Automated gate: `schema-contract`, `old-template-fixtures`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `one-tick-cadence`, `decklink-1ch-3ch`, `abba-hot-path`
  - Manual gate: **USER VERDICT REQUIRED** for depth order, intersections, and mask attachment.

- [ ] **UX-PROP-003 — Rotation cost cue.** Rotation Z works as the normal planar rotation; using Rotation X/Y visibly communicates that 2.5D mode is enabled without changing existing template defaults.
  - Source: `new-interface.md` §2 Properties / Rotation
  - Milestone: P21.3
  - Automated gate: `old-template-fixtures`, `frontend-tests`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for control clarity and unchanged old-template geometry.

- [ ] **UX-PROP-004 — Scale lock.** Linking Scale X/Y causes subsequent edits to preserve the ratio, unlinking restores independent values, and animation records both required tracks deterministically.
  - Source: `new-interface.md` §2 Properties / Size
  - Milestone: P21.3
  - Automated gate: `frontend-tests`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for linked inspector and timeline behavior.

- [ ] **UX-PROP-005 — Size presets.** Screen sets 1920×1080, Width sets width to 1920 only, and Height sets height to 1080 only; every action is one undoable edit.
  - Source: `new-interface.md` §2 Properties / Size
  - Milestone: P21.3
  - Automated gate: `frontend-tests`
  - Manual gate: **USER VERDICT REQUIRED** for exact values and undo/redo behavior.

- [ ] **UX-PROP-006 — Numeric input gestures.** Arrow keys step values, horizontal drag changes values continuously, reset restores the documented default, and rotation exposes exact +45/-45 actions.
  - Source: `new-interface.md` §2 Properties
  - Milestone: P21.3
  - Automated gate: `frontend-tests`, `accessibility-keyboard`
  - Manual gate: **USER VERDICT REQUIRED** for pointer feel, keyboard stepping, and exact reset/angle results.

- [ ] **UX-PROP-007 — Text transform.** None, uppercase, titlecase, and lowercase produce the documented text in editor, browser, and air without mutating the stored source string.
  - Source: `new-interface.md` §2 Properties / Text
  - Milestone: P21.3
  - Automated gate: `schema-contract`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `visual-regression`
  - Manual gate: **USER VERDICT REQUIRED** using mixed Cyrillic/Latin text and punctuation.

- [ ] **UX-PROP-008 — Shadow.** Text and Clock expose Color/X/Y/Blur shadow controls; Crawl receives the same visual semantics, and disabling shadow restores no-shadow output.
  - Source: `new-interface.md` §2 Properties / Text; `crawl-parameters.md` Shadow
  - Milestone: P21.3/P21.6
  - Automated gate: `schema-contract`, `old-template-fixtures`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `visual-regression`
  - Manual gate: **USER VERDICT REQUIRED** for text, clock, and Crawl shadow parity.

- [ ] **UX-PROP-009 — Rectangle gradient.** The user can switch Solid/Gradient, choose four corner colors and weights, animate supported weights, and get the same result in editor, browser, and air.
  - Source: `new-interface.md` §2 Properties / Rectangle
  - Milestone: P21.3
  - Automated gate: `schema-contract`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `visual-regression`, `one-tick-cadence`, `decklink-1ch-3ch`, `abba-hot-path`
  - Manual gate: **USER VERDICT REQUIRED** for static and animated gradients.

## Timeline v2, Actions, Continue, and Update

- [ ] **UX-TL-001 — Directors and playheads.** Default and Update exist on new templates; additional directors can be created, selected, played, stopped, and looped independently, and each director shows its own current playhead.
  - Source: `new-interface.md` §2 Timeline / Directors
  - Milestone: P21.4/P21.5
  - Automated gate: `schema-contract`, `new-template-fixtures`, `runtime-tests-build`, `frontend-tests`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** with at least two simultaneously active directors.

- [ ] **UX-TL-002 — Object property track groups.** Adding tracks for a selected object creates a visible object group with child property tracks, and selecting the object highlights its tracks.
  - Source: `new-interface.md` §2 Timeline / Tracks
  - Milestone: P21.4
  - Automated gate: `frontend-tests`, `new-template-fixtures`
  - Manual gate: **USER VERDICT REQUIRED** for grouping, labels, selection synchronization, and collapse behavior.

- [ ] **UX-TL-003 — Summary range move/stretch.** Dragging an object summary moves every child keyframe by the same frame delta; stretching either edge scales child times proportionally and resolves duplicate-frame collisions deterministically.
  - Source: `new-interface.md` §2 Timeline / Animation
  - Milestone: P21.4
  - Automated gate: `frontend-tests`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for move/stretch predictability and one-gesture/one-undo behavior.

- [ ] **UX-TL-004 — Marquee keyframe selection.** The user can marquee multiple keyframes across tracks and move them together without selecting unrelated points or creating nondeterministic collisions.
  - Source: `new-interface.md` §2 Timeline / Keyframes
  - Milestone: P21.4
  - Automated gate: `frontend-tests`, `new-template-fixtures`
  - Manual gate: **USER VERDICT REQUIRED** for marquee hit-testing and grouped drag.

- [ ] **UX-TL-005 — Track/director drag-and-drop.** The user can drag an object/property track to another director; saved ownership, preview, and air playback all follow the destination director.
  - Source: `new-interface.md` §2 Timeline / Tracks
  - Milestone: P21.4
  - Automated gate: `schema-contract`, `frontend-tests`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** after reload and playback.

- [ ] **UX-TL-006 — Action cue/items.** +Action creates one cue marker at the selected director/frame; adding again at the same location adds another item inside the cue, and each item exposes command, parameter, length, and direction.
  - Source: `new-interface.md` §2 Timeline / Actions
  - Milestone: P21.5
  - Automated gate: `schema-contract`, `migration-idempotence`, `new-template-fixtures`, `runtime-tests-build`, `frontend-tests`
  - Manual gate: **USER VERDICT REQUIRED** for marker editing, nested items, and clear error states.

- [ ] **UX-TL-007 — Action execution and direction.** startDirector, stopDirector, stop-and-wait, pause, endScene, and updateData execute exactly once at the specified boundary and honor normal/reverse/both direction; scrubbing does not execute them.
  - Source: `new-interface.md` §2 Timeline / Actions
  - Milestone: P21.5
  - Automated gate: `runtime-tests-build`, `new-template-fixtures`, `editor-browser-air-parity`, `ws-protocol`, `one-tick-cadence`
  - Manual gate: **USER VERDICT REQUIRED** for stopped-frame appearance and endScene/on-air behavior.

- [ ] **UX-TL-008 — fromEnd.** A fromEnd Action preserves its distance from the director end when the director duration changes, including duration changes caused by dynamic Crawl content.
  - Source: `new-interface.md` §2 Timeline / Actions
  - Milestone: P21.5/P21.6
  - Automated gate: `schema-contract`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for marker placement before and after Crawl content changes.

- [ ] **UX-TL-009 — Continue.** When a director reaches stop-and-wait, Continue becomes enabled only for the owning on-air item; clicking it resumes the exact frozen state and disables it again when no wait remains.
  - Source: `new-interface.md` §2 Timeline; §3 Control / Rundown
  - Milestone: P21.5
  - Automated gate: `runtime-tests-build`, `frontend-tests`, `backend-tests`, `ws-protocol`, `editor-browser-air-parity`, `one-tick-cadence`
  - Manual gate: **USER VERDICT REQUIRED** for button enablement, frozen picture, and exact resume.

- [ ] **UX-TL-010 — Update director.** Re-TAKE of an on-air template runs protected Update when armed, replaces variables only at updateData, returns Update to its start, and otherwise performs the documented Clear+restart fallback.
  - Source: `new-interface.md` §2 Timeline / Update; §3 Control
  - Milestone: P21.5
  - Automated gate: `schema-contract`, `migration-idempotence`, `runtime-tests-build`, `backend-tests`, `ws-protocol`, `editor-browser-air-parity`, `one-tick-cadence`, `decklink-1ch-3ch`
  - Manual gate: **USER VERDICT REQUIRED** for both armed and unarmed flows and on-air ownership transfer.

## Crawl and Data pipeline

- [ ] **UX-CRAWL-001 — Ticker/carousel directions.** A new Crawl can switch ticker/carousel; only valid horizontal/vertical directions are offered and editor, browser, and air show the same path.
  - Source: `crawl-parameters.md` Type and Direction
  - Milestone: P21.6
  - Automated gate: `schema-contract`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `visual-regression`
  - Manual gate: **USER VERDICT REQUIRED** for all valid direction combinations.

- [ ] **UX-CRAWL-002 — Speed, pause, batch/continuous.** Speed changes duration in template frames, pause=0 produces strip motion, pause>0 produces per-line hold, batch runs once, and continuous loops without a visible seam.
  - Source: `crawl-parameters.md` Speed, Pause, Animation Type
  - Milestone: P21.6
  - Automated gate: `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `one-tick-cadence`, `decklink-1ch-3ch`, `abba-hot-path`
  - Manual gate: **USER VERDICT REQUIRED** for hold timing and loop seam quality.

- [ ] **UX-CRAWL-003 — Separator and text limits.** None/Text/Image separator modes render only between rows; maximum text length clips each row deterministically and recalculates duration.
  - Source: `crawl-parameters.md` Separator, Maximum text length
  - Milestone: P21.6
  - Automated gate: `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`, `visual-regression`
  - Manual gate: **USER VERDICT REQUIRED** for text/image separators and clipping feedback.

- [ ] **UX-CRAWL-004 — File/data-driven content.** Parse or TAKE reads declared content outside the engine hot path, failures follow policy, and changed content recalculates immutable air duration before playback.
  - Source: `crawl-parameters.md` Content and Use File; `template-editor-data.md`
  - Milestone: P21.6
  - Automated gate: `backend-tests`, `security`, `runtime-tests-build`, `editor-browser-air-parity`, `one-tick-cadence`
  - Manual gate: **USER VERDICT REQUIRED** for success, missing-file, and live UPDATE workflows.

- [ ] **UX-DATA-001 — Expanded variables.** The designer can create text, multitext, image, video, number, color, textfile, and time variables; drivenBy and Show in Control visibly control operator editability.
  - Source: `new-interface.md` §2 Variables; `template-editor-data.md` Variables
  - Milestone: P21.6
  - Automated gate: `schema-contract`, `migration-idempotence`, `frontend-tests`, `runtime-tests-build`
  - Manual gate: **USER VERDICT REQUIRED** for type controls and Control visibility.

- [ ] **UX-DATA-002 — Sources and formats.** Data accepts textfile, jsonfile, and inline sources; lines, delimited, kv, and JSON parsing show deterministic preview records and actionable errors.
  - Source: `template-editor-data.md` Sources and Formats
  - Milestone: P21.6
  - Automated gate: `schema-contract`, `runtime-tests-build`, `backend-tests`, `security`, `new-template-fixtures`
  - Manual gate: **USER VERDICT REQUIRED** for configuring and previewing every source/format pair.

- [ ] **UX-DATA-003 — Designer-owned selection.** first, last, index, byKey, match, and all are configured in the template; Control never asks the operator to choose the source row.
  - Source: `template-editor-data.md` Select
  - Milestone: P21.6
  - Automated gate: `runtime-tests-build`, `frontend-tests`, `new-template-fixtures`
  - Manual gate: **USER VERDICT REQUIRED** for Data-panel ownership and absence of row selection in Control.

- [ ] **UX-DATA-004 — Map and policies.** Map supports text/multitext/number/time/image/video, select-all join, transforms, runOn take/load/update/refresh, and block/keep/clear error/empty policies with visible preview results.
  - Source: `template-editor-data.md` Map, runOn, onError
  - Milestone: P21.6
  - Automated gate: `schema-contract`, `runtime-tests-build`, `backend-tests`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for Preview/TAKE equality and clear policy feedback.

- [ ] **UX-DATA-005 — Time expressions.** today/tomorrow/yesterday offsets, `today@HH:mm`, `now±duration`, ISO date/time, and epoch milliseconds resolve deterministically for countup/countdown and Data mapping.
  - Source: `template-editor-data.md` Clock + Data; `new-interface.md` §2 Clock
  - Milestone: P21.6
  - Automated gate: `runtime-tests-build`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** using the configured deployment timezone.

- [ ] **UX-DATA-006 — Media tokens.** Copy token produces `asset:<uuid>`; Data image/video mapping resolves by asset ID, URL, or allowed path according to policy and never by ambiguous display name.
  - Source: `template-editor-data.md` Media; `new-interface.md` §2 Image/Video
  - Milestone: P21.7
  - Automated gate: `backend-tests`, `security`, `media-ingest`, `new-template-fixtures`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for token copy, preview, TAKE, and missing-token policy.

## MAM, Control, locks, and RBAC

- [ ] **UX-MAM-001 — Image/video library.** Choose File opens a searchable media library filtered by type; the user can upload, select, and inspect dimensions/duration/status without pasting a URL.
  - Source: `new-interface.md` §2 Image and Video
  - Milestone: P21.7
  - Automated gate: `backend-tests`, `media-ingest`, `security`, `resource-isolation`
  - Manual gate: **USER VERDICT REQUIRED** for browse/search/select and processing-state UX.

- [ ] **UX-MAM-002 — Shared tags.** Image and video assets use one tag catalog; the user can create tags, assign/remove them, and filter results without renaming assets.
  - Source: `new-interface.md` §2 Image and Video
  - Milestone: P21.7
  - Automated gate: `db-migration-rollback`, `backend-tests`, `security`
  - Manual gate: **USER VERDICT REQUIRED** for shared tag creation and filtering.

- [ ] **UX-MAM-003 — Import/recovery.** A controlled scan imports supported watched-folder files, unsupported images convert safely, poster repair is explicit, and scan/recovery cannot rename/delete a live asset unexpectedly.
  - Source: `new-interface.md` §2 Image and Video
  - Milestone: P21.7
  - Automated gate: `backend-tests`, `media-ingest`, `security`, `resource-isolation`, `db-migration-rollback`
  - Manual gate: **USER VERDICT REQUIRED** for import status, retry/repair feedback, and preservation of selected/live assets.

- [ ] **UX-CTRL-001 — Data Elements.** The user can save filled operator values as a named Data Element, list/filter Data Elements by template folder/template, reopen them, and drag them into a rundown with unambiguous labels.
  - Source: `new-interface.md` §3 Control / Templates and Dataelements
  - Milestone: P21.9
  - Automated gate: `db-migration-rollback`, `backend-tests`, `frontend-tests`, `security`
  - Manual gate: **USER VERDICT REQUIRED** for create/filter/reopen/drag workflow.

- [ ] **UX-CTRL-002 — Rundown composition.** A channel-owned rundown can contain direct Template and Data Element slots; the row clearly distinguishes slot/Data Element name from template name and preserves order after reload.
  - Source: `new-interface.md` §3 Control / Rundowns
  - Milestone: P21.9
  - Automated gate: `db-migration-rollback`, `backend-tests`, `frontend-tests`, `ws-protocol`
  - Manual gate: **USER VERDICT REQUIRED** for labels, order, and multi-rundown workflow.

- [ ] **UX-CTRL-003 — TAKE/CONTINUE/CLEAR state.** Each row exposes TAKE, CONTINUE, and CLEAR; enabled states follow Pending/On Air/wait rules and the on-air indicator belongs only to the initiating slot.
  - Source: `new-interface.md` §3 Control / Rundown
  - Milestone: P21.5/P21.9
  - Automated gate: `frontend-tests`, `backend-tests`, `ws-protocol`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for all button-state transitions.

- [ ] **UX-CTRL-004 — LayerID and on-air list.** LayerID accepts 1–99 with default 50; different IDs stack deterministically, same-ID replacement clears only the displaced instance, and the on-air list shows every active instance with layer, template, and owner details.
  - Source: `new-interface.md` §2 Properties / Layers; §3 Control
  - Milestone: P21.9
  - Automated gate: `schema-contract`, `backend-tests`, `ws-protocol`, `new-template-fixtures`, `editor-browser-air-parity`, `decklink-1ch-3ch`
  - Manual gate: **USER VERDICT REQUIRED** for stack order, collision replacement, and list details.

- [ ] **UX-LOCK-001 — Template edit lock.** Opening a template for edit obtains a visible lease; another user sees owner/read-only state, stale locks recover after heartbeat timeout, and save is backend-enforced rather than UI-only.
  - Source: `new-interface.md` §4 Settings / users and locks
  - Milestone: P21.9
  - Automated gate: `db-migration-rollback`, `backend-tests`, `security`, `ws-protocol`
  - Manual gate: **USER VERDICT REQUIRED** with two authenticated sessions and a disconnect/recovery scenario.

- [ ] **UX-RBAC-001 — Users, groups, permissions.** An admin can manage users/groups and assign granular permissions; an operator sees only permitted surfaces, and direct unauthorized API/WS requests receive a clear denial.
  - Source: `new-interface.md` §4 Settings
  - Milestone: P21.9
  - Automated gate: `db-migration-rollback`, `backend-tests`, `security`, `frontend-tests`, `accessibility-keyboard`
  - Manual gate: **USER VERDICT REQUIRED** for admin and operator workflows; API enforcement still requires automated proof.

## Guarded video timeline

- [ ] **UX-VIDEO-001 — Add and place video clip.** Selecting a video creates or updates one timeline clip that can be moved to choose its start frame; reload preserves placement and never creates duplicate clips.
  - Source: `new-interface.md` §2 Video; §2 Timeline
  - Milestone: P21.8
  - Automated gate: `schema-contract`, `new-template-fixtures`, `frontend-tests`, `runtime-tests-build`
  - Manual gate: **USER VERDICT REQUIRED** for placement, reload, and replacement behavior.

- [ ] **UX-VIDEO-002 — WebP visibility-window default.** Air playback keeps the current animated WebP derivative and image-element path; the timeline clip controls a documented visibility/start window rather than pretending seekable WebM semantics.
  - Source: `new-interface.md` §2 Video; Phase 21 plan §6.4
  - Milestone: P21.8
  - Automated gate: `media-ingest`, `runtime-tests-build`, `editor-browser-air-parity`, `one-tick-cadence`, `decklink-1ch-3ch`, `abba-hot-path`
  - Manual gate: **USER VERDICT REQUIRED** for editor/air WYSIWYG at clip boundaries and any explicitly accepted limitation.

- [ ] **UX-VIDEO-003 — Loop and end behavior.** Loop and each accepted At the end mode have deterministic visibility/state behavior for alpha and opaque WebP derivatives.
  - Source: `new-interface.md` §2 Video
  - Milestone: P21.8
  - Automated gate: `schema-contract`, `media-ingest`, `new-template-fixtures`, `runtime-tests-build`, `editor-browser-air-parity`
  - Manual gate: **USER VERDICT REQUIRED** for every exposed end mode.

## Explicit exclusions

- [ ] **EXC-001 — Unreal integration remains absent.** No Unreal renderer integration is added to current main.
  - Source: `new-interface.md` §1 Ue Templates; Phase 21 plan §4.5
  - Milestone: excluded
  - Automated gate: `exclusion-audit`
  - Manual gate: not applicable; this is an absence audit.

- [ ] **EXC-002 — VS engine remains absent.** `bg_vs_engine`, its CMake target, and `run-vs-channel` remain absent.
  - Source: Phase 21 plan §4.5
  - Milestone: excluded
  - Automated gate: `exclusion-audit`
  - Manual gate: not applicable; this is an absence audit.

- [ ] **EXC-003 — UE Templates remain absent.** No UE Templates navigation, editor, permission, route, or Unreal Remote Control proxy is added.
  - Source: `new-interface.md` §1 Ue Templates
  - Milestone: excluded
  - Automated gate: `exclusion-audit`
  - Manual gate: not applicable; this is an absence audit.

- [ ] **EXC-004 — NDI remains absent.** No NDI input producer, route, dependency, or channel mode is added.
  - Source: Phase 21 plan §4.5
  - Milestone: excluded
  - Automated gate: `exclusion-audit`
  - Manual gate: not applicable; this is an absence audit.

- [ ] **EXC-005 — Chroma remains absent.** No chroma keyer/compositor code or UI is added.
  - Source: Phase 21 plan §4.5
  - Milestone: excluded
  - Automated gate: `exclusion-audit`
  - Manual gate: not applicable; this is an absence audit.

- [ ] **EXC-006 — Unreal backend mode remains absent.** `render_backend=unreal` is rejected or unavailable in channel configuration and deployment commands.
  - Source: Phase 21 plan §4.5
  - Milestone: excluded
  - Automated gate: `exclusion-audit`
  - Manual gate: not applicable; this is an absence audit.

## Engine invariants — separate non-negotiable gates

These gates do not prove UX completeness. They protect current-main render and delivery behavior while a UX capability is added.

- [ ] **ENG-001 — Single runtime authority.** Editor and air both use `@titulus/runtime`; no frontend-only render math or second renderer is introduced.
  - Applies: every milestone
  - Automated gate: architecture/import audit plus `runtime-tests-build`, `frontend-typecheck-build`

- [ ] **ENG-002 — CPU-only CEF OSR.** Deployment preserves CPU-only CEF OSR and `--disable-gpu`; no GPU/Unreal fallback is introduced.
  - Applies: every milestone
  - Automated gate: command/config audit and `exclusion-audit`

- [ ] **ENG-003 — DeckLink master clock and one_tick.** DeckLink remains master clock; `one_tick` remains active; logical cadence stays `(1,1)=100%`, `(2,0)=0` with approximately 50 poses/s per channel.
  - Applies: runtime/render/timeline/media changes
  - Automated gate: `one-tick-cadence`, `decklink-1ch-3ch`, and `abba-hot-path` for hot-path changes

- [ ] **ENG-004 — Delivery errors and reference.** Matched required runs have no directional regression in late/drop/flush/unlock, and `single`/`input_overwrite` are reported rather than dismissed.
  - Applies: runtime/render/timeline/media changes
  - Automated gate: `decklink-1ch-3ch`; attach telemetry artifacts

- [ ] **ENG-005 — Existing template parity.** Current `test`, `test1`, masks, transforms, anchor defaults, order, and geometry remain byte/visually compatible after normalization and rendering.
  - Applies: every schema/runtime/editor milestone
  - Automated gate: `old-template-fixtures`, `migration-idempotence`, `editor-browser-air-parity`, `visual-regression`
  - Manual gate: **USER VERDICT REQUIRED** for any non-pixel-exact accepted visual comparison.

- [ ] **ENG-006 — Current hot paths remain intact.** Preserve hybrid-safe CPU packing, unique CEF cache, FrameLog/BGPACING provenance, graceful stop, 1×1 damage beacon, projected-mask degenerate guard, and current WS acknowledgement used by the Phase 20 harness.
  - Applies: every runtime/backend/engine milestone
  - Automated gate: targeted regression tests, command/config audit, `one-tick-cadence`

- [ ] **ENG-007 — Layered compositor stays opt-in.** The global layered flag remains OFF; existing allowlisted templates retain behavior; new capabilities fail closed to the whole-template path unless separately proven and allowlisted.
  - Applies: runtime/render capabilities
  - Automated gate: render-graph protocol/golden tests and `abba-hot-path` before any allowlist expansion

- [ ] **ENG-008 — WebP ingest remains authoritative.** Current durable source/playback/poster state, bounded queue, animated WebP alpha/opaque derivatives, and image-element playback remain intact until the P21.8 decision gate proves a compatible extension.
  - Applies: P21.7/P21.8
  - Automated gate: `media-ingest`, `resource-isolation`, `decklink-1ch-3ch`

- [ ] **ENG-009 — No per-frame I/O or React storm.** File/network parse never occurs in the engine hot path; Crawl DOM is stable; no 50 Hz Zustand update or runtime-wide `will-change` is introduced.
  - Applies: P21.4–P21.8
  - Automated gate: runtime/frontend profiling evidence plus `abba-hot-path`

- [ ] **ENG-010 — Visual operator verdict.** For user-visible temporal behavior, a matched run must be observed for freeze, duplicate/skip/reversal, editor/air mismatch, and boundary artifacts.
  - Applies: runtime/render/timeline/media changes
  - Manual gate: **USER VERDICT REQUIRED**; record PASS/FAIL, user, date, template/channel, duration, and evidence. Agent-only observation cannot close this gate.
