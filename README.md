# Zenthrip

A predictable, rule-based file organiser for the desktop (Softablitz 2026, *Sanctum Keeper*).
Electron + React + SQLite + chokidar. Team: Tessaract Zero. **Version 1.0: Basic and Advanced tiers complete.**

| Req | Feature | Where |
|-----|---------|-------|
| B1 | Up to 3 watched folders, persisted, direct children only, system/root refused, temp downloads ignored | `engine/paths.js`, `main/watcher.js` |
| B2 | Visual rule builder: name / extension / size / age; rename / move / copy / trash | `renderer/components/*` |
| B3 | First matching rule wins, deterministic | `engine/planner.js` |
| B4 | Dry-run preview, zero writes; "Run this plan" executes exactly it | `main/keeper.js`, `pages/Preview.jsx` |
| B5 | Ledger of everything; undo one entry or a whole sweep | `db/ledger.js`, `engine/undo.js` |
| A1 | Nested AND / OR / NOT, custom scripts (trusted, timeout, no shell) | `ConditionBuilder.jsx`, `engine/scripts.js` |
| A2 | Rule rank + loop detection (save-time graph + runtime hop guard) | `engine/loopGuard.js` |
| A3 | System tray, close-to-tray, time-based rules (interval / daily / weekly) | `main/tray.js`, `main/scheduler.js` |
| A4 | 200 files at once exactly once; locked files and long names reported, not fatal | `engine/executor.js`, `tests/stress.test.js` |
| A5 | Journal-then-act ledger (WAL, `synchronous=FULL`), boot-time recovery | `engine/recovery.js` |

## Requirements
Node.js **22.22+**; Windows, macOS or Linux.

## Run
```bash
npm install          # also downloads the Electron binary (postinstall)
npm run dev          # app with hot reload
npm test             # 190+ tests (engine, DB, watcher, executor, undo, crash recovery, IPC, UI)
npm run stress       # the 200-file exactly-once test on its own
npm run build        # bundle into ./out
npm run dist         # installer in ./dist (NSIS / dmg / AppImage; build on the target OS)
```
`better-sqlite3` ships prebuilt binaries; it is unpacked from the asar in packaged builds (`asarUnpack`).

## Try it in 3 minutes
1. **Doors:** add an empty test folder. Try adding `C:\` or `/`: refused.
2. **Enchantments:** *New rule*: `name contains invoice` AND `size larger than 1 MB` -> Rename `{date}_{name}` -> Move to a folder.
   Add a second, overlapping rule and drag to reorder: only the first match acts.
3. Drop files in, including `x.crdownload` (ignored). **Preview** shows every outcome with nothing changed; **Run this plan** applies it.
4. **Ledger:** undo one entry, then *Undo sweep*: the folder is exactly as it was.
5. Create rule A->B and B->A: saving the second is refused as a loop (or frozen at runtime with "Loop stopped").
6. Close the window: Zenthrip keeps running in the tray. Add a rule *Every day at …* or *Every 1 minutes* to see a schedule fire.

## Decisions worth knowing
* **Keeper Trash:** "Send to trash" moves files into `<userData>/trash`, not the OS trash, so undo is always possible. Retention and "Empty" are in Settings.
* **Nothing is overwritten:** name clashes become `name (1).ext`.
* **Rename keeps the extension** unless the template uses `{ext}` or `{original}`.
* **Scripts** cannot be undone; they need explicit trust (native dialog) and lose trust if edited.
* **Pause** ignores new files and schedules (use Preview + Run to catch up).
* Full architecture and trade-offs: `docs/design-notes.md`; plan: `ZENTHRIP_PLAN.md`.

## Platform notes / limitations
Developed and tested on Linux. Windows and macOS need a manual smoke test before submission (tray icon, packaged `better-sqlite3`,
start-at-login). Windows paths over 259 characters are reported as failed (no `\\?\` support).