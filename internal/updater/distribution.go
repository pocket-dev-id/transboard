package updater

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// LegacyManifest is the electron-builder latest.yml contract used by the 1.x
// parent update distribution endpoint. It is deliberately kept separate from
// the JSON manifest used by the Go updater.
type LegacyManifest struct {
	Version string
	Path    string
	SHA512  string
}

func ParseLegacyManifest(data []byte) (LegacyManifest, error) {
	var manifest LegacyManifest
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		if line == "" || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), "'\"")
		switch key {
		case "version":
			manifest.Version = value
		case "path":
			manifest.Path = value
		case "sha512":
			manifest.SHA512 = value
		}
	}
	if strings.TrimSpace(manifest.Version) == "" || !safeDistributionName(manifest.Path) || !validSHA512(manifest.SHA512) {
		return LegacyManifest{}, fmt.Errorf("latest.yml is incomplete")
	}
	return manifest, nil
}

func validSHA512(value string) bool {
	value = strings.TrimSpace(value)
	if decoded, err := hex.DecodeString(value); err == nil && len(decoded) == sha512.Size {
		return true
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	return err == nil && len(decoded) == sha512.Size
}

func safeDistributionName(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && filepath.Base(value) == value && value != "." && value != ".."
}

func sha512File(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	hash := sha512.New()
	if _, err := io.Copy(hash, file); err != nil {
		return nil, err
	}
	return hash.Sum(nil), nil
}

func sha512Matches(actual []byte, expected string) bool {
	expected = strings.TrimSpace(expected)
	if decoded, err := hex.DecodeString(expected); err == nil && bytes.Equal(decoded, actual) {
		return true
	}
	decoded, err := base64.StdEncoding.DecodeString(expected)
	return err == nil && bytes.Equal(decoded, actual)
}

func sha256File(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), info.Size(), nil
}

func writeGoManifest(path string, legacy LegacyManifest, sha256Hash string, size int64) error {
	manifest := Manifest{
		Version: legacy.Version,
		File:    legacy.Path,
		URL:     "/updates/" + legacy.Path,
		Size:    size,
		SHA256:  sha256Hash,
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(path)
		if retryErr := os.Rename(temporary, path); retryErr != nil {
			_ = os.Remove(temporary)
			return retryErr
		}
	}
	return nil
}

func copyFileAtomic(source, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary := destination + ".tmp"
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(temporary)
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(destination)
		if retryErr := os.Rename(temporary, destination); retryErr != nil {
			_ = os.Remove(temporary)
			return retryErr
		}
	}
	return nil
}

