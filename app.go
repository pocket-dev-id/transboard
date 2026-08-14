package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/pocket-dev-id/transboard/internal/application"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the small Wails-facing facade. Business logic remains in
// internal/application and lower layers so bindings do not become a god object.
type App struct {
	service *application.App
	ctx     context.Context
}

func NewApp(service *application.App) *App {
	return &App{service: service}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.service.SetEventSink(func(name string, payload any) {
		runtime.EventsEmit(ctx, name, payload)
	})
	if err := a.service.Start(ctx); err != nil {
		runtime.EventsEmit(ctx, "backend-error", map[string]any{"message": err.Error()})
	}
}

func (a *App) shutdown(ctx context.Context) {
	if err := a.service.Stop(ctx); err != nil {
		runtime.EventsEmit(ctx, "backend-error", map[string]any{"message": err.Error()})
	}
}

// The embedded service exposes the compatibility binding surface. Keeping this
// type in package main makes Wails generate window.go.main.App.* bindings.
func (a *App) GetLocalIPs() []string { return a.service.GetLocalIPs() }
func (a *App) GetHostname() string   { return a.service.GetHostname() }

func (a *App) ToggleFullscreen() map[string]any {
	if a.ctx != nil {
		isFullscreen := runtime.WindowIsFullscreen(a.ctx)
		if isFullscreen {
			runtime.WindowUnfullscreen(a.ctx)
		} else {
			runtime.WindowFullscreen(a.ctx)
		}
		isFullscreen = !isFullscreen
		runtime.EventsEmit(a.ctx, "fullscreen-changed", isFullscreen)
		return map[string]any{"success": true, "fullscreen": isFullscreen}
	}
	return map[string]any{"success": false, "message": "window is not ready"}
}

func (a *App) SetAlwaysOnTop(value bool) map[string]any {
	if a.ctx == nil {
		return map[string]any{"success": false, "message": "window is not ready"}
	}
	runtime.WindowSetAlwaysOnTop(a.ctx, value)
	return map[string]any{"success": true, "alwaysOnTop": value}
}

func (a *App) SetPowerSave(prevent bool) map[string]any {
	return a.service.SetPowerSave(prevent)
}

func (a *App) IsDevMode() bool { return a.service.IsDevMode() }

