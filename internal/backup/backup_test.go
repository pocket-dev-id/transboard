package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocket-dev-id/transboard/internal/database"
)

func TestExportAndRestore(t *testing.T) {
	dir := t.TempDir()
	store := database.NewStore(filepath.Join(dir, "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := store.Write(context.Background(), func(db database.DB) error {
		database.SetRows(db, "beds", []map[string]any{{"id": "b1", "patient_name": "secret"}})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	service := NewService(store)
	path := filepath.Join(dir, "backup.tb")
	if _, err := service.Export(context.Background(), path, "password", true); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if len(data) == 0 {
		t.Fatal("backup is empty")
	}
	if err := service.Restore(context.Background(), path, "password"); err != nil {
		t.Fatal(err)
	}
	rows, err := store.List(context.Background(), "beds")
	if err != nil || rows[0]["patient_name"] != nil {
		t.Fatalf("redacted restore failed: %#v %v", rows, err)
	}
}
