package application

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocket-dev-id/transboard/internal/backup"
	"github.com/pocket-dev-id/transboard/internal/database"
	"github.com/pocket-dev-id/transboard/internal/diagnostics"
	"github.com/pocket-dev-id/transboard/internal/importer"
	"github.com/pocket-dev-id/transboard/internal/network"
	"github.com/pocket-dev-id/transboard/internal/nfc"
	platform "github.com/pocket-dev-id/transboard/internal/platform/windows"
	"github.com/pocket-dev-id/transboard/internal/security"
	"github.com/pocket-dev-id/transboard/internal/updater"
)

const Version = "2.0.0"

type Options struct {
	DataDir       string
	Port          int
	DisableServer bool
}

type App struct {
	mu             sync.RWMutex
	options        Options
	dataDir        string
	store          *database.Store
	audit          *database.AuditService
	server         *network.Server
	backups        *backup.Service
	eventSink      EventSink
	ctx            context.Context
	cancel         context.CancelFunc
	watcherCancel  context.CancelFunc
	scheduleCancel context.CancelFunc
	maintenance    map[string]time.Time
	nfc            *nfc.Service
	wg             sync.WaitGroup
	odbc           importer.ODBCProvider
}

func New(options Options) (*App, error) {
	dir, err := dataDirectory(options.DataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	if options.Port == 0 {
		options.Port = 3005
	}
	store := database.NewStore(filepath.Join(dir, "db.json"))
	audit := database.NewAuditService(filepath.Join(dir, "audit-log.jsonl"))
	app := &App{options: options, dataDir: dir, store: store, audit: audit, maintenance: map[string]time.Time{}}
	app.nfc = nfc.New(nfc.PCSCReader{})
	app.odbc = importer.NewODBCProvider()
	app.server = network.NewServer(store, audit, app.apiToken)
	app.server.SetUpdateDirectory(filepath.Join(dir, "updates"))
	app.server.SetPasscodeHandlers(app.GetPasscodeStatus, app.VerifyAdminPasscode)
	app.server.SetParentActionHandler(app.handleParentAction)
	app.backups = backup.NewService(store, audit)
	return app, nil
}

func (a *App) SetEventSink(sink EventSink) { a.mu.Lock(); defer a.mu.Unlock(); a.eventSink = sink }

func (a *App) Start(parent context.Context) error {
	a.mu.Lock()
	if a.ctx != nil {
		a.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	a.ctx, a.cancel = ctx, cancel
	a.mu.Unlock()
	if err := a.store.Open(ctx); err != nil {
		cancel()
		a.mu.Lock()
		a.ctx = nil
		a.cancel = nil
		a.mu.Unlock()
		return err
	}
	if err := a.migrateLegacyAudit(ctx); err != nil {
		_ = a.store.Close()
		cancel()
		a.mu.Lock()
		a.ctx = nil
		a.cancel = nil
		a.mu.Unlock()
		return err
	}
	if err := a.ensureAPIToken(ctx); err != nil {
		_ = a.store.Close()
		cancel()
		a.mu.Lock()
		a.ctx = nil
		a.cancel = nil
		a.mu.Unlock()
		return err
	}
	shareMode := strings.ToLower(strings.TrimSpace(database.SettingValueOr(a.store, "share_mode", "parent")))
	isParent := shareMode != "client" && shareMode != "child"
	if !a.options.DisableServer && isParent {
		if err := a.server.Start(ctx, a.options.Port); err != nil {
			_ = a.store.Close()
			cancel()
			a.mu.Lock()
			a.ctx = nil
			a.cancel = nil
			a.mu.Unlock()
			return err
		}
	}
	if isParent {
		if directory := a.watchDirectory(); directory != "" {
			a.startWatcher(ctx, directory)
		}
		a.startScheduleTriggers(ctx)
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		if err := a.nfc.Run(ctx, func(uid string) { a.emit("card-scanned", uid) }); err != nil && ctx.Err() == nil {
			a.emit("nfc-error", map[string]any{"message": err.Error()})
		}
	}()
	return nil
}

func (a *App) Stop(ctx context.Context) error {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	if a.watcherCancel != nil {
		a.watcherCancel()
		a.watcherCancel = nil
	}
	if a.scheduleCancel != nil {
		a.scheduleCancel()
		a.scheduleCancel = nil
	}
	a.ctx = nil
	a.mu.Unlock()
	a.wg.Wait()
	serverErr := a.server.Stop(ctx)
	storeErr := a.store.Close()
	if serverErr != nil {
		return serverErr
	}
	return storeErr
}

func (a *App) context() context.Context {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

func (a *App) apiToken() string {
	value, ok := database.SettingValue(a.store, "api_token")
	if !ok {
		return ""
	}
	plain, err := security.DecryptSensitiveValue(value)
	if err != nil {
		return ""
	}
	return plain
}

func (a *App) ensureAPIToken(ctx context.Context) error {
	stored, exists := database.SettingValue(a.store, "api_token")
	if exists && stored != "" {
		token, decryptErr := security.DecryptSensitiveValue(stored)
		if decryptErr != nil {
			return fmt.Errorf("preserve existing API token: %w", decryptErr)
		}
		if token != "" && !strings.HasPrefix(stored, security.SensitivePrefix) {
			protected, protectErr := security.EncryptSensitiveValue(token)
			if protectErr != nil {
				return protectErr
			}
			return a.store.Write(ctx, func(db database.DB) error { database.SetSetting(db, "api_token", protected); return nil })
		}
		if token != "" {
			return nil
		}
	}
	token, err := security.NewToken()
	if err != nil {
		return err
	}
	protected, err := security.EncryptSensitiveValue(token)
	if err != nil {
		return err
	}
	return a.store.Write(ctx, func(db database.DB) error { database.SetSetting(db, "api_token", protected); return nil })
}

func (a *App) migrateLegacyAudit(ctx context.Context) error {
	db, err := a.store.Snapshot()
	if err != nil {
		return err
	}
	if value, ok := database.Setting(db, "audit_jsonl_migrated"); ok && value == "1" {
		return nil
	}
	if err := a.audit.MigrateLegacyRows(database.Rows(db, "audit_logs")); err != nil {
		return fmt.Errorf("migrate audit log: %w", err)
	}
	return a.store.Write(ctx, func(target database.DB) error {
		database.SetRows(target, "audit_logs", []map[string]any{})
		database.SetSetting(target, "audit_jsonl_migrated", "1")
		return nil
	})
}

func (a *App) DBRequest(request map[string]any) map[string]any {
	ctx := a.context()
	url := strings.TrimPrefix(fmt.Sprint(request["url"]), "/")
	if url == "maintenance/complete" {
		return a.completeMaintenance(ctx, request)
	}
	options, _ := request["options"].(map[string]any)
	if options == nil {
		options = map[string]any{}
	}
	return a.server.LocalRequest(ctx, map[string]any{"url": url, "method": options["method"], "body": options["body"]})
}

func (a *App) WebrtcRequest(request map[string]any) map[string]any {
	url := strings.TrimPrefix(fmt.Sprint(request["url"]), "/")
	options, _ := request["options"].(map[string]any)
	if options == nil {
		options = map[string]any{}
	}
	return a.server.LocalRequest(a.context(), map[string]any{"url": url, "method": options["method"], "body": options["body"]})
}

func (a *App) ParentHttpRequest(request map[string]any) map[string]any {
	if request["apiToken"] == nil {
		request["apiToken"] = a.apiToken()
	}
	return network.ParentRequest(a.context(), request)
}

func (a *App) GetLocalIPs() []string { return platform.LocalIPs() }
func (a *App) GetHostname() string   { return platform.Hostname() }
func (a *App) IsDevMode() bool       { return os.Getenv("TRANSBOARD_DEV") == "1" }
func (a *App) GetAppVersion() string { return Version }

func (a *App) CompleteDataImport(payload map[string]any) map[string]any {
	if success, ok := payload["success"].(bool); !ok || success {
		a.emit("data-import-completed", payload)
	}
	return map[string]any{"success": true}
}

func (a *App) GetWatchDirectory() map[string]any {
	return map[string]any{"success": true, "path": a.watchDirectory()}
}

func (a *App) UpdateWatchDirectory(path string) map[string]any {
	path = strings.TrimSpace(path)
	// A UNC path may require the credentials that are being saved in the same
	// settings operation. Do not reject it before the watcher has a chance to
	// mount the share with those credentials.
	if path != "" && !strings.HasPrefix(path, `\\`) {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			return map[string]any{"success": false, "code": "VALIDATION_FAILED", "message": "watch directory does not exist"}
		}
	}
	if err := a.store.Write(a.context(), func(db database.DB) error { database.SetSetting(db, "import_directory", path); return nil }); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	a.mu.Lock()
	if a.watcherCancel != nil {
		a.watcherCancel()
		a.watcherCancel = nil
	}
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil && path != "" {
		a.startWatcher(ctx, path)
	}
	return map[string]any{"success": true, "path": path}
}

func (a *App) TriggerManualImport() map[string]any {
	directory := a.watchDirectory()
	if directory == "" {
		return map[string]any{"success": false, "message": "watch directory is not configured"}
	}
	smbCleanup, mountErr := a.mountImportDirectory(directory)
	if mountErr != nil {
		return map[string]any{"success": false, "message": mountErr.Error()}
	}
	defer func() { _ = smbCleanup() }()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".csv") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		pipeline := &importer.Pipeline{
			Mapping:  a.importMapping(),
			OnImport: a.applyImport,
			OnError: func(importErr error) {
				a.emit("data-import-failed", map[string]any{"fileName": entry.Name(), "error": importErr.Error()})
			},
		}
		if err := pipeline.Import(a.context(), path, importer.EncodingAuto); err != nil {
			continue
		}
		archiveDir := filepath.Join(directory, "archive")
		if _, archiveErr := importer.Archive(path, archiveDir); archiveErr != nil {
			a.emit("archive-error", map[string]any{"path": path, "fileName": entry.Name(), "archiveDir": archiveDir, "error": archiveErr.Error(), "message": archiveErr.Error()})
			continue
		}
		count++
	}
	return map[string]any{"success": true, "count": count}
}

