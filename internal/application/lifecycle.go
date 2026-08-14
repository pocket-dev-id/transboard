package application

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocket-dev-id/transboard/internal/database"
	beddomain "github.com/pocket-dev-id/transboard/internal/domain/bed"
	"github.com/pocket-dev-id/transboard/internal/importer"
	"github.com/pocket-dev-id/transboard/internal/security"
)

func dataDirectory(override string) (string, error) {
	if strings.TrimSpace(override) != "" {
		return override, nil
	}
	if value := os.Getenv("TRANSBOARD_DATA_DIR"); value != "" {
		return value, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "transboard"), nil
}

func (a *App) startWatcher(ctx context.Context, directory string) {
	if strings.TrimSpace(directory) == "" {
		return
	}
	smbCleanup, smbErr := a.mountImportDirectory(directory)
	if smbErr != nil {
		a.emit("data-import-failed", map[string]any{"error": smbErr.Error()})
		return
	}
	pipeline := &importer.Pipeline{
		Mapping:  a.importMapping(),
		OnImport: a.applyImport,
		OnError: func(err error) {
			a.emit("data-import-failed", map[string]any{"error": err.Error()})
		},
	}
	watcher, err := importer.NewWatcher(pipeline)
	if err != nil {
		_ = smbCleanup()
		a.emit("data-import-failed", map[string]any{"error": err.Error()})
		return
	}
	watcherCtx, cancel := context.WithCancel(ctx)
	a.mu.Lock()
	a.watcherCancel = cancel
	a.mu.Unlock()
	watcher.OnArchive = func(path string, archiveErr error) {
		if archiveErr != nil {
			a.emit("archive-error", map[string]any{
				"path":       path,
				"fileName":   filepath.Base(path),
				"archiveDir": filepath.Join(filepath.Dir(path), "archive"),
				"error":      archiveErr.Error(),
				"message":    archiveErr.Error(),
			})
		}
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		defer func() { _ = smbCleanup() }()
		if err := watcher.Run(watcherCtx, directory, importer.EncodingAuto); err != nil && watcherCtx.Err() == nil {
			a.emit("data-import-failed", map[string]any{"error": err.Error()})
		}
	}()
}

func (a *App) mountImportDirectory(directory string) (func() error, error) {
	if !strings.HasPrefix(directory, `\\`) {
		return func() error { return nil }, nil
	}
	mode, _ := database.SettingValue(a.store, "smb_auth_mode")
	config := importer.SMBConfig{
		Path:           directory,
		UseCurrentUser: strings.TrimSpace(mode) != "custom",
	}
	if !config.UseCurrentUser {
		config.Username, _ = database.SettingValue(a.store, "smb_username")
		passwordValue, _ := database.SettingValue(a.store, "smb_password")
		password, err := security.DecryptSensitiveValue(passwordValue)
		if err != nil {
			return nil, fmt.Errorf("decrypt SMB password: %w", err)
		}
		config.Password = password
	}
	return importer.MountSMB(config)
}

func (a *App) applyImport(ctx context.Context, result importer.Result) error {
	source := "csv_import"
	if result.Path == "odbc" {
		source = "odbc_import"
	}
	err := a.store.Write(ctx, func(db database.DB) error {
		beds := database.Rows(db, "beds")
		occupancy := database.Rows(db, "bed_occupancy_log")
		seen := map[string]bool{}
		listed := map[string]bool{}
		admissionMode := database.SettingValueFromDB(db, "admission_mode", "csv")
		for _, record := range result.Records {
			index := findImportBed(beds, record)
			if index < 0 {
				continue
			}
			bed := beds[index]
			bedID := strings.TrimSpace(fmt.Sprint(bed["id"]))
			listed[bedID] = true
			if seen[bedID] {
				continue
			}
			seen[bedID] = true
			if admissionMode == "hybrid" && truthy(bed["manually_registered"]) {
				continue
			}
			before := cloneImportRow(bed)
			patientID := strings.TrimSpace(record.PatientID)
			patientName := strings.TrimSpace(record.PatientName)
			hasPatient := patientID != "" || patientName != ""
			if patientName == "空床" {
				hasPatient = false
			}
			if hasPatient {
				bed["patient_id"] = nullableImport(patientID)
				bed["patient_name"] = nullableImport(patientName)
			} else {
				bed["patient_id"] = nil
				bed["patient_name"] = nil
			}
			if record.HasPresence {
				bed["is_present"] = record.Present && hasPatient
			} else {
				bed["is_present"] = hasPatient
			}
			now := time.Now().UnixMilli()
			bed["updated_at"] = now
			occupancy = beddomain.ApplyOccupancyTransition(occupancy, bedID, fmt.Sprint(bed["ward_id"]), before, bed, map[string]any{}, now, source)
			beds[index] = bed
		}
		policy := struct {
			ClearUnlisted bool `json:"clearUnlisted"`
		}{}
		if raw := database.SettingValueFromDB(db, "import_retention_policy", "{}"); raw != "" {
			_ = json.Unmarshal([]byte(raw), &policy)
		}
		if policy.ClearUnlisted {
			for index, bed := range beds {
				bedID := strings.TrimSpace(fmt.Sprint(bed["id"]))
				if listed[bedID] || (admissionMode == "hybrid" && truthy(bed["manually_registered"])) {
					continue
				}
				before := cloneImportRow(bed)
				bed["patient_id"], bed["patient_name"], bed["is_present"] = nil, nil, false
				now := time.Now().UnixMilli()
				bed["updated_at"] = now
				if beddomain.HasOccupant(before) {
					occupancy = beddomain.ApplyOccupancyTransition(occupancy, bedID, fmt.Sprint(bed["ward_id"]), before, bed, map[string]any{}, now, "csv_clear")
				}
				beds[index] = bed
			}
		}
		database.SetRows(db, "beds", beds)
		occupancy, _ = beddomain.PruneOccupancy(occupancy, parseSettingInt(database.SettingValueFromDB(db, "bed_occupancy_retention_days", "7")), 20000, time.Now().UnixMilli())
		database.SetRows(db, "bed_occupancy_log", occupancy)
		imports := database.Rows(db, "import_logs")
		imports = append(imports, map[string]any{"id": fmt.Sprintf("import-%d", time.Now().UnixNano()), "path": result.Path, "rows": result.Rows, "encoding": result.Encoding, "status": "success", "created_at": time.Now().UnixMilli()})
		if len(imports) > 100 {
			imports = imports[len(imports)-100:]
		}
		database.SetRows(db, "import_logs", imports)
		return nil
	})
	if err != nil {
		return err
	}
	a.emit("data-imported", map[string]any{"fileName": filepath.Base(result.Path), "rows": result.Rows, "encoding": result.Encoding})
	return nil
}

