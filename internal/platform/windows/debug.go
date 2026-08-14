package windows

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func AppendDebugLog(dataDir, line string) error {
	path := filepath.Join(dataDir, "transboard-debug.log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = fmt.Fprintf(file, "%s %s\n", time.Now().Format(time.RFC3339), line)
	return err
}

func DebugLogPath(dataDir string) string { return filepath.Join(dataDir, "transboard-debug.log") }
