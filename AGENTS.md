# TransBoard Maintenance Guide

This file is for AI coding agents and future maintainers. Keep changes small,
verify them with the commands below, and avoid broad rewrites of the large
browser scripts unless the task explicitly requires it.

## Project Shape

- `main.go` / `app.go`: Wails bootstrap and the thin binding facade.
- `internal/application`: lifecycle and orchestration of the Go services.
- `internal/domain`: UI/DB-independent transfer and occupancy rules.
- `internal/database`: JSON schema, migration, locking, atomic writes, and audit.
- `internal/network`: authenticated parent HTTP API, child client, presence, and
  WebRTC signaling.
- `internal/importer`: CSV, fsnotify, ODBC, SMB, and schedule-feed adapters.
- `internal/security`: DPAPI, passcode, token, and backup crypto handling.
- `internal/platform/windows`: Windows-only dialogs, window, power, startup,
  hostname, and ODBC registry integrations.
- `frontend/index.html`: Wails asset entry point and browser script order.
- `frontend/js/api.js`: browser API wrapper and parent/child request routing.
- `frontend/js/state.js`: shared in-memory browser state helpers.
- `frontend/js/app.js`: application boot, polling, global UI events, passcode
  session, parent connection monitor, and device presence display.
- `frontend/js/settings/*`: settings shell, network, import, master, and status
  customization screens.
- `docs/SCHEMA.md` and `docs/NETWORK.md`: data and network contracts.

## Safe Change Rules

- Prefer extracting constants or helpers near the feature owner before moving
  code across files.
- Treat `index.html` script order as an API. Browser files use globals rather
  than ES modules.
- Escape all device-provided, CSV-provided, or database-provided text before
  writing it into `innerHTML`.
- Keep parent/child behavior symmetric: when changing a parent endpoint, check
  the child caller in `js/api.js`, `js/app.js`, and `js/settings/network.js`.
- Do not change storage keys (`cfg_*`, `_device_id`, table names) without a
  migration or backward-compatible fallback.
- Do not edit generated build artifacts or packaged output when source files can
  be changed instead.

## Verification

Run this before committing frontend changes:

```bash
npm run check
```

For network or parent/child changes, run `go test ./...` and inspect the matching
package under `internal/network`.

- Go packages include unit tests for database, migration, atomic writes, transfer rules, CSV, API auth, heartbeat, signaling, backup, security, and updater.
does run a growing set of behavioral regression scripts under `scripts/`
(e.g. `check-device-presence.js`, `check-call-panel.js`) that load a specific
`js/*.js` file via `vm.runInNewContext` with a hand-built mock of the browser
globals it touches, then assert on the resulting behavior with Node's `assert`
module. Follow that pattern (one self-contained `scripts/check-<area>.js`
file, wired into the `check` script in `package.json`) when a fix is concrete
and worth pinning down. For anything else, or for changes that touch UI
behavior without a practical way to mock it, describe the manual path that
should be checked in the commit or PR notes instead.

## Go / Wails 2.0 rules

- `internal/domain` must not import Wails, HTTP, Windows APIs, or the JSON repository.
- `internal/database` is the only owner of `db.json`, migration, file locking, and atomic replacement.
- Wails-exposed methods belong at the binding facade; keep business logic in `internal/application` and domain services.
- Windows-specific behavior belongs under `internal/platform/windows` or a file with an explicit Windows build tag.
- Do not remove API-token authentication, DPAPI protection, backup encryption, or constant-time comparisons.
- Migration must follow backup → read → validate → convert → validate → atomic replace, and must never destroy an unreadable source.
- The Go/Wails branch is the runtime implementation. The `window.electronAPI`
  name is retained only as a compatibility facade for the existing frontend;
  it must not reintroduce an Electron or Node runtime dependency.
- Run `go test ./...` after each Go subsystem change and `npm.cmd run check` when
  the frontend contract changes.