func (a *App) TestOdbcConnection(config map[string]any) map[string]any {
	if err := a.odbc.TestConnection(a.context(), odbcConfig(config)); err != nil {
		return odbcFailure(config, err)
	}
	return map[string]any{"success": true, "message": "ODBC connection succeeded"}
}
func (a *App) RunOdbcSync(config map[string]any) map[string]any {
	rows, err := a.odbc.Query(a.context(), odbcConfig(config))
	if err != nil {
		return odbcFailure(config, err)
	}
	mapping := func(name string, fallback string) string {
		value := strings.TrimSpace(fmt.Sprint(config[name]))
		if value == "" || value == "<nil>" {
			return fallback
		}
		return value
	}
	bedColumn, patientIDColumn, patientNameColumn := mapping("bedNumberColumn", "bed_number"), mapping("patientIdColumn", "patient_id"), mapping("patientNameColumn", "patient_name")
	presentColumn := mapping("isPresentColumn", "is_present")
	records := make([]importer.Record, 0, len(rows))
	for _, row := range rows {
		records = append(records, importer.Record{BedNumber: odbcValue(row, bedColumn), PatientID: odbcValue(row, patientIDColumn), PatientName: odbcValue(row, patientNameColumn), Present: odbcPresent(row[presentColumn]), HasPresence: true})
	}
	if err := a.applyImport(a.context(), importer.Result{Path: "odbc", Encoding: importer.EncodingUTF8, Rows: len(records), Records: records}); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "rows": len(records), "count": len(records)}
}
func (a *App) PreviewOdbcQuery(config map[string]any) map[string]any {
	rows, err := a.odbc.Query(a.context(), odbcConfig(config))
	if err != nil {
		return odbcFailure(config, err)
	}
	return map[string]any{"success": true, "rows": rows, "count": len(rows)}
}
func (a *App) GetOdbcDsns() map[string]any {
	result := platform.ODBCDataSources()
	result["success"] = true
	return result
}
func (a *App) GetOdbcTables(config map[string]any) map[string]any {
	tables, err := a.odbc.Tables(a.context(), odbcConfig(config))
	if err != nil {
		return odbcFailure(config, err)
	}
	return map[string]any{"success": true, "tables": tables}
}

