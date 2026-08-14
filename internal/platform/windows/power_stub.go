//go:build !windows

package windows

func SetPowerSave(bool) error { return nil }
