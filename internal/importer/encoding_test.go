package importer

import (
	"bytes"
	"testing"
)

func TestDecodeCP932(t *testing.T) {
	reader, encoding, err := DecodeReader(bytes.NewReader([]byte{0x8e, 0x52, 0x93, 0x63}), EncodingCP932)
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 16)
	n, _ := reader.Read(data)
	if encoding != EncodingCP932 || string(data[:n]) != "山田" {
		t.Fatalf("unexpected CP932 decode: %q", data[:n])
	}
}
