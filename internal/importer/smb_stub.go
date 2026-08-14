//go:build !windows

package importer

import (
	"fmt"
	"os"
)

func mountSMBExplicit(SMBConfig) (func() error, error) {
	return nil, fmt.Errorf("explicit SMB credentials are only supported on Windows")
}

func openSMBExplicit(SMBConfig) (*os.File, error) {
	return nil, fmt.Errorf("explicit SMB credentials are only supported on Windows")
}