// Explicit forwarding methods keep the public compatibility surface visible to
// code review and avoid depending on reflection of embedded methods.
func (a *App) CompleteDataImport(payload map[string]any) map[string]any {
	return a.service.CompleteDataImport(payload)
}
func (a *App) GetWatchDirectory() map[string]any { return a.service.GetWatchDirectory() }
func (a *App) UpdateWatchDirectory(path string) map[string]any {
	return a.service.UpdateWatchDirectory(path)
}
func (a *App) ResetDatabase(token string) map[string]any   { return a.service.ResetDatabase(token) }
func (a *App) DBRequest(req map[string]any) map[string]any { return a.service.DBRequest(req) }
func (a *App) WebrtcRequest(req map[string]any) map[string]any {
	return a.service.WebrtcRequest(req)
}
func (a *App) ParentHttpRequest(req map[string]any) map[string]any {
	return a.service.ParentHttpRequest(req)
}
func (a *App) TriggerManualImport() map[string]any { return a.service.TriggerManualImport() }
func (a *App) TestOdbcConnection(config map[string]any) map[string]any {
	return a.service.TestOdbcConnection(config)
}
func (a *App) RunOdbcSync(config map[string]any) map[string]any {
	return a.service.RunOdbcSync(config)
}
func (a *App) PreviewOdbcQuery(config map[string]any) map[string]any {
	return a.service.PreviewOdbcQuery(config)
}
func (a *App) RelaunchApp() map[string]any { return a.service.RelaunchApp() }
func (a *App) BackupDatabase(options map[string]any) map[string]any {
	if options == nil {
		options = map[string]any{}
	}
	if strings.TrimSpace(fmt.Sprint(options["path"])) == "" {
		if a.ctx == nil {
			return map[string]any{"success": false, "message": "window is not ready"}
		}
		path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
			Title:           "Save TransBoard backup",
			DefaultFilename: "transboard-backup-" + time.Now().Format("20060102") + ".json",
			Filters:         []runtime.FileFilter{{DisplayName: "JSON files", Pattern: "*.json"}},
		})
		if err != nil {
			return map[string]any{"success": false, "message": err.Error()}
		}
		if strings.TrimSpace(path) == "" {
			return map[string]any{"success": false, "code": "CANCELLED", "message": "backup was cancelled"}
		}
		options["path"] = path
	}
	return a.service.BackupDatabase(options)
}
func (a *App) RestoreDatabase(options map[string]any) map[string]any {
	if options == nil {
		options = map[string]any{}
	}
	if strings.TrimSpace(fmt.Sprint(options["path"])) == "" {
		if a.ctx == nil {
			return map[string]any{"success": false, "message": "window is not ready"}
		}
		path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
			Title:   "Open TransBoard backup",
			Filters: []runtime.FileFilter{{DisplayName: "JSON files", Pattern: "*.json"}},
		})
		if err != nil {
			return map[string]any{"success": false, "message": err.Error()}
		}
		if strings.TrimSpace(path) == "" {
			return map[string]any{"success": false, "code": "CANCELLED", "message": "restore was cancelled"}
		}
		options["path"] = path
	}
	return a.service.RestoreDatabase(options)
}
func (a *App) GetDatabaseStorageInfo() map[string]any { return a.service.GetDatabaseStorageInfo() }
func (a *App) ChangeDatabaseStorageMode(mode string) map[string]any {
	return a.service.ChangeDatabaseStorageMode(mode)
}
func (a *App) GetEncryptionStatus() map[string]any { return a.service.GetEncryptionStatus() }
func (a *App) GetArchiveInfo() map[string]any      { return a.service.GetArchiveInfo() }
func (a *App) GetDbInfo() map[string]any           { return a.service.GetDbInfo() }
func (a *App) ExportDiagnosticsBundle() map[string]any {
	return a.service.ExportDiagnosticsBundle()
}
func (a *App) GetAppVersion() string             { return a.service.GetAppVersion() }
func (a *App) GetPasscodeStatus() map[string]any { return a.service.GetPasscodeStatus() }
func (a *App) VerifyAdminPasscode(passcode string) map[string]any {
	return a.service.VerifyAdminPasscode(passcode)
}
func (a *App) SetAdminPasscode(passcode string) map[string]any {
	return a.service.SetAdminPasscode(passcode)
}
func (a *App) GetTerminalApiToken() map[string]any { return a.service.GetTerminalApiToken() }
func (a *App) SetTerminalApiToken(token string) map[string]any {
	return a.service.SetTerminalApiToken(token)
}
func (a *App) GetTerminalRole() map[string]any { return a.service.GetTerminalRole() }
func (a *App) SetTerminalRole(role string) map[string]any {
	return a.service.SetTerminalRole(role)
}
func (a *App) CleanupEventRetention() map[string]any {
	return a.service.CleanupEventRetention()
}
func (a *App) CheckForUpdate(options map[string]any) map[string]any {
	return a.service.CheckForUpdate(options)
}
func (a *App) DownloadAndInstallUpdate(options map[string]any) map[string]any {
	return a.service.DownloadAndInstallUpdate(options)
}
func (a *App) GetUpdateDistInfo() map[string]any { return a.service.GetUpdateDistInfo() }
func (a *App) ImportUpdateFiles() map[string]any {
	if a.ctx == nil {
		return map[string]any{"success": false, "message": "window is not ready"}
	}
	ymlPath, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Go manifest.json or legacy latest.yml",
		Filters: []runtime.FileFilter{{DisplayName: "TransBoard update manifest", Pattern: "*.json;*.yml"}},
	})
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if strings.TrimSpace(ymlPath) == "" {
		return map[string]any{"success": false, "code": "CANCELLED", "canceled": true}
	}
	exePath, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Select TransBoard installer",
		Filters: []runtime.FileFilter{{DisplayName: "TransBoard installer", Pattern: "*.exe"}},
	})
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	if strings.TrimSpace(exePath) == "" {
		return map[string]any{"success": false, "code": "CANCELLED", "canceled": true}
	}
	return a.service.ImportUpdateFilesFromPaths(ymlPath, exePath)
}
func (a *App) RollbackUpdateDist() map[string]any { return a.service.RollbackUpdateDist() }
func (a *App) GetStartupSetting() map[string]any  { return a.service.GetStartupSetting() }
func (a *App) SetStartupSetting(settings map[string]any) map[string]any {
	return a.service.SetStartupSetting(settings)
}
func (a *App) TriggerScheduleFeedImport(feedID string) map[string]any {
	return a.service.TriggerScheduleFeedImport(feedID)
}
func (a *App) ReloadScheduleFeedTriggers() map[string]any {
	return a.service.ReloadScheduleFeedTriggers()
}
func (a *App) GetOdbcDsns() map[string]any { return a.service.GetOdbcDsns() }
func (a *App) GetOdbcTables(config map[string]any) map[string]any {
	return a.service.GetOdbcTables(config)
}
func (a *App) AppendDebugLog(line string) map[string]any {
	return a.service.AppendDebugLog(line)
}
func (a *App) OpenDebugLog() map[string]any { return a.service.OpenDebugLog() }
func (a *App) SelectFolder() map[string]any {
	if a.ctx == nil {
		return map[string]any{"success": false, "message": "window is not ready"}
	}
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "Select TransBoard folder"})
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "path": path}
}
func (a *App) ReadCsvHeaders(path string, encoding string) map[string]any {
	return a.service.ReadCsvHeaders(path, encoding)
}
