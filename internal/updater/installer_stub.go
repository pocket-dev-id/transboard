//go:build !windows

package updater

import "fmt"

func Install(string) error { return fmt.Errorf("installer is only supported on Windows") }