func (a *App) handleParentAction(ctx context.Context, method, action string, payload map[string]any, external bool) map[string]any {
	if method != "GET" && method != "POST" {
		return map[string]any{"success": false, "code": "METHOD_NOT_ALLOWED", "message": "method is not supported"}
	}
	var result map[string]any
	switch action {
	case "save-import-settings":
		result = a.saveImportSettings(ctx, payload)
	case "manual-import":
		result = a.TriggerManualImport()
	case "update-watch-directory":
		path := strings.TrimSpace(fmt.Sprint(payload["path"]))
		if path == "" || path == "<nil>" {
			path = strings.TrimSpace(fmt.Sprint(payload["newPath"]))
		}
		result = a.UpdateWatchDirectory(path)
	case "odbc-dsns":
		result = a.GetOdbcDsns()
	case "odbc-tables":
		result = a.GetOdbcTables(payload)
	case "odbc-test":
		result = a.TestOdbcConnection(payload)
	case "odbc-preview":
		result = a.PreviewOdbcQuery(payload)
	case "odbc-sync":
		result = a.RunOdbcSync(payload)
	case "schedule-feed-import":
		result = a.TriggerScheduleFeedImport(strings.TrimSpace(fmt.Sprint(payload["feedId"])))
	case "schedule-feed-headers":
		folder := strings.TrimSpace(fmt.Sprint(payload["folderPath"]))
		if !a.isConfiguredScheduleFolder(ctx, folder) {
			result = map[string]any{"success": false, "code": "FORBIDDEN", "reason": "not_configured", "message": "schedule folder is not configured"}
		} else {
			result = a.ReadCsvHeaders(folder, strings.TrimSpace(fmt.Sprint(payload["encoding"])))
		}
	case "reload-schedule-feed-triggers":
		result = a.ReloadScheduleFeedTriggers()
	default:
		result = map[string]any{"success": false, "code": "NOT_FOUND", "message": "unknown parent action"}
	}
	if a.audit != nil {
		if auditErr := a.audit.Append(database.AuditEvent{Action: "PARENT_ACTION", TargetType: "parent-actions", TargetID: action, ActorType: actorForParentAction(external), Details: map[string]any{"success": result["success"]}}); auditErr != nil {
			if result["success"] == true {
				return map[string]any{"success": false, "code": "REQUEST_FAILED", "message": fmt.Sprintf("audit parent action: %v", auditErr)}
			}
			result["auditError"] = auditErr.Error()
		}
	}
	return result
}

func actorForParentAction(external bool) string {
	if external {
		return "child_api"
	}
	return "local_ui"
}

