package updater

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func Download(ctx context.Context, manifest Manifest, destination string, headers ...map[string]string) error {
	if manifest.URL == "" {
		return fmt.Errorf("update URL is missing")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifest.URL, nil)
	if err != nil {
		return err
	}
	if len(headers) > 0 {
		for key, value := range headers[0] {
			req.Header.Set(key, value)
		}
	}
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("update download HTTP status %d", response.StatusCode)
	}
	tmp := destination + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(file, response.Body)
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	}
	if err := VerifyFile(tmp, manifest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, destination); err != nil {
		if removeErr := os.Remove(destination); removeErr != nil && !os.IsNotExist(removeErr) {
			_ = os.Remove(tmp)
			return fmt.Errorf("replace downloaded update: %w", err)
		}
		if retryErr := os.Rename(tmp, destination); retryErr != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("install downloaded update: %w", retryErr)
		}
	}
	return nil
}
