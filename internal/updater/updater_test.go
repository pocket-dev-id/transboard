package updater

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update.exe")
	if err := os.WriteFile(path, []byte("build"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{Version: "2.0.0", File: "update.exe", Size: 5, SHA256: "5b6c0f3f3f9d7f8f0d5d1f9a6a7a0aa66e12f7a1d1bdbd41d3d9e6d4a4a0c3e2"}
	if err := VerifyFile(path, manifest); err == nil {
		t.Fatal("incorrect hash should fail")
	}
}

func TestDecodeManifestNormalizesHashAliasAndRejectsInvalidHash(t *testing.T) {
	manifest, err := DecodeManifest([]byte(`{"version":"2.0.0","file":"TransBoard.exe","size":1,"hash":"` + strings.Repeat("a", 64) + `"}`))
	if err != nil || manifest.SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("hash alias was not normalized: %#v %v", manifest, err)
	}
	if _, err := DecodeManifest([]byte(`{"version":"2.0.0","file":"TransBoard.exe","size":1,"sha256":"not-a-hash"}`)); err == nil {
		t.Fatal("invalid manifest hash should be rejected")
	}
}

func TestDistributionImportAndRollback(t *testing.T) {
	root := t.TempDir()
	sources := filepath.Join(root, "sources")
	if err := os.MkdirAll(sources, 0700); err != nil {
		t.Fatal(err)
	}
	writeRelease := func(version, name, content string) (string, string) {
		exePath := filepath.Join(sources, name)
		if err := os.WriteFile(exePath, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		hash := sha512.Sum512([]byte(content))
		ymlPath := filepath.Join(sources, version+".yml")
		yml := fmt.Sprintf("version: %s\npath: %s\nsha512: %s\n", version, name, base64.StdEncoding.EncodeToString(hash[:]))
		if err := os.WriteFile(ymlPath, []byte(yml), 0600); err != nil {
			t.Fatal(err)
		}
		return ymlPath, exePath
	}
	oldYML, oldEXE := writeRelease("1.9.0", "TransBoard-1.9.0.exe", "old")
	if _, err := ImportDistribution(root, oldYML, oldEXE); err != nil {
		t.Fatal(err)
	}
	newYML, newEXE := writeRelease("2.0.0", "TransBoard-2.0.0.exe", "new")
	if _, err := ImportDistribution(root, newYML, newEXE); err != nil {
		t.Fatal(err)
	}
	info, err := DistributionInfo(root)
	if err != nil {
		t.Fatal(err)
	}
	if info["serving"].(map[string]any)["version"] != "2.0.0" || info["archived"].(map[string]any)["version"] != "1.9.0" {
		t.Fatalf("unexpected distribution state: %#v", info)
	}
	result, err := RollbackDistribution(root)
	if err != nil || result["version"] != "1.9.0" {
		t.Fatalf("rollback failed: %#v %v", result, err)
	}
}

func TestGoDistributionImportAndRollback(t *testing.T) {
	root := t.TempDir()
	sources := filepath.Join(root, "sources")
	if err := os.MkdirAll(sources, 0700); err != nil {
		t.Fatal(err)
	}
	writeRelease := func(version, content string) (string, string) {
		name := "TransBoard-" + version + ".exe"
		exePath := filepath.Join(sources, name)
		if err := os.WriteFile(exePath, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256([]byte(content))
		manifestPath := filepath.Join(sources, version+".json")
		manifest := Manifest{Version: version, File: name, Size: int64(len(content)), SHA256: hex.EncodeToString(hash[:]), URL: "/updates/" + name}
		data, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manifestPath, data, 0600); err != nil {
			t.Fatal(err)
		}
		return manifestPath, exePath
	}
	oldManifest, oldEXE := writeRelease("2.0.0", "old-go")
	if _, err := ImportGoDistribution(root, oldManifest, oldEXE); err != nil {
		t.Fatal(err)
	}
	newManifest, newEXE := writeRelease("2.0.1", "new-go")
	if _, err := ImportGoDistribution(root, newManifest, newEXE); err != nil {
		t.Fatal(err)
	}
	info, err := DistributionInfo(root)
	if err != nil || info["goServing"].(map[string]any)["version"] != "2.0.1" || info["goArchived"].(map[string]any)["version"] != "2.0.0" {
		t.Fatalf("unexpected Go distribution state: %#v %v", info, err)
	}
	result, err := RollbackDistribution(root)
	if err != nil || result["version"] != "2.0.0" {
		t.Fatalf("Go rollback failed: %#v %v", result, err)
	}
}
