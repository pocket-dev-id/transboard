package security

import "testing"

func TestLegacyPasscodeCompatibility(t *testing.T) {
	stored := LegacySHA256("0000")
	if !VerifyPasscode("0000", stored) || VerifyPasscode("0001", stored) {
		t.Fatal("legacy SHA256 passcode compatibility failed")
	}
}

func TestBackupRoundTrip(t *testing.T) {
	ciphertext, err := EncryptBackup(`{"wards":[]}`, "secret")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := DecryptBackup(ciphertext, "secret")
	if err != nil || plain != `{"wards":[]}` {
		t.Fatalf("backup round trip failed: %q %v", plain, err)
	}
	if _, err := DecryptBackup(ciphertext, "wrong"); err == nil {
		t.Fatal("wrong password should fail authentication")
	}
}
