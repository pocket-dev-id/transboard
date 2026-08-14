package database

import (
	"context"
	"path/filepath"
	"testing"
)

func TestStoreOpenAndRepository(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(context.Background(), "wards", map[string]any{"id": "w1", "name": "東"}); err != nil {
		t.Fatal(err)
	}
	row, err := store.Get(context.Background(), "wards", "w1")
	if err != nil || row["name"] != "東" {
		t.Fatalf("repository read failed: %#v %v", row, err)
	}
	if _, err := store.Update(context.Background(), "beds", "b1", map[string]any{"id": "b1", "bed_type": "ICU"}); err == nil {
		t.Fatal("missing bed should fail")
	}
}

func TestBedAndTransferContracts(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	row, err := store.Create(context.Background(), "beds", map[string]any{
		"id": "bed-1", "bed_number": "101", "bed_type": "ICU", "unexpected": "discard",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := row["bed_type"]; exists {
		t.Fatal("bed_type must not be persisted")
	}
	if _, exists := row["unexpected"]; exists {
		t.Fatal("unknown bed field must not be persisted")
	}
	if _, err := store.Create(context.Background(), "transfer_events", map[string]any{"id": "event-1", "current_status": "ARRIVED"}); err == nil {
		t.Fatal("new transfer events must not start in ARRIVED")
	}
	if _, err := store.Create(context.Background(), "transfer_events", map[string]any{"id": "event-2", "current_status": "MOVING"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Update(context.Background(), "transfer_events", "event-2", map[string]any{"current_status": "ARRIVED"}); err == nil {
		t.Fatal("direct transfer status changes must use the transition service")
	}
}

func TestBedWritesMaintainOccupancyHistory(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := store.Create(ctx, "beds", map[string]any{"id": "bed-occ", "bed_number": "101", "ward_id": "w1", "patient_name": "Patient A"}); err != nil {
		t.Fatal(err)
	}
	rows, err := store.List(ctx, "bed_occupancy_log")
	if err != nil || len(rows) != 1 || rows[0]["ended_at"] != nil {
		t.Fatalf("initial occupancy was not opened: %#v %v", rows, err)
	}
	if _, err := store.Update(ctx, "beds", "bed-occ", map[string]any{"patient_id": "P1", "_occupancySource": "csv_import"}); err != nil {
		t.Fatal(err)
	}
	rows, _ = store.List(ctx, "bed_occupancy_log")
	if len(rows) != 1 || rows[0]["patient_id"] != "P1" || rows[0]["ended_at"] != nil {
		t.Fatalf("same occupant ID backfill split the stay: %#v", rows)
	}
	if _, err := store.Update(ctx, "beds", "bed-occ", map[string]any{"patient_id": "P2", "patient_name": "Patient B", "is_present": true}); err != nil {
		t.Fatal(err)
	}
	rows, _ = store.List(ctx, "bed_occupancy_log")
	if len(rows) != 2 || rows[0]["ended_at"] == nil || rows[1]["ended_at"] != nil {
		t.Fatalf("patient replacement did not close/open occupancy: %#v", rows)
	}
	if _, err := store.Delete(ctx, "beds", "bed-occ"); err != nil {
		t.Fatal(err)
	}
	rows, _ = store.List(ctx, "bed_occupancy_log")
	if rows[1]["ended_at"] == nil || rows[1]["end_reason"] != "bed_deleted" {
		t.Fatalf("deleted bed left occupancy open: %#v", rows)
	}
}
