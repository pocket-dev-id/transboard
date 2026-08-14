package importer

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ScheduleItem struct {
	ID       string `json:"id"`
	FeedID   string `json:"feed_id"`
	Title    string `json:"title"`
	StartsAt int64  `json:"starts_at"`
	EndsAt   int64  `json:"ends_at"`
	Location string `json:"location,omitempty"`
}

func ParseScheduleFile(path, feedID string) ([]ScheduleItem, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var result []ScheduleItem
	var current *ScheduleItem
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case line == "BEGIN:VEVENT":
			current = &ScheduleItem{FeedID: feedID, ID: fmt.Sprintf("%s-%d", feedID, len(result))}
		case line == "END:VEVENT" && current != nil:
			result = append(result, *current)
			current = nil
		case current != nil && strings.HasPrefix(line, "SUMMARY:"):
			current.Title = strings.TrimPrefix(line, "SUMMARY:")
		case current != nil && strings.HasPrefix(line, "LOCATION:"):
			current.Location = strings.TrimPrefix(line, "LOCATION:")
		case current != nil && strings.HasPrefix(line, "DTSTART"):
			current.StartsAt = parseICSDate(line)
		case current != nil && strings.HasPrefix(line, "DTEND"):
			current.EndsAt = parseICSDate(line)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func parseICSDate(line string) int64 {
	value := line[strings.Index(line, ":")+1:]
	value = strings.TrimSuffix(value, "Z")
	for _, layout := range []string{"20060102T150405", "20060102"} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}

func ResolveSchedulePath(feed map[string]any) string {
	directory := fmt.Sprint(feed["watch_dir"])
	fileName := fmt.Sprint(feed["file_name"])
	if fileName == "" {
		fileName = fmt.Sprint(feed["filename"])
	}
	if directory == "" {
		return fileName
	}
	return filepath.Join(directory, fileName)
}
