package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/pocket-dev-id/transboard/internal/database"
	"github.com/pocket-dev-id/transboard/internal/security"
)

type Service struct {
	store *database.Store
	audit *database.AuditService
}

func NewService(store *database.Store, audit ...*database.AuditService) *Service {
	service := &Service{store: store}
	if len(audit) > 0 {
		service.audit = audit[0]
	}
	return service
}

func (s *Service) Export(ctx context.Context, destination string, password string, redact bool) (map[string]any, error) {
	if destination == "" {
		return nil, fmt.Errorf("backup destination is required")
	}
	db, err := s.store.Snapshot()
	if err != nil {
		return nil, err
	}
	if s.audit != nil {
		events, auditErr := s.audit.ReadAll()
		if auditErr != nil {
			return nil, fmt.Errorf("read audit log for backup: %w", auditErr)
		}
		rows := make([]any, 0, len(events))
		for _, event := range events {
			data, marshalErr := json.Marshal(event)
			if marshalErr != nil {
				return nil, marshalErr
			}
			var row map[string]any
			if unmarshalErr := json.Unmarshal(data, &row); unmarshalErr != nil {
				return nil, unmarshalErr
			}
			rows = append(rows, row)
		}
		db["audit_logs"] = rows
	}
	if redact {
		database.RedactPatients(db)
	}
	if err := ValidateDB(db); err != nil {
		return nil, err
	}
	plain, err := database.Encode(db)
	if err != nil {
		return nil, err
	}
	content := string(plain)
	if password != "" {
		content, err = security.EncryptBackup(content, password)
		if err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(destination, []byte(content), 0600); err != nil {
		return nil, fmt.Errorf("write backup: %w", err)
	}
	return map[string]any{"success": true, "path": destination, "encrypted": password != "", "redacted": redact, "createdAt": time.Now().UnixMilli()}, nil
}
