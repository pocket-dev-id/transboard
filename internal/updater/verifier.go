package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

func VerifyFile(path string, manifest Manifest) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() != manifest.Size {
		return fmt.Errorf("update size mismatch")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, manifest.SHA256) {
		return fmt.Errorf("update SHA-256 mismatch")
	}
	return nil
}
