//go:build windows

package importer

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

type netResource struct {
	dwScope       uint32
	dwType        uint32
	dwDisplayType uint32
	dwUsage       uint32
	lpLocalName   *uint16
	lpRemoteName  *uint16
	lpComment     *uint16
	lpProvider    *uint16
}

var mpr = syscall.NewLazyDLL("mpr.dll")
var wNetAddConnection2 = mpr.NewProc("WNetAddConnection2W")
var wNetCancelConnection2 = mpr.NewProc("WNetCancelConnection2W")

func openSMBExplicit(config SMBConfig) (*os.File, error) {
	cleanup, err := mountSMBExplicit(config)
	if err != nil {
		return nil, err
	}
	file, openErr := os.Open(config.Path)
	if openErr != nil {
		_ = cleanup()
		return nil, openErr
	}
	// OpenSMB is a short-lived compatibility helper. The watcher uses
	// MountSMB when it needs a longer-lived session.
	return file, nil
}

func mountSMBExplicit(config SMBConfig) (func() error, error) {
	remote, err := syscall.UTF16PtrFromString(config.Path)
	if err != nil {
		return nil, err
	}
	username, err := syscall.UTF16PtrFromString(config.Username)
	if err != nil {
		return nil, err
	}
	password, err := syscall.UTF16PtrFromString(config.Password)
	if err != nil {
		return nil, err
	}
	resource := netResource{dwType: 1, lpRemoteName: remote}
	result, _, callErr := wNetAddConnection2.Call(uintptr(unsafe.Pointer(&resource)), uintptr(unsafe.Pointer(password)), uintptr(unsafe.Pointer(username)), 0)
	if result != 0 {
		return nil, fmt.Errorf("connect SMB share: 0x%x: %w", result, callErr)
	}
	return func() error {
		result, _, callErr := wNetCancelConnection2.Call(uintptr(unsafe.Pointer(remote)), 0, 1)
		if result != 0 {
			return fmt.Errorf("disconnect SMB share: 0x%x: %w", result, callErr)
		}
		return nil
	}, nil
}
