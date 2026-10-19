# Closed Archive and Tab Group Restoration Design

## Goal

Restore tabs with their original browser group metadata and keep the closed-window archive limited to at most five entries, including pinned templates, with the newest entries first.

## Design

The restore engine will continue rebuilding browser groups from the saved per-tab group metadata. It must restore each group’s title, color, and collapsed state before applying Edge’s discarded/sleeping state. The existing live-tab ID check remains in place so group creation only receives tabs still present in the target window.

The archive retention setting will default to five and allow a configurable value from one through five. Pruning will rank every archived window, pinned or not, by `closedAt`, falling back to `lastUpdated`, and retain only the newest entries. This cap will apply when settings change, when the extension reconciles startup state, and when windows close. The popup will independently display entries in descending timestamp order. Pinning marks a preferred template but does not exempt it from the global retention cap.

## User-visible behavior

- Restored tabs keep their saved group title, color, and collapsed state.
- The archive never exceeds five entries; users may choose a lower limit in Settings.
- Pinned templates are included in that limit and older entries can be pruned.
- Newest closed windows appear first.
- Pin button text describes a preferred template without promising permanent retention.

## Validation

Regression tests will cover group metadata passed to the browser group API, retention across pinned and regular archives, immediate pruning after a settings change, newest-first ordering, and the configured hard maximum. Existing JavaScript unit/E2E-simulation and native-host suites will be run.
