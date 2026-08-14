package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocket-dev-id/transboard/internal/database"
)

func TestRestoreKeepsBeforeRestoreCopy(t *testing.T) {
	dir := t.TempDir()
	store := database.NewStore(filepath.Join(dir, "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.Write(context.Background(), func(db database.DB) error {
		database.SetRows(db, "wards", []map[string]any{{"id": "before-restore"}})
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	source := database.NewStore(filepath.Join(dir, "source-db.json"))
	if err := source.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := source.Write(context.Background(), func(db database.DB) error {
		database.SetRows(db, "wards", []map[string]any{{"id": "after-restore"}})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(dir, "restore-source.json")
	if _, err := NewService(source).Export(context.Background(), backupPath, "", false); err != nil {
		t.Fatal(err)
	}

	if err := NewService(store).Restore(context.Background(), backupPath, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.Path() + ".before_restore"); err != nil {
		t.Fatalf("before-restore backup was not created: %v", err)
	}
	rows, err := store.List(context.Background(), "wards")
	if err != nil || len(rows) != 1 || rows[0]["id"] != "after-restore" {
		t.Fatalf("restore did not replace the database: %#v %v", rows, err)
	}
}
