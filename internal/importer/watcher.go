package importer

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

type Watcher struct {
	watcher   *fsnotify.Watcher
	pipeline  *Pipeline
	OnArchive func(string, error)
}

func NewWatcher(pipeline *Pipeline) (*Watcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &Watcher{watcher: watcher, pipeline: pipeline}, nil
}

func (w *Watcher) Run(ctx context.Context, directory string, encoding Encoding) error {
	if err := w.watcher.Add(directory); err != nil {
		return fmt.Errorf("watch import directory: %w", err)
	}
	defer w.watcher.Close()
	archiveDir := filepath.Join(directory, "archive")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-w.watcher.Events:
			if !ok {
				return nil
			}
			if event.Op&(fsnotify.Create|fsnotify.Write) == 0 {
				continue
			}
			if relative, relErr := filepath.Rel(archiveDir, event.Name); relErr == nil && (relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))) {
				continue
			}
			if strings.EqualFold(filepath.Ext(event.Name), ".csv") && w.pipeline != nil {
				if err := w.pipeline.Import(ctx, event.Name, encoding); err == nil {
					_, archiveErr := Archive(event.Name, archiveDir)
					if w.OnArchive != nil {
						w.OnArchive(event.Name, archiveErr)
					}
				}
			}
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return nil
			}
			return fmt.Errorf("CSV watcher: %w", err)
		}
	}
}
