package importer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseScheduleFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "feed.ics")
	data := "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:CT\nDTSTART:20260101T100000\nEND:VEVENT\nEND:VCALENDAR\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	items, err := ParseScheduleFile(path, "feed-1")
	if err != nil || len(items) != 1 || items[0].Title != "CT" || items[0].StartsAt == 0 {
		t.Fatalf("schedule parse failed: %+v %v", items, err)
	}
}