func (a *App) saveImportSettings(ctx context.Context, payload map[string]any) map[string]any {
	settings, ok := payload["settings"].(map[string]any)
	if !ok {
		return map[string]any{"success": false, "code": "VALIDATION_FAILED", "message": "settings must be an object"}
	}
	allowed := map[string]bool{"import_directory": true, "import_mapping": true, "import_schedule": true, "import_retention_policy": true, "import_connection_type": true, "odbc_connection_string": true, "odbc_sql_query": true, "smb_auth_mode": true, "smb_username": true, "smb_password": true, "show_sync_time": true, "show_import_time": true}
	for key := range settings {
		if !allowed[key] {
			delete(settings, key)
		}
	}
	if directory, exists := settings["import_directory"]; exists {
		path := strings.TrimSpace(fmt.Sprint(directory))
		if path != "" && path != "<nil>" && !strings.HasPrefix(path, `\\`) {
			if info, err := os.Stat(path); err != nil || !info.IsDir() {
				return map[string]any{"success": false, "code": "VALIDATION_FAILED", "message": "watch directory does not exist"}
			}
		}
	}
	if err := a.store.Write(ctx, func(db database.DB) error {
		for id, value := range settings {
			text := fmt.Sprint(value)
			if text == "<nil>" {
				text = ""
			}
			if id == "odbc_connection_string" || id == "smb_password" {
				protected, protectErr := security.EncryptSensitiveValue(text)
				if protectErr != nil {
					return protectErr
				}
				text = protected
			}
			database.SetSetting(db, id, text)
		}
		return nil
	}); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if rawDirectory, exists := settings["import_directory"]; exists {
		path := strings.TrimSpace(fmt.Sprint(rawDirectory))
		if path == "<nil>" {
			path = ""
		}
		result := a.UpdateWatchDirectory(path)
		if result["success"] == false {
			return result
		}
	} else if _, mappingChanged := settings["import_mapping"]; mappingChanged {
		// The watcher captures its mapping at construction time. Recreate it
		// when only the mapping changes so the next CSV uses the new contract.
		directory := a.watchDirectory()
		a.mu.Lock()
		if a.watcherCancel != nil {
			a.watcherCancel()
			a.watcherCancel = nil
		}
		ctx := a.ctx
		a.mu.Unlock()
		if ctx != nil && directory != "" {
			a.startWatcher(ctx, directory)
		}
	}
	return map[string]any{"success": true}
}

func odbcConfig(config map[string]any) importer.ODBCConfig {
	connection := strings.TrimSpace(fmt.Sprint(config["connectionString"]))
	if connection == "" || connection == "<nil>" {
		dsn := strings.TrimSpace(fmt.Sprint(config["dsn"]))
		if dsn != "" && dsn != "<nil>" {
			connection = "DSN=" + dsn
		}
		if username := strings.TrimSpace(fmt.Sprint(config["username"])); username != "" && username != "<nil>" {
			connection += ";UID=" + username
		}
		if password := strings.TrimSpace(fmt.Sprint(config["password"])); password != "" && password != "<nil>" {
			connection += ";PWD=" + password
		}
	}
	maxRows := parseSettingInt(fmt.Sprint(config["maxRows"]))
	query := strings.TrimSpace(fmt.Sprint(config["query"]))
	if query == "" || query == "<nil>" {
		query = strings.TrimSpace(fmt.Sprint(config["sqlQuery"]))
	}
	return importer.ODBCConfig{ConnectionString: connection, Query: query, MaxRows: maxRows, Encoding: strings.TrimSpace(fmt.Sprint(config["encoding"]))}
}

func odbcValue(row importer.ODBCRecord, column string) string {
	if value, ok := row[column]; ok {
		return strings.TrimSpace(fmt.Sprint(value))
	}
	for key, value := range row {
		if strings.EqualFold(key, column) {
			return strings.TrimSpace(fmt.Sprint(value))
		}
	}
	return ""
}

func odbcPresent(value any) bool {
	switch strings.ToLower(strings.TrimSpace(fmt.Sprint(value))) {
	case "1", "true", "yes", "y", "在床", "在室":
		return true
	default:
		return false
	}
}

func odbcFailure(config map[string]any, err error) map[string]any {
	message := err.Error()
	for _, key := range []string{"password", "connectionString"} {
		secret := strings.TrimSpace(fmt.Sprint(config[key]))
		if secret != "" && secret != "<nil>" {
			message = strings.ReplaceAll(message, secret, "[redacted]")
		}
	}
	return map[string]any{"success": false, "code": "ODBC_ERROR", "message": message}
}

