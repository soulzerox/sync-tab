# Closed Archive and Tab Group Restoration Implementation Plan

> **For agentic workers:** Implement inline in this session using the steps below. Each task is test-first and independently verifiable.

**Goal:** Preserve original browser tab group metadata during restore and cap the closed archive at five newest entries, including pinned templates.

**Architecture:** Keep group reconstruction in `DiffEngine.executeRestore`, test its browser API boundary, and preserve ordering with a small pure shared helper consumed by the popup. Keep retention policy centralized in `StateManager.pruneClosedWindows`, called by startup reconciliation, settings changes, and existing close/import flows.

**Tech Stack:** JavaScript ES modules, Node.js built-in test runner, Chrome/Edge extension APIs.

## Global Constraints

- Microsoft Edge on Ubuntu is the primary platform.
- Native host stdout remains reserved for the messaging protocol.
- Keep extension behavior compatible with Manifest V3.
- Archive cap is five total entries including pinned templates.
- Restored groups preserve title, color, and collapsed state.

---

### Task 1: Enforce the five-entry archive policy

**Files:**
- Modify: `test/phase2.test.js`
- Modify: `background/state-manager.js`
- Modify: `shared/constants.js`
- Modify: `popup/popup.html`
- Modify: `popup/popup.js`
- Modify: `test/phase1.test.js`
- Modify: `SOT.md`

- [x] Add tests proving pruning keeps only the newest two entries when pinned and regular entries are mixed, and that updating the retention setting immediately prunes.
- [x] Run the Phase 2 suite and confirm the tests fail against the existing pinned-exempt implementation.
- [x] Change pruning to use all entries, clamp configured retention to 1–5, and rank by `closedAt` with `lastUpdated` fallback.
- [x] Set default and hard maximum to five, update the settings input to 1–5, and correct the pin label and SOT wording.
- [x] Run the focused Phase 1 and Phase 2 suites.

### Task 2: Display newest archive entries first

**Files:**
- Create: `shared/closed-window-order.js`
- Create: `test/closed_window_order.test.js`
- Modify: `popup/popup.js`

- [x] Add a failing test for descending `closedAt` ordering with `lastUpdated` fallback.
- [x] Run `node test/closed_window_order.test.js` and confirm the helper is missing before implementation.
- [x] Implement the pure ordering helper and call it from `renderClosedWindows`.
- [x] Run the focused ordering test.

### Task 3: Verify original group metadata survives restore

**Files:**
- Modify: `test/diagnostics_regression.test.js`
- Modify: `test/e2e_stress.test.js`
- Modify only if needed: `background/diff-engine.js`

- [x] Extend restore tests to check group title, color, and collapsed state passed to `chrome.tabGroups.update`, before discard calls.
- [x] Run the focused tests and check whether the current implementation already preserves these fields.
- [x] Confirm existing restore implementation preserves the fields and groups before discard.
- [x] Run the focused regression/E2E-simulation tests.

### Task 4: Full verification and source-of-truth review

- [x] Run `npm test`.
- [x] Run `npm run test:native`.
- [x] Review the changed files and check SOT consistency.
