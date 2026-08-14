package network

import "testing"

func TestPrivateParentValidation(t *testing.T) {
	if err := ValidateParentAddress("192.168.1.10", 3005); err != nil {
		t.Fatal(err)
	}
	if ValidateParentAddress("8.8.8.8", 3005) == nil {
		t.Fatal("public parent address must be rejected")
	}
}
