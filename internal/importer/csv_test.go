package importer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseUTF8BOM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "patients.csv")
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, []byte("BED_NO,PATIENT_ID,PATIENT_NAME,IS_PRESENT\n701,P1,山田,true\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := ParseCSV(path, EncodingAuto, DefaultMapping())
	if err != nil || result.Rows != 1 || result.Records[0].PatientName != "山田" {
		t.Fatalf("CSV parse failed: %+v %v", result, err)
	}
}

func TestParseCombinedRoomAndBedMappingWithOptionalPatientColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "combined.csv")
	if err := os.WriteFile(path, []byte("ROOM,BED\n701,A\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := ParseCSV(path, EncodingAuto, Mapping{RoomCode: "ROOM", BedCode: "BED", JoinChar: "-"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Records) != 1 || result.Records[0].BedNumber != "701-A" || result.Records[0].HasPresence {
		t.Fatalf("combined mapping was not resolved: %+v", result.Records)
	}
}
