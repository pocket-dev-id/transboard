package security

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const PasscodeSalt = "transboard-passcode-v1"

func LegacySHA256(passcode string) string {
	hash := sha256.Sum256([]byte(passcode + PasscodeSalt))
	return "SHA256:" + hex.EncodeToString(hash[:])
}

func HashPasscode(passcode string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate passcode salt: %w", err)
	}
	derived, err := scrypt.Key([]byte(passcode), salt, 16384, 8, 1, 64)
	if err != nil {
		return "", fmt.Errorf("derive passcode hash: %w", err)
	}
	return "SCRYPT:" + base64.StdEncoding.EncodeToString(salt) + ":" + base64.StdEncoding.EncodeToString(derived), nil
}

func VerifyPasscode(passcode, stored string) bool {
	if strings.HasPrefix(stored, "SCRYPT:") {
		parts := strings.Split(stored, ":")
		if len(parts) != 3 {
			return false
		}
		salt, err1 := base64.StdEncoding.DecodeString(parts[1])
		expected, err2 := base64.StdEncoding.DecodeString(parts[2])
		if err1 != nil || err2 != nil || len(expected) == 0 {
			return false
		}
		actual, err := scrypt.Key([]byte(passcode), salt, 16384, 8, 1, len(expected))
		return err == nil && len(actual) == len(expected) && subtle.ConstantTimeCompare(actual, expected) == 1
	}
	if strings.HasPrefix(stored, "SHA256:") {
		candidate := LegacySHA256(passcode)
		return ConstantTimeEqual(candidate, stored)
	}
	return ConstantTimeEqual(passcode, stored)
}

func IsDefaultPasscode(stored string) bool {
	return stored == "0000" || ConstantTimeEqual(stored, LegacySHA256("0000"))
}
