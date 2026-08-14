package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	beddomain "github.com/pocket-dev-id/transboard/internal/domain/bed"
	"github.com/pocket-dev-id/transboard/internal/domain/transfer"
)

var ErrConflict = errors.New("optimistic concurrency conflict")

var allowedTables = map[string]bool{}

var allowedBedFields = map[string]bool{
	"id": true, "ward_id": true, "bed_number": true, "room_number": true,
	"room_code": true, "bed_code": true, "note": true, "map_col": true,
	"map_row": true, "sort_order": true, "patient_name": true, "patient_id": true,
	"is_present": true, "admission_date": true, "patient_note": true,
	"manually_registered": true, "order": true, "created_at": true, "updated_at": true,
}

func init() {
	for _, table := range TableNames {
		allowedTables[table] = true
	}
}

func IsAllowedTable(table string) bool { return allowedTables[table] }

func sanitizeRow(table string, input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		if table == "beds" && !allowedBedFields[key] {
			continue
		}
		output[key] = value
	}
	return output
}

func SanitizeRow(table string, input map[string]any) map[string]any { return sanitizeRow(table, input) }

func (s *Store) ListRaw(ctx context.Context, table string) ([]map[string]any, error) {
	if !IsAllowedTable(table) {
		return nil, fmt.Errorf("unknown table %q", table)
	}
	db, err := s.Snapshot()
	if err != nil {
		return nil, err
	}
	_ = ctx
	return Rows(db, table), nil
}

func (s *Store) List(ctx context.Context, table string) ([]map[string]any, error) {
	rows, err := s.ListRaw(ctx, table)
	if err != nil {
		return nil, err
	}
	if table == "system_settings" {
		for _, row := range rows {
			switch fmt.Sprint(row["id"]) {
			case "admin_passcode", "api_token", "odbc_connection_string", "smb_password":
				row["value"] = "********"
			}
		}
	}
	return rows, nil
}

func (s *Store) GetRaw(ctx context.Context, table, id string) (map[string]any, error) {
	if !IsAllowedTable(table) {
		return nil, fmt.Errorf("unknown table %q", table)
	}
	db, err := s.Snapshot()
	if err != nil {
		return nil, err
	}
	row, _ := FindRow(db, table, id)
	_ = ctx
	if row == nil {
		return nil, fmt.Errorf("record not found")
	}
	return row, nil
}

func (s *Store) Get(ctx context.Context, table, id string) (map[string]any, error) {
	return s.GetRaw(ctx, table, id)
}

func (s *Store) Create(ctx context.Context, table string, row map[string]any) (map[string]any, error) {
	if !IsAllowedTable(table) {
		return nil, fmt.Errorf("unknown table %q", table)
	}
	if strings.TrimSpace(fmt.Sprint(row["id"])) == "" {
		return nil, fmt.Errorf("id is required")
	}
	occupancySource := rowSource(row)
	row = sanitizeRow(table, row)
	if table == "transfer_events" {
		status := strings.TrimSpace(fmt.Sprint(row["current_status"]))
		if status == "" || status == "<nil>" {
			status = string(transfer.Moving)
			row["current_status"] = status
		}
		if status == string(transfer.DepartRegistered) {
			return nil, fmt.Errorf("DEPART_REGISTERED is legacy-only")
		}
		if !transfer.Known(status) {
			return nil, fmt.Errorf("unknown transfer status %q", status)
		}
		if status != string(transfer.Moving) {
			return nil, fmt.Errorf("new transfer events must start in MOVING")
		}
	}
	if row["created_at"] == nil {
		row["created_at"] = time.Now().UnixMilli()
	}
	if row["updated_at"] == nil {
		row["updated_at"] = row["created_at"]
	}
	err := s.Write(ctx, func(db DB) error {
		if existing, _ := FindRow(db, table, fmt.Sprint(row["id"])); existing != nil {
			return fmt.Errorf("record already exists")
		}
		rows := Rows(db, table)
		SetRows(db, table, append(rows, row))
		if table == "beds" {
			occupancy := Rows(db, "bed_occupancy_log")
			occupancy = beddomain.ApplyOccupancyTransition(occupancy, fmt.Sprint(row["id"]), fmt.Sprint(row["ward_id"]), nil, row, row, time.Now().UnixMilli(), occupancySource)
			occupancy, _ = pruneOccupancyFromDB(db, occupancy)
			SetRows(db, "bed_occupancy_log", occupancy)
		}
		return nil
	})
	return row, err
}

