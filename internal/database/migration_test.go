package database

import "testing"

func TestMigrateLegacyData(t *testing.T) {
	db := DB{
		"beds":                 []any{map[string]any{"id": "b1", "bed_type": "ICU"}},
		"transfer_events":      []any{map[string]any{"id": "e1", "current_status": "DEPART_REGISTERED"}},
		"transfer_status_logs": []any{map[string]any{"from_status": "DEPART_REGISTERED", "to_status": "MOVING"}},
		"bed_types":            []any{map[string]any{"id": "icu"}},
	}
	updated, report, err := Migrate(db)
	if err != nil {
		t.Fatal(err)
	}
	if report.RemovedBedTypes != 1 || report.ConvertedStatuses != 1 {
		t.Fatalf("unexpected migration report: %+v", report)
	}
	if _, ok := updated["bed_types"]; ok {
		t.Fatal("bed_types table should be removed")
	}
	if beds := Rows(updated, "beds"); len(beds) != 1 {
		t.Fatal("beds were lost")
	} else if _, ok := beds[0]["bed_type"]; ok {
		t.Fatal("bed_type should be removed")
	}
	if event := Rows(updated, "transfer_events")[0]; event["current_status"] != "MOVING" {
		t.Fatalf("legacy status was not converted: %#v", event["current_status"])
	}
	second, secondReport, err := Migrate(updated)
	if err != nil {
		t.Fatal(err)
	}
	if secondReport.Changed {
		t.Fatalf("migration should be idempotent: %+v", secondReport)
	}
	if len(Rows(second, "beds")) != 1 {
		t.Fatal("idempotent migration lost beds")
	}
}

func TestMigrateMissingTransferStatusDefaultsToMoving(t *testing.T) {
	db := DB{"transfer_events": []any{map[string]any{"id": "missing-status"}}}
	updated, report, err := Migrate(db)
	if err != nil {
		t.Fatal(err)
	}
	event := Rows(updated, "transfer_events")[0]
	if event["current_status"] != "MOVING" || !report.Changed {
		t.Fatalf("missing status was not safely defaulted: %#v %+v", event, report)
	}
	if _, _, err := Migrate(DB{"transfer_events": []any{map[string]any{"id": "unknown", "current_status": "CORRUPT"}}}); err == nil {
		t.Fatal("unknown non-empty status should remain an error")
	}
}