func (a *App) ResetDatabase(token string) map[string]any {
	if !a.validMaintenance(token) {
		return map[string]any{"success": false, "code": "UNAUTHORIZED", "message": "maintenance authorization is required"}
	}
	err := a.store.Write(a.context(), func(db database.DB) error {
		active := map[string]bool{"DEPART_REGISTERED": true, "MOVING": true, "ARRIVED": true, "IN_EXAM": true, "NEARLY_DONE": true, "PICKUP_REQUIRED": true}
		events := database.Rows(db, "transfer_events")
		ids := map[string]bool{}
		kept := events[:0]
		for _, event := range events {
			if active[fmt.Sprint(event["current_status"])] {
				ids[fmt.Sprint(event["id"])] = true
				continue
			}
			kept = append(kept, event)
		}
		database.SetRows(db, "transfer_events", kept)
		logs := database.Rows(db, "transfer_status_logs")
		filtered := logs[:0]
		for _, log := range logs {
			if !ids[fmt.Sprint(log["transfer_event_id"])] {
				filtered = append(filtered, log)
			}
		}
		database.SetRows(db, "transfer_status_logs", filtered)
		return nil
	})
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if err := a.audit.Append(database.AuditEvent{Action: "MAINTENANCE_RESET_ACTIVE_EVENTS", ActorType: "maintenance"}); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true}
}

func (a *App) GetPasscodeStatus() map[string]any {
	stored, ok := database.SettingValue(a.store, "admin_passcode")
	if !ok || stored == "" {
		stored = "0000"
	}
	return map[string]any{"success": true, "isDefault": security.IsDefaultPasscode(stored), "configured": true}
}

func (a *App) VerifyAdminPasscode(passcode string) map[string]any {
	stored, ok := database.SettingValue(a.store, "admin_passcode")
	if !ok || stored == "" {
		stored = "0000"
	}
	if !security.VerifyPasscode(passcode, stored) {
		return map[string]any{"success": false, "valid": false, "code": "UNAUTHORIZED", "message": "invalid passcode"}
	}
	token, err := security.NewToken()
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	a.mu.Lock()
	a.maintenance[token] = time.Now().Add(10 * time.Minute)
	a.mu.Unlock()
	return map[string]any{"success": true, "valid": true, "maintenanceToken": token}
}

func (a *App) SetAdminPasscode(passcode string) map[string]any {
	passcode = strings.TrimSpace(passcode)
	if len(passcode) < 4 || len(passcode) > 128 {
		return map[string]any{"success": false, "code": "VALIDATION_FAILED", "message": "passcode length must be between 4 and 128"}
	}
	hash, err := security.HashPasscode(passcode)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if err := a.store.Write(a.context(), func(db database.DB) error { database.SetSetting(db, "admin_passcode", hash); return nil }); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return a.VerifyAdminPasscode(passcode)
}

func (a *App) validMaintenance(token string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	expires, ok := a.maintenance[token]
	if !ok || time.Now().After(expires) {
		delete(a.maintenance, token)
		return false
	}
	return true
}

func (a *App) completeMaintenance(ctx context.Context, request map[string]any) map[string]any {
	options, _ := request["options"].(map[string]any)
	body := map[string]any{}
	if raw, ok := options["body"].(string); ok {
		_ = json.Unmarshal([]byte(raw), &body)
	}
	if !a.validMaintenance(fmt.Sprint(body["maintenanceToken"])) {
		return map[string]any{"success": false, "code": "UNAUTHORIZED", "message": "maintenance authorization is required"}
	}
	return a.server.MaintenanceComplete(ctx, body)
}

func (a *App) GetTerminalApiToken() map[string]any {
	return map[string]any{"success": true, "token": a.apiToken(), "secure": security.EncryptionAvailable()}
}

func (a *App) SetTerminalApiToken(token string) map[string]any {
	token = strings.TrimSpace(token)
	if len(token) < 16 || len(token) > 256 {
		return map[string]any{"success": false, "code": "VALIDATION_FAILED", "message": "API token length is invalid"}
	}
	protected, err := security.EncryptSensitiveValue(token)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if err := a.store.Write(a.context(), func(db database.DB) error { database.SetSetting(db, "api_token", protected); return nil }); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "secure": true}
}

func (a *App) GetTerminalRole() map[string]any {
	role, ok := database.SettingValue(a.store, "terminal_role")
	if !ok || (role != "parent" && role != "client" && role != "exam" && role != "ward") {
		role = "ward"
	}
	return map[string]any{"success": true, "terminalRole": role, "role": role}
}
func (a *App) SetTerminalRole(role string) map[string]any {
	if role != "parent" && role != "client" && role != "exam" && role != "ward" {
		return map[string]any{"success": false, "message": "invalid terminal role"}
	}
	if err := a.store.Write(a.context(), func(db database.DB) error { database.SetSetting(db, "terminal_role", role); return nil }); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "terminalRole": role, "role": role}
}

