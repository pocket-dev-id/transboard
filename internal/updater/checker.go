package updater

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

type Manifest struct {
	Version string `json:"version"`
	File    string `json:"file"`
	URL     string `json:"url,omitempty"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	Hash    string `json:"hash,omitempty"`
}

func DecodeManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, err
	}
	if strings.TrimSpace(manifest.Version) == "" || strings.TrimSpace(manifest.File) == "" || manifest.Size <= 0 {
		return manifest, fmt.Errorf("update manifest is incomplete")
	}
	hash := strings.TrimSpace(manifest.SHA256)
	if hash == "" {
		hash = strings.TrimSpace(manifest.Hash)
	}
	if len(hash) != 64 {
		return manifest, fmt.Errorf("update manifest hash is incomplete")
	}
	if _, err := hex.DecodeString(hash); err != nil {
		return manifest, fmt.Errorf("update manifest hash is invalid")
	}
	manifest.SHA256 = hash
	if !safeDistributionName(manifest.File) || !strings.EqualFold(filepath.Ext(manifest.File), ".exe") {
		return manifest, fmt.Errorf("update manifest file name is unsafe")
	}
	return manifest, nil
}

func Check(ctx context.Context, manifestURL string, headers ...map[string]string) (Manifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
	if err != nil {
		return Manifest{}, err
	}
	if len(headers) > 0 {
		for key, value := range headers[0] {
			req.Header.Set(key, value)
		}
	}
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return Manifest{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Manifest{}, fmt.Errorf("update manifest HTTP status %d", response.StatusCode)
	}
	var manifest Manifest
	if err := json.NewDecoder(response.Body).Decode(&manifest); err != nil {
		return Manifest{}, err
	}
	return DecodeManifestData(manifest)
}

func DecodeManifestData(manifest Manifest) (Manifest, error) {
	data, err := json.Marshal(manifest)
	if err != nil {
		return Manifest{}, err
	}
	return DecodeManifest(data)
}
