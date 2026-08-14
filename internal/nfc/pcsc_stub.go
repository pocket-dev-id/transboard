//go:build !windows

package nfc

import (
	"context"
	"fmt"
)

type PCSCReader struct{}

func (PCSCReader) Run(context.Context, func(string)) error {
	return fmt.Errorf("PC/SC is only supported on Windows")
}