func (a *App) importMapping() importer.Mapping {
	raw, ok := database.SettingValue(a.store, "import_mapping")
	if !ok || strings.TrimSpace(raw) == "" {
		return importer.NormalizeMapping(map[string]any{})
	}
	var values map[string]any
	if json.Unmarshal([]byte(raw), &values) != nil {
		return importer.NormalizeMapping(map[string]any{})
	}
	return importer.NormalizeMapping(values)
}

func findImportBed(beds []map[string]any, record importer.Record) int {
	for index, bed := range beds {
		if record.BedNumber != "" && strings.EqualFold(strings.TrimSpace(fmt.Sprint(bed["bed_number"])), record.BedNumber) {
			return index
		}
		if record.RoomCode == "" || record.BedCode == "" {
			continue
		}
		room := strings.TrimSpace(fmt.Sprint(bed["room_code"]))
		if room == "" || room == "<nil>" {
			room = strings.TrimSpace(fmt.Sprint(bed["room_number"]))
		}
		bedCode := strings.TrimSpace(fmt.Sprint(bed["bed_code"]))
		bedNumber := strings.TrimSpace(fmt.Sprint(bed["bed_number"]))
		if strings.EqualFold(room, record.RoomCode) && (strings.EqualFold(bedCode, record.BedCode) || strings.EqualFold(bedNumber, record.BedCode)) {
			return index
		}
	}
	return -1
}

func cloneImportRow(row map[string]any) map[string]any {
	copy := make(map[string]any, len(row))
	for key, value := range row {
		copy[key] = value
	}
	return copy
}

func nullableImport(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true") || strings.TrimSpace(typed) == "1"
	default:
		return false
	}
}

func (a *App) startScheduleTriggers(parent context.Context) {
	a.mu.Lock()
	if a.ctx == nil {
		a.mu.Unlock()
		return
	}
	if a.scheduleCancel != nil {
		a.scheduleCancel()
	}
	ctx, cancel := context.WithCancel(parent)
	a.scheduleCancel = cancel
	a.mu.Unlock()
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		a.scheduleLoop(ctx)
	}()
}

func (a *App) scheduleLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	lastIntervalRun := time.Time{}
	lastClockRun := ""
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			setting, ok := database.SettingValue(a.store, "import_schedule")
			if !ok || strings.TrimSpace(setting) == "" {
				continue
			}
			var config struct {
				Mode        string   `json:"mode"`
				IntervalMin string   `json:"intervalMin"`
				Times       []string `json:"times"`
			}
			if json.Unmarshal([]byte(setting), &config) != nil {
				continue
			}
			switch config.Mode {
			case "interval":
				minutes := parseSettingInt(config.IntervalMin)
				if minutes <= 0 {
					minutes = 10
				}
				if lastIntervalRun.IsZero() || now.Sub(lastIntervalRun) >= time.Duration(minutes)*time.Minute {
					a.importActiveScheduleFeeds(ctx)
					lastIntervalRun = now
				}
			case "time":
				clock := now.Format("15:04")
				if containsString(config.Times, clock) && lastClockRun != now.Format("2006-01-02 15:04") {
					a.importActiveScheduleFeeds(ctx)
					lastClockRun = now.Format("2006-01-02 15:04")
				}
			}
		}
	}
}

func (a *App) importActiveScheduleFeeds(ctx context.Context) {
	feeds, err := a.store.List(ctx, "schedule_feeds")
	if err != nil {
		return
	}
	for _, feed := range feeds {
		active := feed["is_active"] != false
		if !active {
			continue
		}
		feedID := strings.TrimSpace(fmt.Sprint(feed["id"]))
		if feedID == "" {
			continue
		}
		_ = a.TriggerScheduleFeedImport(feedID)
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == expected {
			return true
		}
	}
	return false
}
