# TransBoard Maintenance Guide

This file is for AI coding agents and future maintainers. Keep changes small,
verify them with the commands below, and avoid broad rewrites of the large
browser scripts unless the task explicitly requires it.

## Project Shape

- `main.js`: Electron main process, local JSON database, HTTP API, parent server,
  import/watch/update plumbing.
- `preload.js`: Electron bridge exposed to browser code.
- `index.html`: script load order for the browser globals. If a new browser file
  depends on another global, load it after its dependency here.
- `js/api.js`: browser API wrapper and parent/child request routing.
- `js/state.js`: shared in-memory browser state helpers.
- `js/device-presence.js`: pure helpers for connected device summary display.
- `js/app.js`: application boot, polling, global UI events, passcode session,
  parent connection monitor, device presence display.
- `js/settings/core.js`: settings shell, tab routing, shared settings helpers.
- `js/settings/network.js`: parent/child mode, token, update, backup, connected
  device administration.
- `js/settings/import-notify.js`: import, schedule feed, notification settings.
- `js/settings/masters.js`: ward, bed, room, exam type, staff master settings.
- `js/settings/status-customize.js`: status label/color/action customization.
- `docs/SCHEMA.md` and `docs/NETWORK.md`: intended schema and network notes.

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

Run this before committing JavaScript changes:

```bash
npm run check
```

For network or parent/child changes, also inspect:

```bash
node --check main.js
node --check js/api.js
node --check js/app.js
node --check js/settings/network.js
```

There is no full automated test suite in this repository, but `npm run check`
does run a growing set of behavioral regression scripts under `scripts/`
(e.g. `check-device-presence.js`, `check-call-panel.js`) that load a specific
`js/*.js` file via `vm.runInNewContext` with a hand-built mock of the browser
globals it touches, then assert on the resulting behavior with Node's `assert`
module. Follow that pattern (one self-contained `scripts/check-<area>.js`
file, wired into the `check` script in `package.json`) when a fix is concrete
and worth pinning down. For anything else, or for changes that touch UI
behavior without a practical way to mock it, describe the manual path that
should be checked in the commit or PR notes instead.