func (a *App) CleanupEventRetention() map[string]any {
	deleted := 0
	err := a.store.Write(a.context(), func(db database.DB) error {
		days := parseSettingInt(database.SettingValueFromDB(db, "event_retention_days", "0"))
		if days > 0 {
			cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
			events := database.Rows(db, "transfer_events")
			active := map[string]bool{"DEPART_REGISTERED": true, "MOVING": true, "ARRIVED": true, "IN_EXAM": true, "NEARLY_DONE": true, "PICKUP_REQUIRED": true}
			kept := events[:0]
			for _, event := range events {
				if active[fmt.Sprint(event["current_status"])] || parseAnyInt(event["created_at"]) >= cutoff {
					kept = append(kept, event)
				} else {
					deleted++
				}
			}
			database.SetRows(db, "transfer_events", kept)
		}
		occupancyDays := parseSettingInt(database.SettingValueFromDB(db, "bed_occupancy_retention_days", "7"))
		if occupancyDays > 0 {
			cutoff := time.Now().Add(-time.Duration(occupancyDays) * 24 * time.Hour).UnixMilli()
			logs := database.Rows(db, "bed_occupancy_log")
			kept := logs[:0]
			for _, log := range logs {
				if log["ended_at"] == nil || fmt.Sprint(log["ended_at"]) == "<nil>" || parseAnyInt(log["ended_at"]) >= cutoff {
					kept = append(kept, log)
				} else {
					deleted++
				}
			}
			database.SetRows(db, "bed_occupancy_log", kept)
		}
		return nil
	})
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "deleted": deleted}
}

func parseSettingInt(value string) int {
	var parsed int
	_, _ = fmt.Sscan(value, &parsed)
	return parsed
}
func parseAnyInt(value any) int64 {
	var parsed int64
	_, _ = fmt.Sscan(fmt.Sprint(value), &parsed)
	return parsed
}

func (a *App) BackupDatabase(options map[string]any) map[string]any {
	path := fmt.Sprint(options["path"])
	if path == "" {
		path = filepath.Join(a.dataDir, fmt.Sprintf("backup-%d.json", time.Now().UnixMilli()))
	}
	redact, _ := options["redact"].(bool)
	if options["mode"] == "redacted" {
		redact = true
	}
	result, err := a.backups.Export(a.context(), path, fmt.Sprint(options["password"]), redact)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return result
}
func (a *App) RestoreDatabase(options map[string]any) map[string]any {
	if err := a.backups.Restore(a.context(), fmt.Sprint(options["path"]), fmt.Sprint(options["password"])); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true}
}
func (a *App) GetDatabaseStorageInfo() map[string]any {
	info, err := os.Stat(a.store.Path())
	if err != nil {
		return map[string]any{"success": true, "path": a.store.Path(), "exists": false, "size": 0}
	}
	return map[string]any{"success": true, "path": a.store.Path(), "exists": true, "size": info.Size()}
}
func (a *App) ChangeDatabaseStorageMode(mode string) map[string]any {
	return map[string]any{"success": false, "code": "UNAVAILABLE", "message": "JSON database storage mode is fixed in TransBoard 2.0", "mode": mode}
}
func (a *App) GetEncryptionStatus() map[string]any {
	return map[string]any{"success": true, "available": security.EncryptionAvailable(), "dbPath": a.store.Path()}
}
func (a *App) GetArchiveInfo() map[string]any {
	directory := filepath.Join(a.watchDirectory(), "archive")
	if a.watchDirectory() == "" {
		directory = filepath.Join(a.dataDir, "archive")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return map[string]any{"success": true, "exists": false, "count": 0}
	}
	return map[string]any{"success": true, "exists": true, "count": len(entries), "path": directory}
}
func (a *App) GetDbInfo() map[string]any {
	snapshot, err := a.store.Snapshot()
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	schema, _ := database.Setting(snapshot, "schema_version")
	return map[string]any{"success": true, "path": a.store.Path(), "schemaVersion": schema, "tables": database.TableNames}
}
func (a *App) ExportDiagnosticsBundle() map[string]any {
	path := filepath.Join(a.dataDir, fmt.Sprintf("diagnostics-%d.json", time.Now().UnixMilli()))
	role := a.GetTerminalRole()
	snapshot, _ := a.store.Snapshot()
	schema, _ := database.Setting(snapshot, "schema_version")
	item := diagnostics.Collect(Version, a.store.Path(), fmt.Sprint(role["terminalRole"]), fmt.Sprint(database.SettingValueOr(a.store, "share_mode", "parent")), fmt.Sprint(database.SettingValueOr(a.store, "parent_ip", "")), schema)
	if err := diagnostics.Write(path, item); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "path": path}
}

func (a *App) updateManifestURL(options map[string]any) string {
	manifestURL := strings.TrimSpace(fmt.Sprint(options["manifestUrl"]))
	if manifestURL == "" {
		manifestURL = strings.TrimSpace(os.Getenv("TRANSBOARD_UPDATE_MANIFEST_URL"))
	}
	if manifestURL == "" {
		manifestURL = database.SettingValueOr(a.store, "update_manifest_url", "")
	}
	if manifestURL != "" {
		return manifestURL
	}
	mode := strings.ToLower(strings.TrimSpace(database.SettingValueOr(a.store, "share_mode", "parent")))
	host := "127.0.0.1"
	if mode == "client" || mode == "child" {
		host = strings.TrimSpace(fmt.Sprint(options["parentIp"]))
	}
	if network.ValidateParentAddress(host, 3005) != nil {
		return ""
	}
	return "http://" + host + ":3005/updates/manifest.json"
}

