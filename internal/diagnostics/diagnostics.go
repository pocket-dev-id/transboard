package diagnostics

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"time"
)

type Snapshot struct {
	Version          string `json:"version"`
	GoVersion        string `json:"goVersion"`
	OS               string `json:"os"`
	Hostname         string `json:"hostname"`
	TerminalRole     string `json:"terminalRole,omitempty"`
	Mode             string `json:"mode,omitempty"`
	ParentIP         string `json:"parentIp,omitempty"`
	DBPath           string `json:"dbPath,omitempty"`
	DBSize           int64  `json:"dbSize,omitempty"`
	SchemaVersion    string `json:"schemaVersion,omitempty"`
	WebView2         string `json:"webview2,omitempty"`
	NFCStatus        string `json:"nfcStatus,omitempty"`
	ODBCStatus       string `json:"odbcStatus,omitempty"`
	CSVWatcherStatus string `json:"csvWatcherStatus,omitempty"`
	CollectedAt      int64  `json:"collectedAt"`
}

func Collect(version, dbPath, role, mode, parentIP, schema string) Snapshot {
	hostname, _ := os.Hostname()
	var size int64
	if info, err := os.Stat(dbPath); err == nil {
		size = info.Size()
	}
	return Snapshot{Version: version, GoVersion: runtime.Version(), OS: runtime.GOOS, Hostname: hostname, TerminalRole: role, Mode: mode, ParentIP: parentIP, DBPath: dbPath, DBSize: size, SchemaVersion: schema, WebView2: "managed by Wails", NFCStatus: "not started", ODBCStatus: "adapter status available", CSVWatcherStatus: "managed by fsnotify", CollectedAt: time.Now().UnixMilli()}
}

func Write(path string, snapshot Snapshot) error {
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("write diagnostics: %w", err)
	}
	return nil
}
