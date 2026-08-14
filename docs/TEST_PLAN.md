# TransBoard 2.0 test plan

## Automated

- `go test ./...`: domain transitions, JSON migration, atomic write, backup/restore, passcode/token, CSV encoding/mapping, HTTP auth, heartbeat, and WebRTC queue.
- `npm.cmd run check`: frontend contract, CSV, device-presence, call-panel, and
  Go/Wails security regression checks.
- `wails build`: Windows x64 Wails packaging and WebView2 asset embedding.

## Compatibility fixtures

Use synthetic data only: legacy plain `db.json`, `ENCDB1:` data, `TBENCV1:` backup, SHA256 passcode, old terminal-role settings, CSV in UTF-8/BOM/CP932, and old `DEPART_REGISTERED` events.

## Manual Windows checklist

Wizard, ward/bed map, patient registration/edit/discharge, every transfer status, exam-room actions, notifications, parent/client connection, heartbeat, WebRTC voice/video, CSV and ODBC/SMB, schedule feed, NFC, backup/restore, updater, startup, fullscreen, always-on-top, and power-save prevention.

The 1.x behavior remains the compatibility oracle for synthetic fixtures, while
the executable under test is the Go/Wails build on Windows 10 and Windows 11.
