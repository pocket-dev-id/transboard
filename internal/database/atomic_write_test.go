package database

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteJSONAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db.json")
	value := map[string]any{"wards": []any{map[string]any{"id": "w1"}}}
	if err := WriteJSONAtomic(path, value); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatal("atomic write produced an empty file")
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temporary file was not cleaned up")
	}
}
