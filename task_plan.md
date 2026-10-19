# Task Plan: Edge Tab Recovery Safety Net

## Goal
Add five rolling one-minute recovery checkpoints, suspected mass-loss detection, and additive restore UI.

## Phases
- [x] Add and red-run state-model tests.
- [x] Implement checkpoint ring and mass-loss alert.
- [x] Add and test the service-worker alarm lifecycle.
- [x] Implement additive restore from a selected checkpoint.
- [x] Add popup recovery and acknowledgement UI.
- [x] Update SOT and run authorized regression suites.

## Decisions
- A mass loss alert is heuristic; it means “suspected,” not proof of browser fault.
- Threshold: at least 5 URLs or at least 50% of latest trusted checkpoint missing.
- While the alert is pending, do not rotate trusted checkpoints.
- Restore adds missing tabs only; acknowledgment means user accepts the current reduced session.
- Checkpoint state stays in the `chrome.storage.local` mirror; NativeAdapter excludes the ring from SQLite messages and merges it on native loads to avoid 5x payload growth.
- “Missing” compares normalized URL per extension window UUID; checkpoint recovery will not open an URL already present in another regular window.
