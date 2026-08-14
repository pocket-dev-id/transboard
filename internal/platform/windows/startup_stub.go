//go:build !windows

package windows

func GetStartupSetting() map[string]any {
	return map[string]any{"success": false, "enabled": false, "message": "startup settings are only supported on Windows"}
}
func SetStartupSetting(settings map[string]any) map[string]any {
	return map[string]any{"success": false, "enabled": false, "message": "startup settings are only supported on Windows"}
}