func clearDistributionArchive(directory string) error {
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func ImportDistribution(dataDir, ymlSource, exeSource string) (map[string]any, error) {
	ymlData, err := os.ReadFile(ymlSource)
	if err != nil {
		return nil, fmt.Errorf("read latest.yml: %w", err)
	}
	manifest, err := ParseLegacyManifest(ymlData)
	if err != nil {
		return nil, err
	}
	if filepath.Base(exeSource) != manifest.Path {
		return nil, fmt.Errorf("latest.yml file name does not match installer")
	}
	info, err := os.Stat(exeSource)
	if err != nil || info.IsDir() {
		return nil, fmt.Errorf("installer file is not available")
	}
	actual, err := sha512File(exeSource)
	if err != nil {
		return nil, fmt.Errorf("hash installer: %w", err)
	}
	if !sha512Matches(actual, manifest.SHA512) {
		return nil, fmt.Errorf("installer SHA-512 does not match latest.yml")
	}
	sha256Hash, size, err := sha256File(exeSource)
	if err != nil {
		return nil, fmt.Errorf("hash installer for Go manifest: %w", err)
	}

	updatesDir := filepath.Join(dataDir, "updates")
	archiveDir := filepath.Join(updatesDir, "archive")
	if err := os.MkdirAll(archiveDir, 0700); err != nil {
		return nil, err
	}
	currentYML := filepath.Join(updatesDir, "latest.yml")
	if currentData, readErr := os.ReadFile(currentYML); readErr == nil {
		current, parseErr := ParseLegacyManifest(currentData)
		if parseErr != nil {
			return nil, fmt.Errorf("current latest.yml is invalid: %w", parseErr)
		}
		if err := clearDistributionArchive(archiveDir); err != nil {
			return nil, err
		}
		if err := copyFileAtomic(currentYML, filepath.Join(archiveDir, "latest.yml")); err != nil {
			return nil, fmt.Errorf("archive current latest.yml: %w", err)
		}
		if _, statErr := os.Stat(filepath.Join(updatesDir, "manifest.json")); statErr == nil {
			if err := copyFileAtomic(filepath.Join(updatesDir, "manifest.json"), filepath.Join(archiveDir, "manifest.json")); err != nil {
				return nil, fmt.Errorf("archive current manifest: %w", err)
			}
		}
		currentEXE := filepath.Join(updatesDir, current.Path)
		if _, statErr := os.Stat(currentEXE); statErr == nil {
			if err := copyFileAtomic(currentEXE, filepath.Join(archiveDir, current.Path)); err != nil {
				return nil, fmt.Errorf("archive current installer: %w", err)
			}
		}
	}
	if err := copyFileAtomic(ymlSource, currentYML); err != nil {
		return nil, fmt.Errorf("install latest.yml: %w", err)
	}
	newEXE := filepath.Join(updatesDir, manifest.Path)
	if err := copyFileAtomic(exeSource, newEXE); err != nil {
		return nil, fmt.Errorf("install update installer: %w", err)
	}
	if err := writeGoManifest(filepath.Join(updatesDir, "manifest.json"), manifest, sha256Hash, size); err != nil {
		return nil, fmt.Errorf("write Go update manifest: %w", err)
	}
	return map[string]any{"success": true, "version": manifest.Version, "fileName": manifest.Path}, nil
}

// ImportGoDistribution installs a Go/Wails manifest while preserving any
// legacy latest.yml distribution already present on the parent. This allows a
// 1.x client and a 2.x client to receive their respective update contracts from
// the same LAN endpoint.
func ImportGoDistribution(dataDir, manifestSource, exeSource string) (map[string]any, error) {
	manifestData, err := os.ReadFile(manifestSource)
	if err != nil {
		return nil, fmt.Errorf("read Go update manifest: %w", err)
	}
	manifest, err := DecodeManifest(manifestData)
	if err != nil {
		return nil, err
	}
	if !safeDistributionName(manifest.File) || !strings.EqualFold(filepath.Ext(manifest.File), ".exe") {
		return nil, fmt.Errorf("Go update manifest file name is unsafe")
	}
	if !strings.EqualFold(filepath.Base(exeSource), manifest.File) {
		return nil, fmt.Errorf("Go update manifest file name does not match installer")
	}
	if err := VerifyFile(exeSource, manifest); err != nil {
		return nil, fmt.Errorf("verify Go installer: %w", err)
	}

	updatesDir := filepath.Join(dataDir, "updates")
	archiveDir := filepath.Join(updatesDir, "archive")
	if err := os.MkdirAll(archiveDir, 0700); err != nil {
		return nil, err
	}
	if err := archiveCurrentDistribution(updatesDir, archiveDir); err != nil {
		return nil, err
	}
	if err := copyFileAtomic(manifestSource, filepath.Join(updatesDir, "manifest.json")); err != nil {
		return nil, fmt.Errorf("install Go update manifest: %w", err)
	}
	if err := copyFileAtomic(exeSource, filepath.Join(updatesDir, manifest.File)); err != nil {
		return nil, fmt.Errorf("install Go update installer: %w", err)
	}
	return map[string]any{"success": true, "version": manifest.Version, "fileName": manifest.File}, nil
}

func archiveCurrentDistribution(updatesDir, archiveDir string) error {
	if err := clearDistributionArchive(archiveDir); err != nil {
		return err
	}
	legacyYML := filepath.Join(updatesDir, "latest.yml")
	if _, err := os.Stat(legacyYML); err == nil {
		if err := copyFileAtomic(legacyYML, filepath.Join(archiveDir, "latest.yml")); err != nil {
			return fmt.Errorf("archive latest.yml: %w", err)
		}
		if data, readErr := os.ReadFile(legacyYML); readErr == nil {
			if legacy, parseErr := ParseLegacyManifest(data); parseErr == nil {
				current := filepath.Join(updatesDir, legacy.Path)
				if _, statErr := os.Stat(current); statErr == nil {
					if err := copyFileAtomic(current, filepath.Join(archiveDir, legacy.Path)); err != nil {
						return fmt.Errorf("archive legacy installer: %w", err)
					}
				}
			}
		}
	}
	manifestPath := filepath.Join(updatesDir, "manifest.json")
	if _, err := os.Stat(manifestPath); err == nil {
		if err := copyFileAtomic(manifestPath, filepath.Join(archiveDir, "manifest.json")); err != nil {
			return fmt.Errorf("archive Go manifest: %w", err)
		}
		if data, readErr := os.ReadFile(manifestPath); readErr == nil {
			if manifest, decodeErr := DecodeManifest(data); decodeErr == nil && safeDistributionName(manifest.File) {
				current := filepath.Join(updatesDir, manifest.File)
				if _, statErr := os.Stat(current); statErr == nil {
					if err := copyFileAtomic(current, filepath.Join(archiveDir, manifest.File)); err != nil {
						return fmt.Errorf("archive Go installer: %w", err)
					}
				}
			}
		}
	}
	return nil
}

func distributionInfo(directory string) (map[string]any, error) {
	ymlPath := filepath.Join(directory, "latest.yml")
	data, err := os.ReadFile(ymlPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	manifest, err := ParseLegacyManifest(data)
	if err != nil {
		return nil, err
	}
	_, fileErr := os.Stat(filepath.Join(directory, manifest.Path))
	return map[string]any{"version": manifest.Version, "fileName": manifest.Path, "fileExists": fileErr == nil}, nil
}

func goDistributionInfo(directory string) (map[string]any, error) {
	manifestPath := filepath.Join(directory, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	manifest, err := DecodeManifest(data)
	if err != nil {
		return nil, err
	}
	_, fileErr := os.Stat(filepath.Join(directory, manifest.File))
	return map[string]any{"version": manifest.Version, "fileName": manifest.File, "fileExists": fileErr == nil, "format": "go"}, nil
}

func DistributionInfo(dataDir string) (map[string]any, error) {
	updatesDir := filepath.Join(dataDir, "updates")
	serving, err := distributionInfo(updatesDir)
	if err != nil {
		return nil, err
	}
	archived, err := distributionInfo(filepath.Join(updatesDir, "archive"))
	if err != nil {
		return nil, err
	}
	goServing, err := goDistributionInfo(updatesDir)
	if err != nil {
		return nil, err
	}
	goArchived, err := goDistributionInfo(filepath.Join(updatesDir, "archive"))
	if err != nil {
		return nil, err
	}
	legacyServing, legacyArchived := serving, archived
	if goServing != nil {
		serving = goServing
	}
	if goArchived != nil {
		archived = goArchived
	}
	return map[string]any{"success": true, "serving": serving, "archived": archived, "legacyServing": legacyServing, "legacyArchived": legacyArchived, "goServing": goServing, "goArchived": goArchived}, nil
}

func RollbackDistribution(dataDir string) (map[string]any, error) {
	updatesDir := filepath.Join(dataDir, "updates")
	archiveDir := filepath.Join(updatesDir, "archive")
	archivedYML := filepath.Join(archiveDir, "latest.yml")
	data, err := os.ReadFile(archivedYML)
	if os.IsNotExist(err) {
		return rollbackGoDistribution(updatesDir, archiveDir)
	}
	if err != nil {
		return nil, err
	}
	manifest, err := ParseLegacyManifest(data)
	if err != nil {
		return nil, err
	}
	archivedEXE := filepath.Join(archiveDir, manifest.Path)
	if _, err := os.Stat(archivedEXE); err != nil {
		return nil, fmt.Errorf("archived installer is missing")
	}
	current, _ := distributionInfo(updatesDir)
	if current != nil {
		if name, ok := current["fileName"].(string); ok && safeDistributionName(name) {
			_ = os.Remove(filepath.Join(updatesDir, name))
		}
	}
	if err := copyFileAtomic(archivedYML, filepath.Join(updatesDir, "latest.yml")); err != nil {
		return nil, err
	}
	if err := copyFileAtomic(archivedEXE, filepath.Join(updatesDir, manifest.Path)); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(archiveDir, "manifest.json")); err == nil {
		if err := copyFileAtomic(filepath.Join(archiveDir, "manifest.json"), filepath.Join(updatesDir, "manifest.json")); err != nil {
			return nil, err
		}
	}
	if err := clearDistributionArchive(archiveDir); err != nil {
		return nil, err
	}
	return map[string]any{"success": true, "version": manifest.Version, "fileName": manifest.Path}, nil
}

func rollbackGoDistribution(updatesDir, archiveDir string) (map[string]any, error) {
	manifestPath := filepath.Join(archiveDir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if os.IsNotExist(err) {
		return nil, fmt.Errorf("no archived update is available")
	}
	if err != nil {
		return nil, err
	}
	manifest, err := DecodeManifest(data)
	if err != nil {
		return nil, err
	}
	archivedEXE := filepath.Join(archiveDir, manifest.File)
	if _, err := os.Stat(archivedEXE); err != nil {
		return nil, fmt.Errorf("archived Go installer is missing")
	}
	if currentData, readErr := os.ReadFile(filepath.Join(updatesDir, "manifest.json")); readErr == nil {
		if current, decodeErr := DecodeManifest(currentData); decodeErr == nil && safeDistributionName(current.File) {
			_ = os.Remove(filepath.Join(updatesDir, current.File))
		}
	}
	if err := copyFileAtomic(manifestPath, filepath.Join(updatesDir, "manifest.json")); err != nil {
		return nil, err
	}
	if err := copyFileAtomic(archivedEXE, filepath.Join(updatesDir, manifest.File)); err != nil {
		return nil, err
	}
	if err := clearDistributionArchive(archiveDir); err != nil {
		return nil, err
	}
	return map[string]any{"success": true, "version": manifest.Version, "fileName": manifest.File}, nil
}
