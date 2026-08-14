package transfer

import "testing"

func TestAllowedTransitions(t *testing.T) {
	valid := []struct {
		scope, from, to string
	}{
		{"ward", "MOVING", "ARRIVED"},
		{"ward", "IN_EXAM", "RETURNED"},
		{"exam", "ARRIVED", "IN_EXAM"},
		{"exam", "NEARLY_DONE", "PICKUP_REQUIRED"},
	}
	for _, test := range valid {
		if !Allowed(test.scope, Status(test.from), Status(test.to)) {
			t.Fatalf("expected transition to be allowed: %+v", test)
		}
	}
	if Allowed("ward", Moving, Returned) {
		t.Fatal("MOVING -> RETURNED must not bypass the normal workflow")
	}
}

func TestLegacyStatusMigration(t *testing.T) {
	status, changed, err := NormalizeLegacyStatus("DEPART_REGISTERED")
	if err != nil || !changed || status != Moving {
		t.Fatalf("unexpected legacy conversion: %s %v %v", status, changed, err)
	}
}
