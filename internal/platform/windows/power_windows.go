//go:build windows

package windows

import (
	"fmt"
	"syscall"
)

const (
	esContinuous      uint32 = 0x80000000
	esSystemRequired  uint32 = 0x00000001
	esDisplayRequired uint32 = 0x00000002
)

var setThreadExecutionState = syscall.NewLazyDLL("kernel32.dll").NewProc("SetThreadExecutionState")

func SetPowerSave(prevent bool) error {
	flags := uint32(0)
	if prevent {
		flags = esContinuous | esSystemRequired | esDisplayRequired
	}
	result, _, err := setThreadExecutionState.Call(uintptr(flags))
	if result == 0 {
		return fmt.Errorf("SetThreadExecutionState: %w", err)
	}
	return nil
}
