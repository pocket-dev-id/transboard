# Electron to Go migration notes

## Compatibility boundary

The frontend continues to call `window.electronAPI`. `frontend/bridge/electron-api-compat.js` maps these calls to `window.go.main.App` Wails bindings and maps Wails events back to the existing callback names.

The compatibility list is maintained from the 1.x bridge contract: database
requests, parent HTTP, WebRTC signaling, import events, backup/restore,
passcode, terminal role, diagnostics, update hooks, schedule hooks, ODBC hooks,
and Windows integration hooks.

## Data safety

The Go store reads plain JSON and the Electron `ENCDB1:` entrypoint. Migration creates a pre-migration copy before replacement. Restore creates `.before_restore`; validation failure leaves the active database untouched.

## Cutover status

The Electron runtime, preload process, PowerShell NFC helper, and Electron
packaging dependencies have been removed from the 2.0 branch. Compatibility is
provided by the Wails bridge and by the JSON/backup/update migration adapters.
The manual Windows checklist in `docs/TEST_PLAN.md` remains required before a
production release is signed.