func (s *Store) Update(ctx context.Context, table, id string, patch map[string]any) (map[string]any, error) {
	if !IsAllowedTable(table) {
		return nil, fmt.Errorf("unknown table %q", table)
	}
	if table == "transfer_events" {
		if _, changesStatus := patch["current_status"]; changesStatus {
			return nil, fmt.Errorf("transfer status changes must use the transition service")
		}
	}
	occupancySource := rowSource(patch)
	patch = sanitizeRow(table, patch)
	var updated map[string]any
	err := s.Write(ctx, func(db DB) error {
		rows := Rows(db, table)
		for i, row := range rows {
			if fmt.Sprint(row["id"]) != id {
				continue
			}
			before := cloneRow(row)
			for key, value := range patch {
				if key != "id" {
					row[key] = value
				}
			}
			row["updated_at"] = time.Now().UnixMilli()
			rows[i] = row
			SetRows(db, table, rows)
			if table == "beds" {
				occupancy := Rows(db, "bed_occupancy_log")
				occupancy = beddomain.ApplyOccupancyTransition(occupancy, id, fmt.Sprint(row["ward_id"]), before, row, patch, time.Now().UnixMilli(), occupancySource)
				occupancy, _ = pruneOccupancyFromDB(db, occupancy)
				SetRows(db, "bed_occupancy_log", occupancy)
			}
			updated = row
			return nil
		}
		return fmt.Errorf("record not found")
	})
	return updated, err
}

func (s *Store) Delete(ctx context.Context, table, id string) (map[string]any, error) {
	if !IsAllowedTable(table) {
		return nil, fmt.Errorf("unknown table %q", table)
	}
	var removed map[string]any
	err := s.Write(ctx, func(db DB) error {
		rows := Rows(db, table)
		kept := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if fmt.Sprint(row["id"]) == id {
				removed = row
				continue
			}
			kept = append(kept, row)
		}
		if removed == nil {
			return fmt.Errorf("record not found")
		}
		SetRows(db, table, kept)
		if table == "beds" {
			occupancy := Rows(db, "bed_occupancy_log")
			beddomain.CloseOccupancyForDeletedBed(occupancy, id, time.Now().UnixMilli())
			occupancy, _ = pruneOccupancyFromDB(db, occupancy)
			SetRows(db, "bed_occupancy_log", occupancy)
		}
		return nil
	})
	return removed, err
}

func rowSource(row map[string]any) string {
	value := strings.TrimSpace(fmt.Sprint(row["_occupancySource"]))
	if value == "" || value == "<nil>" {
		return "unknown"
	}
	return value
}

func cloneRow(row map[string]any) map[string]any {
	copy := make(map[string]any, len(row))
	for key, value := range row {
		copy[key] = value
	}
	return copy
}

func pruneOccupancyFromDB(db DB, rows []map[string]any) ([]map[string]any, int) {
	days := 7
	if raw, ok := Setting(db, "bed_occupancy_retention_days"); ok {
		if _, scanErr := fmt.Sscan(strings.TrimSpace(raw), &days); scanErr != nil {
			days = 7
		}
	}
	return beddomain.PruneOccupancy(rows, days, 20000, time.Now().UnixMilli())
}

