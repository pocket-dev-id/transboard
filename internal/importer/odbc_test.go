package importer

import "testing"

func TestValidateReadQuery(t *testing.T) {
	if err := validateReadQuery("SELECT bed_number FROM patients"); err != nil {
		t.Fatal(err)
	}
	if err := validateReadQuery("WITH current_rows AS (SELECT 1) SELECT * FROM current_rows"); err != nil {
		t.Fatal(err)
	}
	if err := validateReadQuery("UPDATE patients SET name = 'x'"); err == nil {
		t.Fatal("write query should be rejected")
	}
	if err := validateReadQuery("WITH current_rows AS (SELECT 1) DELETE FROM patients"); err == nil {
		t.Fatal("writable CTE should be rejected")
	}
	if err := validateReadQuery("SELECT 1; DELETE FROM patients"); err == nil {
		t.Fatal("multiple statements should be rejected")
	}
}

func TestValidateReadQueryAllowsSemicolonsInsideLiteralsAndTrailingComments(t *testing.T) {
	for _, query := range []string{
		"SELECT * FROM beds WHERE note = 'a;b'",
		"SELECT * FROM beds; -- one statement",
		"SELECT * FROM [beds;current]",
	} {
		if err := validateReadQuery(query); err != nil {
			t.Fatalf("valid read query was rejected (%q): %v", query, err)
		}
	}
}

func TestNormalizeODBCTextSupportsCP932(t *testing.T) {
	value := normalizeODBCText([]byte{0x8e, 0x52, 0x93, 0x63})
	if value != "山田" {
		t.Fatalf("CP932 ODBC text was not decoded: %q", value)
	}
	forced := normalizeODBCTextWithEncoding([]byte{0x8e, 0x52, 0x93, 0x63}, "cp932")
	if forced != value {
		t.Fatalf("forced CP932 decoding differed: %q", forced)
	}
}
