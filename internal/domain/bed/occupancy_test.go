package bed

import "testing"

func TestSamePatientFallback(t *testing.T) {
	if !SamePatient(Occupancy{PatientID: "", PatientName: "山田"}, Occupancy{PatientID: "", PatientName: "山田"}) {
		t.Fatal("names should be used when both IDs are absent")
	}
	if SamePatient(Occupancy{PatientID: "P1", PatientName: "山田"}, Occupancy{PatientID: "P2", PatientName: "山田"}) {
		t.Fatal("different IDs must not be merged by name")
	}
}
