package importer

import (
	"fmt"
	"os"
	"strings"
)

type SMBConfig struct {
	Path           string
	Username       string
	Password       string
	UseCurrentUser bool
}

func ValidateSMBPath(config SMBConfig) error {
	if !strings.HasPrefix(config.Path, `\\`) {
		return fmt.Errorf("SMB path must be a UNC path")
	}
	if !config.UseCurrentUser && config.Username == "" {
		return fmt.Errorf("SMB username is required")
	}
	return nil
}

// MountSMB establishes an explicit Windows network session when requested and
// returns a cleanup function for the watcher lifecycle. Current-user UNC
// access does not need a separate session.
func MountSMB(config SMBConfig) (func() error, error) {
	if err := ValidateSMBPath(config); err != nil {
		return nil, err
	}
	if config.UseCurrentUser {
		return func() error { return nil }, nil
	}
	return mountSMBExplicit(config)
}

func OpenSMB(config SMBConfig) (*os.File, error) {
	if err := ValidateSMBPath(config); err != nil {
		return nil, err
	}
	// Windows resolves current-user UNC access through the normal filesystem.
	if config.UseCurrentUser {
		return os.Open(config.Path)
	}
	return openSMBExplicit(config)
}
