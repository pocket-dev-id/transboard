package backup

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/pocket-dev-id/transboard/internal/database"
	"github.com/pocket-dev-id/transboard/internal/security"
)

func (s *Service) Restore(ctx context.Context, source, password string) error {
	if source == "" {
		return fmt.Errorf("restore source is required")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("read restore file: %w", err)
	}
	content := string(data)
	if strings.HasPrefix(content, security.BackupMagic) {
		content, err = security.DecryptBackup(content, password)
		if err != nil {
			return err
		}
	}
	if strings.HasPrefix(content, security.DBPrefix) || strings.HasPrefix(content, security.GoDBPrefix) {
		content, err = security.DecodeDatabaseContent(content)
		if err != nil {
			return err
		}
	}
	db, err := database.Decode([]byte(content))
	if err != nil {
		return err
	}
	migrated, _, err := database.Migrate(db)
	if err != nil {
		return fmt.Errorf("migrate restore data: %w", err)
	}
	if err := ValidateDB(migrated); err != nil {
		return err
	}
	var previousAudit []database.AuditEvent
	var incomingAudit []database.AuditEvent
	if s.audit != nil {
		previousAudit, err = s.audit.ReadAll()
		if err != nil {
			return fmt.Errorf("read current audit log: %w", err)
		}
		incomingAudit = database.LegacyAuditEvents(database.Rows(migrated, "audit_logs"))
	}
	contentBytes, err := database.Encode(migrated)
	if err != nil {
		return err
	}
	if err := database.CopyFile(s.store.Path(), s.store.Path()+".before_restore"); err != nil {
		// A first-run restore has no current DB. In that case no backup is needed.
		if !os.IsNotExist(err) {
			return err
		}
	}
	if s.audit != nil {
		if err := database.CopyFile(s.audit.Path(), s.audit.Path()+".before_restore"); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := s.audit.Replace(incomingAudit); err != nil {
			return fmt.Errorf("replace audit log: %w", err)
		}
		database.SetRows(migrated, "audit_logs", []map[string]any{})
		database.SetSetting(migrated, "audit_jsonl_migrated", "1")
		contentBytes, err = database.Encode(migrated)
		if err != nil {
			if restoreAuditErr := s.audit.Replace(previousAudit); restoreAuditErr != nil {
				return fmt.Errorf("encode restored database: %v; restore audit log: %w", err, restoreAuditErr)
			}
			return err
		}
	}
	if err := s.store.ReplaceFromJSON(ctx, contentBytes); err != nil {
		if s.audit != nil {
			if restoreAuditErr := s.audit.Replace(previousAudit); restoreAuditErr != nil {
				return fmt.Errorf("replace restored database: %v; restore audit log: %w", err, restoreAuditErr)
			}
		}
		return err
	}
	return nil
}
