//go:build windows

package windows

import (
	"golang.org/x/sys/windows/registry"
	"os"
	"path/filepath"
)

const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`
const runValueName = "TransBoard"

func GetStartupSetting() map[string]any {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return map[string]any{"success": true, "enabled": false}
	}
	defer key.Close()
	value, _, err := key.GetStringValue(runValueName)
	return map[string]any{"success": true, "enabled": err == nil && value != "", "command": value}
}

func SetStartupSetting(settings map[string]any) map[string]any {
	enabled, _ := settings["enabled"].(bool)
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	defer key.Close()
	if !enabled {
		if err := key.DeleteValue(runValueName); err != nil && err != registry.ErrNotExist {
			return map[string]any{"success": false, "message": err.Error()}
		}
		return map[string]any{"success": true, "enabled": false}
	}
	executable, err := os.Executable()
	if err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	command := `"` + filepath.Clean(executable) + `"`
	if err := key.SetStringValue(runValueName, command); err != nil {
		return map[string]any{"success": false, "message": err.Error()}
	}
	return map[string]any{"success": true, "enabled": true, "command": command}
}
