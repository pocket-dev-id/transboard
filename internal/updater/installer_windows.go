//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func Install(path string) error {
	if path == "" {
		return fmt.Errorf("installer path is empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve installer path: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return fmt.Errorf("stat installer: %w", err)
	}
	if info.IsDir() || !strings.EqualFold(filepath.Ext(absolute), ".exe") {
		return fmt.Errorf("installer must be an .exe file")
	}
	// The manifest SHA-256 is verified before this function is called. Start
	// the installer directly without a shell so a path can never become a
	// command fragment. Authenticode policy can be added at this boundary.
	command := exec.Command(absolute)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start installer: %w", err)
	}
	return nil
}
