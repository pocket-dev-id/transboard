package windows

import (
	"fmt"
	"os"
	"os/exec"
)

func Relaunch() error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	command := exec.Command(executable, os.Args[1:]...)
	command.Dir, _ = os.Getwd()
	if err := command.Start(); err != nil {
		return fmt.Errorf("start relaunched process: %w", err)
	}
	return nil
}
