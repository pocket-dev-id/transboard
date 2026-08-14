package importer

import "testing"

func TestMappingValidation(t *testing.T) {
	if err := DefaultMapping().Validate([]string{"BED_NO", "PATIENT_ID", "PATIENT_NAME", "IS_PRESENT"}); err != nil {
		t.Fatal(err)
	}
	if err := DefaultMapping().Validate([]string{"BED_NO"}); err == nil {
		t.Fatal("missing columns must fail")
	}
}