func (a *App) updateHeaders() map[string]string {
	token := a.apiToken()
	if token == "" {
		return nil
	}
	return map[string]string{"X-API-Token": token}
}

func (a *App) CheckForUpdate(options map[string]any) map[string]any {
	manifestURL := a.updateManifestURL(options)
	if manifestURL == "" {
		return map[string]any{"success": false, "code": "UNAVAILABLE", "message": "update manifest URL is not configured"}
	}
	manifest, err := updater.Check(a.context(), manifestURL, a.updateHeaders())
	if err != nil {
		return map[string]any{"success": false, "code": "UPDATE_CHECK_FAILED", "message": err.Error()}
	}
	return map[string]any{"success": true, "currentVersion": Version, "updateAvailable": manifest.Version != Version, "manifest": manifest}
}

func (a *App) DownloadAndInstallUpdate(options map[string]any) map[string]any {
	manifestURL := strings.TrimSpace(fmt.Sprint(options["manifestUrl"]))
	var manifest updater.Manifest
	if raw, ok := options["manifest"].(map[string]any); ok {
		data, marshalErr := json.Marshal(raw)
		if marshalErr != nil {
			return map[string]any{"success": false, "code": "INVALID_UPDATE", "message": marshalErr.Error()}
		}
		var decodeErr error
		manifest, decodeErr = updater.DecodeManifest(data)
		if decodeErr != nil {
			return map[string]any{"success": false, "code": "INVALID_UPDATE", "message": decodeErr.Error()}
		}
	} else {
		manifestURL = a.updateManifestURL(options)
		if manifestURL == "" {
			return map[string]any{"success": false, "code": "UNAVAILABLE", "message": "update manifest URL is not configured"}
		}
		var err error
		manifest, err = updater.Check(a.context(), manifestURL, a.updateHeaders())
		if err != nil {
			return map[string]any{"success": false, "code": "UPDATE_CHECK_FAILED", "message": err.Error()}
		}
	}
	if manifestURL == "" {
		manifestURL = a.updateManifestURL(options)
	}
	if manifestURL != "" {
		base, parseErr := url.Parse(manifestURL)
		if parseErr == nil {
			parsedURL, urlErr := url.Parse(manifest.URL)
			if manifest.URL == "" || (urlErr == nil && parsedURL.Host == "") {
				candidate := manifest.File
				if manifest.URL != "" {
					candidate = manifest.URL
				}
				if resolved, resolveErr := base.Parse(candidate); resolveErr == nil {
					manifest.URL = resolved.String()
				}
			}
		}
	}
	if manifest.URL == "" {
		return map[string]any{"success": false, "code": "INVALID_UPDATE", "message": "update URL is missing"}
	}
	updateDir := filepath.Join(a.dataDir, "updates")
	if err := os.MkdirAll(updateDir, 0700); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	destination := strings.TrimSpace(fmt.Sprint(options["destination"]))
	if destination == "" {
		destination = filepath.Join(updateDir, filepath.Base(manifest.File))
	} else {
		absoluteDestination, absErr := filepath.Abs(destination)
		absoluteUpdateDir, dirErr := filepath.Abs(updateDir)
		if absErr != nil || dirErr != nil {
			return map[string]any{"success": false, "code": "INVALID_UPDATE", "message": "update destination is invalid"}
		}
		relative, relErr := filepath.Rel(absoluteUpdateDir, absoluteDestination)
		if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.Base(relative) != filepath.Base(manifest.File) {
			return map[string]any{"success": false, "code": "INVALID_UPDATE", "message": "update destination must remain inside the update directory"}
		}
		destination = absoluteDestination
	}
	if err := updater.Download(a.context(), manifest, destination, a.updateHeaders()); err != nil {
		return map[string]any{"success": false, "code": "UPDATE_DOWNLOAD_FAILED", "message": err.Error()}
	}
	if err := updater.Install(destination); err != nil {
		return map[string]any{"success": false, "code": "UPDATE_INSTALL_FAILED", "path": destination, "message": err.Error()}
	}
	return map[string]any{"success": true, "path": destination, "version": manifest.Version}
}

