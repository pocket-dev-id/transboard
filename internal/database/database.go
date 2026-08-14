package database

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocket-dev-id/transboard/internal/security"
)

type Store struct {
	mu              sync.RWMutex
	path            string
	auditPath       string
	backupPath      string
	db              DB
	opened          bool
	encryptedOnDisk bool
}

func NewStore(path string) *Store {
	return &Store{
		path:       path,
		auditPath:  filepath.Join(filepath.Dir(path), "audit-log.jsonl"),
		backupPath: path + ".bak",
	}
}

func (s *Store) Path() string      { return s.path }
func (s *Store) AuditPath() string { return s.auditPath }

func (s *Store) Open(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.opened {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}
	if err := RecoverTemporary(s.path); err != nil {
		return err
	}
	var db DB
	data, readErr := os.ReadFile(s.path)
	databaseExists := readErr == nil
	if os.IsNotExist(readErr) {
		db = NewEmptyDB()
	} else if readErr != nil {
		return fmt.Errorf("read database: %w", readErr)
	} else {
		raw := string(data)
		s.encryptedOnDisk = strings.HasPrefix(raw, security.GoDBPrefix) || strings.HasPrefix(raw, security.DBPrefix)
		plain, decodeErr := security.DecodeDatabaseContent(string(data))
		if decodeErr != nil {
			return decodeErr
		}
		decoded, dbErr := Decode([]byte(plain))
		if dbErr != nil {
			return fmt.Errorf("decode database: %w", dbErr)
		}
		db = decoded
	}
	if !databaseExists && security.EncryptionAvailable() {
		s.encryptedOnDisk = true
	}

	migrated, report, err := Migrate(db)
	if err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	if databaseExists && !s.encryptedOnDisk && security.EncryptionAvailable() {
		// A legacy plaintext database is migrated to the Go DPAPI envelope on
		// the same guarded write as schema migration. The original remains in
		// .pre-go-migration until the operator removes it.
		s.encryptedOnDisk = true
		report.Changed = true
	}
	if report.Changed && databaseExists {
		if _, statErr := os.Stat(s.path); statErr == nil {
			if backupErr := CopyFile(s.path, s.path+".pre-go-migration"); backupErr != nil {
				return backupErr
			}
		}
	}
	s.db = migrated
	s.opened = true
	if !databaseExists || report.Changed {
		if writeErr := s.writeLocked(migrated); writeErr != nil {
			return writeErr
		}
	}
	_ = ctx
	return nil
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.opened = false
	s.db = nil
	return nil
}

func (s *Store) Snapshot() (DB, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.opened {
		return nil, fmt.Errorf("database is not open")
	}
	return Clone(s.db)
}

func (s *Store) Write(ctx context.Context, mutate func(DB) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.opened {
		return fmt.Errorf("database is not open")
	}
	working, err := Clone(s.db)
	if err != nil {
		return err
	}
	if err := mutate(working); err != nil {
		return err
	}
	EnsureTables(working)
	if err := s.writeLocked(working); err != nil {
		return err
	}
	s.db = working
	_ = ctx
	return nil
}

func (s *Store) writeLocked(db DB) error {
	data, err := Encode(db)
	if err != nil {
		return err
	}
	output := data
	if s.encryptedOnDisk {
		protected, protectErr := security.EncryptDatabaseContent(string(data))
		if protectErr != nil {
			return fmt.Errorf("encrypt database: %w", protectErr)
		}
		output = []byte(protected)
	}
	if err := WriteBytesAtomic(s.path, output); err != nil {
		return err
	}
	// Keep the legacy .bak contract while throttling copies to avoid an extra
	// large I/O operation for every UI field update.
	if info, statErr := os.Stat(s.backupPath); os.IsNotExist(statErr) || (statErr == nil && time.Since(info.ModTime()) > time.Minute) {
		_ = CopyFile(s.path, s.backupPath)
	}
	return nil
}

func (s *Store) ReplaceFromJSON(ctx context.Context, data []byte) error {
	db, err := Decode(data)
	if err != nil {
		return err
	}
	migrated, _, err := Migrate(db)
	if err != nil {
		return err
	}
	return s.Write(ctx, func(target DB) error {
		for key := range target {
			delete(target, key)
		}
		for key, value := range migrated {
			target[key] = value
		}
		return nil
	})
}

func (s *Store) JSON(ctx context.Context) ([]byte, error) {
	db, err := s.Snapshot()
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(db, "", "  ")
	if err != nil {
		return nil, err
	}
	_ = ctx
	return data, nil
}
