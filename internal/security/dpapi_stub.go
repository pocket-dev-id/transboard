//go:build !windows

package security

import "errors"

var ErrDPAPIUnavailable = errors.New("Windows DPAPI is unavailable on this platform")

func Protect([]byte) ([]byte, error)   { return nil, ErrDPAPIUnavailable }
func Unprotect([]byte) ([]byte, error) { return nil, ErrDPAPIUnavailable }
