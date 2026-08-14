package database

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/pocket-dev-id/transboard/internal/security"
)

const staleLockAfter = 2 * time.Minute

func acquireFileLock(path string) (func(), error) {
	lockPath := path + ".lock"
	if info, err := os.Stat(lockPath); err == nil && time.Since(info.ModTime()) > staleLockAfter {
		_ = os.Remove(lockPath)
	}
	file, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, fmt.Errorf("acquire database lock: %w", err)
	}
	if _, err := file.WriteString(fmt.Sprintf("pid=%d\ntime=%s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339Nano))); err != nil {
		_ = file.Close()
		_ = os.Remove(lockPath)
		return nil, fmt.Errorf("write database lock: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(lockPath)
		return nil, fmt.Errorf("close database lock: %w", err)
	}
	return func() { _ = os.Remove(lockPath) }, nil
}

func WriteJSONAtomic(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal atomic JSON: %w", err)
	}
	return WriteBytesAtomic(path, data)
}

func WriteBytesAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create database directory: %w", err)
	}
	release, err := acquireFileLock(path)
	if err != nil {
		return err
	}
	defer release()

	tmpPath := path + ".tmp"
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("open atomic temporary file: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("write atomic temporary file: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("flush atomic temporary file: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close atomic temporary file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		// Windows versions that reject replacing an existing file need this
		// compatibility fallback. The lock prevents concurrent writers.
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			return fmt.Errorf("replace database file: %w", err)
		}
		if retryErr := os.Rename(tmpPath, path); retryErr != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("rename atomic database file: %w", retryErr)
		}
	}
	return nil
}

func ReadFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}

func RecoverTemporary(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	release, err := acquireFileLock(path)
	if err != nil {
		return err
	}
	defer release()
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	tmpPath := path + ".tmp"
	data, err := os.ReadFile(tmpPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read stale database temporary file: %w", err)
	}
	if len(data) == 0 {
		return fmt.Errorf("stale database temporary file is empty")
	}
	decoded, decodeErr := Decode(data)
	if decodeErr != nil {
		plain, envelopeErr := security.DecodeDatabaseContent(string(data))
		if envelopeErr != nil {
			return fmt.Errorf("stale database temporary file is invalid: %w", decodeErr)
		}
		decoded, decodeErr = Decode([]byte(plain))
		if decodeErr != nil {
			return fmt.Errorf("stale database temporary file is invalid: %w", decodeErr)
		}
	}
	_ = decoded
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("recover stale database temporary file: %w", err)
	}
	return nil
}

func CopyFile(source, destination string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("read backup source: %w", err)
	}
	if err := os.WriteFile(destination, data, 0600); err != nil {
		return fmt.Errorf("write backup copy: %w", err)
	}
	return nil
}
