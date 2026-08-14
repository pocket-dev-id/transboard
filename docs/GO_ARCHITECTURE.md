# TransBoard 2.0 Go / Wails architecture

```text
Wails App / frontend bridge
          |
internal/application
   |      |       |
domain database network
   |      |       |
importer backup security webrtc updater platform/windows
```

## Responsibilities

- `internal/domain`: transfer rules, bed occupancy comparison, and domain models.
- `internal/database`: JSON compatibility, migration, locking, atomic writes, retention, and audit persistence boundary.
- `internal/application`: lifecycle, dependency wiring, Wails-safe application operations, and event routing.
- `internal/network`: parent HTTP API, token auth, child client, heartbeat, and discovery.
- `internal/importer`: CSV encoding, stable-file detection, mapping, fsnotify watcher, ODBC/SMB adapter boundaries.
- `internal/backup`: legacy-compatible AES-256-GCM backup and validated restore.
- `internal/security`: DPAPI, Electron-compatible legacy decryption entrypoint, token and passcode verification.
- `internal/updater`: JSON manifest updates plus the legacy `latest.yml`/SHA-512 distribution and rollback contract.
- `internal/webrtc`: signaling only; media remains in WebView2 JavaScript.

The parent serves authenticated `/updates/manifest.json` and `/updates/latest.yml`
from its local distribution directory. The Go manifest is generated when a
legacy installer is imported, so Electron 1.x and Go 2.x clients can coexist
during cutover.

The Go/Wails tree is the runtime implementation. Historical Electron data and
installer formats are handled only by the compatibility/migration code; no
Electron or Node.js runtime is required to build or launch TransBoard 2.0.