// UpdateAndCreate commits a state change and its related history row in one
// database transaction. It is used for transfer status changes so a failed
// persistence operation cannot leave the event and its status log divergent.
func (s *Store) UpdateAndCreate(ctx context.Context, table, id string, patch map[string]any, relatedTable string, related map[string]any, expectedStatus ...string) (map[string]any, map[string]any, error) {
	if !IsAllowedTable(table) || !IsAllowedTable(relatedTable) {
		return nil, nil, fmt.Errorf("unknown table")
	}
	patch = sanitizeRow(table, patch)
	related = sanitizeRow(relatedTable, related)
	if table == "transfer_events" {
		if rawStatus, changesStatus := patch["current_status"]; changesStatus {
			status := strings.TrimSpace(fmt.Sprint(rawStatus))
			if !transfer.Known(status) || status == string(transfer.DepartRegistered) {
				return nil, nil, fmt.Errorf("invalid transfer status %q", status)
			}
		}
	}
	if strings.TrimSpace(fmt.Sprint(related["id"])) == "" {
		return nil, nil, fmt.Errorf("related id is required")
	}
	var updated map[string]any
	err := s.Write(ctx, func(db DB) error {
		rows := Rows(db, table)
		for index, row := range rows {
			if fmt.Sprint(row["id"]) != id {
				continue
			}
			if len(expectedStatus) > 0 && strings.TrimSpace(expectedStatus[0]) != "" && fmt.Sprint(row["current_status"]) != expectedStatus[0] {
				return fmt.Errorf("%w: expected %s, current %s", ErrConflict, expectedStatus[0], row["current_status"])
			}
			for key, value := range patch {
				if key != "id" {
					row[key] = value
				}
			}
			row["updated_at"] = time.Now().UnixMilli()
			rows[index] = row
			updated = row
			break
		}
		if updated == nil {
			return fmt.Errorf("record not found")
		}
		relatedRows := Rows(db, relatedTable)
		if existing, _ := FindRow(db, relatedTable, fmt.Sprint(related["id"])); existing != nil {
			return fmt.Errorf("related record already exists")
		}
		if related["created_at"] == nil {
			related["created_at"] = time.Now().UnixMilli()
		}
		SetRows(db, table, rows)
		SetRows(db, relatedTable, append(relatedRows, related))
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return updated, related, nil
}

// RollbackUpdateAndCreate restores the event snapshot and removes the related
// history row when the separate audit append fails after a state transaction.
// expectedStatus prevents a later writer from being overwritten accidentally.
func (s *Store) RollbackUpdateAndCreate(ctx context.Context, table, id string, previous map[string]any, relatedTable, relatedID string, expectedStatus ...string) error {
	if !IsAllowedTable(table) || !IsAllowedTable(relatedTable) {
		return fmt.Errorf("unknown table")
	}
	if strings.TrimSpace(id) == "" || strings.TrimSpace(relatedID) == "" {
		return fmt.Errorf("rollback identifiers are required")
	}
	restored := cloneRow(previous)
	return s.Write(ctx, func(db DB) error {
		rows := Rows(db, table)
		found := false
		for index, row := range rows {
			if fmt.Sprint(row["id"]) != id {
				continue
			}
			if len(expectedStatus) > 0 && strings.TrimSpace(expectedStatus[0]) != "" && fmt.Sprint(row["current_status"]) != expectedStatus[0] {
				return fmt.Errorf("%w: rollback expected %s, current %s", ErrConflict, expectedStatus[0], row["current_status"])
			}
			rows[index] = restored
			found = true
			break
		}
		if !found {
			return fmt.Errorf("record not found during rollback")
		}
		relatedRows := Rows(db, relatedTable)
		kept := relatedRows[:0]
		removed := false
		for _, row := range relatedRows {
			if fmt.Sprint(row["id"]) == relatedID {
				removed = true
				continue
			}
			kept = append(kept, row)
		}
		if !removed {
			return fmt.Errorf("related record not found during rollback")
		}
		SetRows(db, table, rows)
		SetRows(db, relatedTable, kept)
		return nil
	})
}

// RollbackCreateAndCreate removes a newly created event and its initial log
// when the audit append for the creation cannot be persisted.
func (s *Store) RollbackCreateAndCreate(ctx context.Context, table, id, relatedTable, relatedID string, expectedStatus ...string) error {
	if !IsAllowedTable(table) || !IsAllowedTable(relatedTable) {
		return fmt.Errorf("unknown table")
	}
	return s.Write(ctx, func(db DB) error {
		rows := Rows(db, table)
		kept := rows[:0]
		removed := false
		for _, row := range rows {
			if fmt.Sprint(row["id"]) != id {
				kept = append(kept, row)
				continue
			}
			if len(expectedStatus) > 0 && strings.TrimSpace(expectedStatus[0]) != "" && fmt.Sprint(row["current_status"]) != expectedStatus[0] {
				return fmt.Errorf("%w: rollback expected %s, current %s", ErrConflict, expectedStatus[0], row["current_status"])
			}
			removed = true
		}
		if !removed {
			return fmt.Errorf("record not found during rollback")
		}
		relatedRows := Rows(db, relatedTable)
		relatedKept := relatedRows[:0]
		relatedRemoved := false
		for _, row := range relatedRows {
			if fmt.Sprint(row["id"]) == relatedID {
				relatedRemoved = true
				continue
			}
			relatedKept = append(relatedKept, row)
		}
		if !relatedRemoved {
			return fmt.Errorf("related record not found during rollback")
		}
		SetRows(db, table, kept)
		SetRows(db, relatedTable, relatedKept)
		return nil
	})
}

// CreateAndCreate is the insertion counterpart used when a transfer event
// and its initial history row must become visible together.
func (s *Store) CreateAndCreate(ctx context.Context, table string, row map[string]any, relatedTable string, related map[string]any) (map[string]any, map[string]any, error) {
	if !IsAllowedTable(table) || !IsAllowedTable(relatedTable) {
		return nil, nil, fmt.Errorf("unknown table")
	}
	row = sanitizeRow(table, row)
	related = sanitizeRow(relatedTable, related)
	if strings.TrimSpace(fmt.Sprint(row["id"])) == "" || strings.TrimSpace(fmt.Sprint(related["id"])) == "" {
		return nil, nil, fmt.Errorf("both record ids are required")
	}
	if table == "transfer_events" {
		status := strings.TrimSpace(fmt.Sprint(row["current_status"]))
		if status == "" || status == "<nil>" {
			status = string(transfer.Moving)
			row["current_status"] = status
		}
		if status != string(transfer.Moving) || !transfer.Known(status) {
			return nil, nil, fmt.Errorf("new transfer events must start in MOVING")
		}
	}
	if row["created_at"] == nil {
		row["created_at"] = time.Now().UnixMilli()
	}
	if row["updated_at"] == nil {
		row["updated_at"] = row["created_at"]
	}
	if related["created_at"] == nil {
		related["created_at"] = time.Now().UnixMilli()
	}
	err := s.Write(ctx, func(db DB) error {
		if existing, _ := FindRow(db, table, fmt.Sprint(row["id"])); existing != nil {
			return fmt.Errorf("record already exists")
		}
		if existing, _ := FindRow(db, relatedTable, fmt.Sprint(related["id"])); existing != nil {
			return fmt.Errorf("related record already exists")
		}
		SetRows(db, table, append(Rows(db, table), row))
		SetRows(db, relatedTable, append(Rows(db, relatedTable), related))
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return row, related, nil
}
