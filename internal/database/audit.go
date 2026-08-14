package database

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocket-dev-id/transboard/internal/security"
)

type AuditEvent struct {
	ID           string         `json:"id"`
	Action       string         `json:"action"`
	TargetType   string         `json:"targetType,omitempty"`
	TargetID     string         `json:"targetId,omitempty"`
	ActorType    string         `json:"actorType"`
	TerminalRole string         `json:"terminalRole,omitempty"`
	Timestamp    int64          `json:"timestamp"`
	Details      map[string]any `json:"details,omitempty"`
}

type AuditService struct {
	mu   sync.Mutex
	path string
}

func NewAuditService(path string) *AuditService { return &AuditService{path: path} }
func (a *AuditService) Path() string            { return a.path }

func (a *AuditService) Append(event AuditEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if event.ID == "" {
		event.ID = fmt.Sprintf("audit-%d", time.Now().UnixNano())
	}
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().UnixMilli()
	}
	if event.ActorType == "" {
		event.ActorType = "system"
	}
	if err := os.MkdirAll(filepath.Dir(a.path), 0700); err != nil {
		return fmt.Errorf("create audit directory: %w", err)
	}
	release, err := acquireFileLock(a.path)
	if err != nil {
		return err
	}
	defer release()
	file, err := os.OpenFile(a.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open audit log: %w", err)
	}
	defer file.Close()
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode audit event: %w", err)
	}
	if _, err := file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("append audit event: %w", err)
	}
	return file.Sync()
}

func (a *AuditService) ReadAll() ([]AuditEvent, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, statErr := os.Stat(a.path); os.IsNotExist(statErr) {
		return []AuditEvent{}, nil
	}
	release, lockErr := acquireFileLock(a.path)
	if lockErr != nil {
		return nil, lockErr
	}
	defer release()
	file, err := os.Open(a.path)
	if os.IsNotExist(err) {
		return []AuditEvent{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var result []AuditEvent
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, security.DBPrefix) || strings.HasPrefix(line, security.GoDBPrefix) {
			line, err = security.DecodeDatabaseContent(line)
			if err != nil {
				return nil, fmt.Errorf("decode encrypted audit event: %w", err)
			}
		}
		var event AuditEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return nil, fmt.Errorf("decode audit event: %w", err)
		}
		result = append(result, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// ListRows exposes the JSONL audit stream through the legacy table-shaped API
// without putting the stream back into db.json. The field names intentionally
// match the JSON contract used by the compatibility client.
func (a *AuditService) ListRows() ([]map[string]any, error) {
	events, err := a.ReadAll()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(events))
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
	return rows, nil
}

// Replace rewrites the JSONL stream atomically. It is used by restore after
// the incoming database has passed validation, so the separated audit stream
// follows the same backup rather than being left on the previous dataset.
func (a *AuditService) Replace(events []AuditEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	var content bytes.Buffer
	for _, event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("encode audit event: %w", err)
		}
		content.Write(data)
		content.WriteByte('\n')
	}
	return WriteBytesAtomic(a.path, content.Bytes())
}

func LegacyAuditEvents(rows []map[string]any) []AuditEvent {
	events := make([]AuditEvent, 0, len(rows))
	for index, row := range rows {
		id := firstAuditValue(row, "id")
		if id == "" || id == "<nil>" {
			id = "legacy-audit-" + strconv.Itoa(index)
		}
		timestamp, _ := strconv.ParseInt(firstAuditValue(row, "timestamp", "created_at"), 10, 64)
		action := firstAuditValue(row, "action", "event_type")
		actor := firstAuditValue(row, "actorType", "actor_type")
		targetType := firstAuditValue(row, "targetType", "target_type")
		targetID := firstAuditValue(row, "targetId", "target_id")
		event := AuditEvent{ID: id, Action: action, TargetType: targetType, TargetID: targetID, ActorType: actor, Timestamp: timestamp}
		if details, ok := row["details"].(map[string]any); ok {
			event.Details = details
		}
		events = append(events, event)
	}
	return events
}

func firstAuditValue(row map[string]any, keys ...string) string {
	for _, key := range keys {
		value := fmt.Sprint(row[key])
		if value != "" && value != "<nil>" {
			return value
		}
	}
	return ""
}

// MigrateLegacyRows copies the legacy audit_logs table into the append-only
// JSONL file. IDs make retries idempotent when a process stops after writing a
// subset of rows.
func (a *AuditService) MigrateLegacyRows(rows []map[string]any) error {
	existing, err := a.ReadAll()
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(existing))
	for _, event := range existing {
		if event.ID != "" {
			seen[event.ID] = true
		}
	}
	for _, event := range LegacyAuditEvents(rows) {
		id := event.ID
		if seen[id] {
			continue
		}
		if err := a.Append(event); err != nil {
			return err
		}
		seen[id] = true
	}
	return nil
}