func (a *App) GetUpdateDistInfo() map[string]any {
	info, err := updater.DistributionInfo(a.dataDir)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if info == nil {
		return map[string]any{"success": true, "currentVersion": Version, "serving": nil, "archived": nil}
	}
	info["currentVersion"] = Version
	return info
}
func (a *App) ImportUpdateFiles() map[string]any {
	return map[string]any{"success": false, "code": "INTERACTIVE_REQUIRED", "message": "select latest.yml and the installer from the desktop window"}
}
func (a *App) ImportUpdateFilesFromPaths(ymlPath, exePath string) map[string]any {
	var result map[string]any
	var err error
	if strings.EqualFold(filepath.Ext(ymlPath), ".json") {
		result, err = updater.ImportGoDistribution(a.dataDir, ymlPath, exePath)
	} else {
		result, err = updater.ImportDistribution(a.dataDir, ymlPath, exePath)
	}
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if a.audit != nil {
		if auditErr := a.audit.Append(database.AuditEvent{Action: "UPDATE_DIST_IMPORT", TargetType: "updates", TargetID: fmt.Sprint(result["version"]), ActorType: "local_ui", Details: result}); auditErr != nil {
			return map[string]any{"success": false, "code": "REQUEST_FAILED", "message": fmt.Sprintf("audit update import: %v", auditErr)}
		}
	}
	return result
}
func (a *App) RollbackUpdateDist() map[string]any {
	result, err := updater.RollbackDistribution(a.dataDir)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if a.audit != nil {
		if auditErr := a.audit.Append(database.AuditEvent{Action: "UPDATE_DIST_ROLLBACK", TargetType: "updates", TargetID: fmt.Sprint(result["version"]), ActorType: "local_ui", Details: result}); auditErr != nil {
			return map[string]any{"success": false, "code": "REQUEST_FAILED", "message": fmt.Sprintf("audit update rollback: %v", auditErr)}
		}
	}
	return result
}
func (a *App) GetStartupSetting() map[string]any { return platform.GetStartupSetting() }
func (a *App) SetStartupSetting(settings map[string]any) map[string]any {
	return platform.SetStartupSetting(settings)
}

func (a *App) TriggerScheduleFeedImport(feedID string) map[string]any {
	feed, err := a.store.Get(a.context(), "schedule_feeds", feedID)
	if err != nil {
		return map[string]any{"success": false, "code": "NOT_FOUND", "message": "schedule feed not found"}
	}
	path := importer.ResolveSchedulePath(feed)
	smbCleanup, mountErr := a.mountImportDirectory(filepath.Dir(path))
	if mountErr != nil {
		return map[string]any{"success": false, "message": mountErr.Error()}
	}
	defer func() { _ = smbCleanup() }()
	items, err := importer.ParseScheduleFile(path, feedID)
	if err != nil {
		a.emit("schedule-imported", map[string]any{"success": false, "feedId": feedID, "message": err.Error()})
		return map[string]any{"success": false, "message": err.Error()}
	}
	if err := a.store.Write(a.context(), func(db database.DB) error {
		rows := database.Rows(db, "schedule_items")
		kept := rows[:0]
		for _, row := range rows {
			if fmt.Sprint(row["feed_id"]) != feedID {
				kept = append(kept, row)
			}
		}
		for _, item := range items {
			kept = append(kept, map[string]any{"id": item.ID, "feed_id": item.FeedID, "title": item.Title, "start_ms": item.StartsAt, "end_ms": item.EndsAt, "location": item.Location})
		}
		database.SetRows(db, "schedule_items", kept)
		return nil
	}); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	a.emit("schedule-imported", map[string]any{"success": true, "feedId": feedID, "count": len(items), "fileName": filepath.Base(path)})
	return map[string]any{"success": true, "feedId": feedID, "count": len(items)}
}

func (a *App) ReloadScheduleFeedTriggers() map[string]any {
	a.startScheduleTriggers(a.context())
	return map[string]any{"success": true}
}
func (a *App) SetPowerSave(prevent bool) map[string]any {
	if err := platform.SetPowerSave(prevent); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "prevent": prevent}
}
func (a *App) RelaunchApp() map[string]any {
	if err := platform.Relaunch(); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true}
}
func (a *App) AppendDebugLog(line string) map[string]any {
	if err := platform.AppendDebugLog(a.dataDir, line); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true}
}
func (a *App) OpenDebugLog() map[string]any {
	return map[string]any{"success": true, "path": platform.DebugLogPath(a.dataDir)}
}
func (a *App) SelectFolder() map[string]any {
	return map[string]any{"success": true, "path": platform.SelectFolder()}
}
func (a *App) ReadCsvHeaders(path, encoding string) map[string]any {
	path = strings.TrimSpace(path)
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		entries, readErr := os.ReadDir(path)
		if readErr != nil {
			return map[string]any{"success": false, "message": readErr.Error()}
		}
		for _, entry := range entries {
			if !entry.IsDir() && strings.EqualFold(filepath.Ext(entry.Name()), ".csv") {
				path = filepath.Join(path, entry.Name())
				break
			}
		}
	}
	headers, detected, err := importer.ReadHeaders(path, importer.Encoding(encoding))
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "headers": headers, "encoding": detected}
}

func (a *App) isConfiguredScheduleFolder(ctx context.Context, folder string) bool {
	folder = strings.TrimSpace(folder)
	if folder == "" {
		return false
	}
	feeds, err := a.store.List(ctx, "schedule_feeds")
	if err != nil {
		return false
	}
	for _, feed := range feeds {
		configured := strings.TrimSpace(fmt.Sprint(feed["watch_dir"]))
		if configured != "" && strings.EqualFold(filepath.Clean(configured), filepath.Clean(folder)) {
			return true
		}
	}
	return false
}

func (a *App) watchDirectory() string {
	value, _ := database.SettingValue(a.store, "import_directory")
	return value
}

// Keep the updater package in the application dependency graph while the
// distribution policy is being finalized.
var _ = updater.Manifest{}
