package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const BackupMagic = "TBENCV1:"

func EncryptBackup(plain, password string) (string, error) {
	if password == "" {
		return "", fmt.Errorf("backup password is required")
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", err
	}
	key, err := scrypt.Key([]byte(password), salt, 16384, 8, 1, 32)
	if err != nil {
		return "", fmt.Errorf("derive backup key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, iv, []byte(plain), nil)
	// Node's legacy format is salt || iv || authTag || encryptedData.
	sealed := ciphertext[:len(ciphertext)-gcm.Overhead()]
	authTag := ciphertext[len(ciphertext)-gcm.Overhead():]
	payload := append(append(append(append([]byte{}, salt...), iv...), authTag...), sealed...)
	return BackupMagic + base64.StdEncoding.EncodeToString(payload), nil
}

func DecryptBackup(content, password string) (string, error) {
	if !strings.HasPrefix(content, BackupMagic) {
		return content, nil
	}
	payload, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(content, BackupMagic))
	if err != nil || len(payload) < 44 {
		return "", fmt.Errorf("invalid encrypted backup format")
	}
	salt, iv, authTag, encrypted := payload[:16], payload[16:28], payload[28:44], payload[44:]
	key, err := scrypt.Key([]byte(password), salt, 16384, 8, 1, 32)
	if err != nil {
		return "", fmt.Errorf("derive backup key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	combined := append(append([]byte{}, encrypted...), authTag...)
	plain, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt backup: %w", err)
	}
	return string(plain), nil
}
