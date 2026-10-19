# PRODUCT.md — SyncTab v3 (Group Sync)

> Drafted 2026-10-20 from the confirmed interactive brief (grilling Rounds 1–2 with the
> product owner, documented in memory entity `synctab-group-only-redesign` and SOT.md v2.3).
> Lines marked *(assumed)* were inferred, not stated verbatim.

## What this is
SyncTab is a **Manifest V3 extension for Microsoft Edge on Ubuntu Linux** that keeps a
persistent, per-group library of tab-group tabs and restores them on demand.
**v3 changes the product from window-snapshot sync to group-only sync.**

Audience: a single power user on their own machine, Thai language UI, 100% local
(no server, no webfont, no network dependency). *(assumed: single-machine scope — no
cross-device sync)*

## The user's jobs
1. **Capture:** tabs living in named tab groups should be remembered automatically —
   including groups currently closed down to zero tabs on the browser — but only those.
   Ungrouped tabs must never be captured.
2. **Restore:** open a whole group or a hand-picked subset of remembered tabs back into
   the browser as a tab group — every opened tab must start **asleep** (discarded) so a
   20-tab restore costs almost nothing.
3. **Prune:** delete groups or individual remembered tab records directly from the popup.
4. **Truth-mirroring:** read at a glance which tabs are live (open in the browser) and
   which are remembered-only. Closing a live tab keeps its record but flips it to
   remembered-only; live/remembered state always matches the browser.

## Non-goals (explicitly torn down from v2)
- No window-snapshot topology, no closed-window archive, no recovery checkpoints, no
  suspected-loss alerts, no manual backup, no import/export, no settings modal.
- No native messaging host / SQLite storage — persistence is `chrome.storage.local`.
- Nothing in the popup opens tabs on its own; no startup auto-restore of any kind.
  A fresh browser session opens as a plain new-tab page.

## Surfaced in scope for design
The popup is the only surface (360–420 px wide, long vertical list, keyboard accessible,
adaptive light/dark following GNOME). Mode: **Operate** — scanability and safe destructive
actions outrank decoration. Brand lives in the Chromium group colors of the real data.

## Words we use
กลุ่ม (group record) · แท็บ (tab record) · ตื่น (live) / หลับ (idle/remembered-only) ·
เปิดทั้งหมด / เปิดที่เลือก (restore) · ลบกลุ่ม / ลบแท็บ (delete) · แท็บที่ลากออกจากกลุ่ม
จะถือว่า "หลับ" *(assumed phrasing — Edge vocabulary: Sleeping Tabs)*
