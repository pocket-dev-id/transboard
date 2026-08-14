package security

import (
	"encoding/base64"
	"fmt"
	"strings"
)

const (
	SensitivePrefix = "ENCRYPTED:"
	DBPrefix        = "ENCDB1:"
	GoDBPrefix      = "DPAPI1:"
)

func EncryptSensitiveValue(value string) (string, error) {
	if value == "" || strings.HasPrefix(value, SensitivePrefix) {
		return value, nil
	}
	data, err := Protect([]byte(value))
	if err != nil {
		return "", fmt.Errorf("encrypt sensitive value: %w", err)
	}
	return SensitivePrefix + base64.StdEncoding.EncodeToString(data), nil
}

func DecryptSensitiveValue(value string) (string, error) {
	if value == "" || !strings.HasPrefix(value, SensitivePrefix) {
		return value, nil
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, SensitivePrefix))
	if err != nil {
		return "", fmt.Errorf("decode encrypted value: %w", err)
	}
	plain, err := Unprotect(data)
	if err != nil {
		return "", fmt.Errorf("decrypt sensitive value: %w", err)
	}
	return string(plain), nil
}

func EncryptDatabaseContent(plain string) (string, error) {
	data, err := Protect([]byte(plain))
	if err != nil {
		return "", err
	}
	return GoDBPrefix + base64.StdEncoding.EncodeToString(data), nil
}

func DecodeDatabaseContent(raw string) (string, error) {
	prefix := ""
	switch {
	case strings.HasPrefix(raw, GoDBPrefix):
		prefix = GoDBPrefix
	case strings.HasPrefix(raw, DBPrefix):
		// ENCDB1 is the Electron safeStorage envelope. The payload is kept
		// intact on failure because Chromium OSCrypt may require the old
		// profile key and cannot always be decoded by DPAPI alone.
		prefix = DBPrefix
	default:
		return raw, nil
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, prefix))
	if err != nil {
		return "", fmt.Errorf("decode encrypted database: %w", err)
	}
	plain, err := Unprotect(data)
	if err != nil {
		return "", fmt.Errorf("decrypt Electron safeStorage database failed; keep the original file and use the Electron version for recovery: %w", err)
	}
	return string(plain), nil
}

func EncryptionAvailable() bool {
	_, err := Protect([]byte("transboard-probe"))
	return err == nil
}
