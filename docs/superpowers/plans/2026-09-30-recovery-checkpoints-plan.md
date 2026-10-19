# Browser Tab Recovery Checkpoints Implementation Plan

> **For agentic workers:** Implement inline in this session; keep each test and implementation step small and verify the named commands.

**Goal:** Preserve recent live tab sessions and let users restore missing tabs when Edge unexpectedly drops them.

**Architecture:** Store a bounded ring of five full-session checkpoints captured by a one-minute alarm. Compare each complete capture with the newest trusted checkpoint; a large tab-count drop raises a persistent suspected-loss notice and freezes checkpoint rotation until the user restores or acknowledges it. Restore is additive and URL-deduplicated, using the existing grouped, staggered restore engine.

**Tech Stack:** Manifest V3 service worker, Chrome/Edge alarms and tabs APIs, JavaScript ES modules, Node test runner, SQLite/native adapter and chrome.storage.local.

## Global Constraints

- Keep native host stdout reserved for the stdio protocol; this change does not edit native host files.
- Keep `SOT.md` as the source of truth.
- Keep browser APIs behind the service worker and restore logic behind `DiffEngine`.
- Checkpoints are limited to five entries and are not closed-window archive entries.
- A checkpoint restore only adds missing URLs; it does not close or replace live tabs.
- Mass tab loss is heuristic and must be shown as suspected, never asserted as user intent.
- Test first, verify red, then implement the smallest change and verify green.

---

### Task 1: Checkpoint and loss-classifier state model

**Files:**
- Modify: `background/state-manager.js`
- Modify: `background/storage/native-adapter.js`
- Modify: `shared/types.js`
- Modify: `shared/constants.js`
- Test: `test/recovery_checkpoints.test.js`

**Interfaces:**
- `captureRecoveryCheckpoint(liveWindows, groupMap, timestamp)` stores complete, non-empty snapshots, deduplicates unchanged session fingerprints, retains five newest checkpoints, and does not rotate them while a loss alert is active.
- A tab-loss alert is raised when at least five tabs or at least half of the latest trusted checkpoint are absent.
- `acknowledgeRecoveryAlert()` clears the alert and permits new checkpoints.
- The five checkpoint entries and loss alert stay in the existing local-storage mirror; native saves omit these duplicated payloads, and native loads merge them back from the mirror.

- [ ] Write tests for periodic checkpoint capture, five-entry retention, unchanged snapshots, empty/incomplete snapshots, and suspected mass loss.
- [ ] Run `node --test test/recovery_checkpoints.test.js` and confirm the expected missing behavior fails.
- [ ] Implement checkpoint persistence and the loss classifier.
- [ ] Re-run the focused test and the state-manager test files.

### Task 2: Periodic alarm lifecycle and loss-safe capture

**Files:**
- Modify: `background/service-worker.js`
- Test: `test/recovery_checkpoint_worker.test.js`

**Interfaces:**
- Recreate `synctab-recovery-checkpoint` at one-minute cadence on install/startup and when handling the alarm.
- On alarm, capture live windows and groups once, update live state, then capture a checkpoint only after successful complete queries.
- Skip checkpoint capture during restore; do not turn a zero-window or zero-tab sample into a new checkpoint.

- [ ] Add tests for alarm registration and rejected/empty captures.
- [ ] Run focused worker test and confirm failure before implementation.
- [ ] Implement alarm wiring and ensure handlers remain safe when Chrome APIs are unavailable in Node tests.
- [ ] Re-run focused worker test.

### Task 3: Additive checkpoint restoration

**Files:**
- Modify: `background/diff-engine.js`
- Modify: `background/service-worker.js`
- Modify: `shared/messages.js`
- Test: `test/recovery_checkpoints.test.js`
- Test: `test/e2e_stress.test.js`

**Interfaces:**
- Add `RESTORE_RECOVERY_CHECKPOINT` with a checkpoint timestamp/id and active Edge window ID.
- Restore all checkpoint tabs into the selected active window through existing URL diffing, staggered creation, lazy restore, and group reconstruction.
- Do not restore duplicates already open in any regular Edge window or duplicate URLs from the checkpoint.

- [ ] Add integration tests proving restoration adds missing tabs, skips duplicates, and rebuilds groups.
- [ ] Run the focused test and verify it fails for the missing message/API path.
- [ ] Implement checkpoint lookup and route through the shared restore engine.
- [ ] Re-run focused and E2E stress tests.

### Task 4: Popup recovery panel and user acknowledgement

**Files:**
- Modify: `popup/popup.html`
- Modify: `popup/popup.js`
- Modify: `popup/popup.css`
- Verify: `node --check popup/popup.js`; behavior is covered by the recovery-flow E2E test.

**Interfaces:**
- Show recent checkpoints with local date/time, relative age, window count, and tab count.
- Show a clear suspected-loss banner with missing-tab count and checkpoint restore action.
- Provide an explicit “dismiss / these tabs were closed intentionally” action that acknowledges the alert.
- After restore or acknowledgement, reload the displayed state.

- [ ] Add UI behavior tests for empty, normal, and suspected-loss states and actions.
- [ ] Verify the tests fail before implementation.
- [ ] Implement the recovery panel using existing popup rendering and message patterns.
- [ ] Re-run popup tests.

### Task 5: Specification and regression verification

**Files:**
- Modify: `SOT.md`
- Test: `test/recovery_checkpoints.test.js`
- Test: `test/recovery_checkpoint_worker.test.js`
- Test: `test/e2e_stress.test.js`

- [ ] Document checkpoint cadence, retention, anomaly threshold, manual acknowledgement, and additive restore behavior in `SOT.md`.
- [ ] Run `npm test` and `npm run test:native`.
- [ ] Inspect the final diff and report any limits, especially that browser APIs do not identify whether a tab close was user-initiated.
