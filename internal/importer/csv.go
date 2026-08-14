package importer

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Record struct {
	BedNumber   string `json:"bed_number"`
	RoomCode    string `json:"room_code,omitempty"`
	BedCode     string `json:"bed_code,omitempty"`
	PatientID   string `json:"patient_id"`
	PatientName string `json:"patient_name"`
	Present     bool   `json:"present"`
	HasPresence bool   `json:"has_presence"`
}

type Result struct {
	Path     string   `json:"path"`
	Encoding Encoding `json:"encoding"`
	Rows     int      `json:"rows"`
	Records  []Record `json:"records"`
}

func ParseCSV(path string, requested Encoding, mapping Mapping) (Result, error) {
	data, encoding, err := ReadDecodedFile(path, requested)
	if err != nil {
		return Result{}, err
	}
	reader := csv.NewReader(strings.NewReader(string(data)))
	reader.FieldsPerRecord = -1
	headers, err := reader.Read()
	if err != nil {
		return Result{}, fmt.Errorf("read CSV headers: %w", err)
	}
	resolved, err := mapping.Resolve(headers)
	if err != nil {
		return Result{}, err
	}
	indices := map[string]int{}
	for i, header := range headers {
		indices[strings.TrimSpace(header)] = i
	}
	result := Result{Path: path, Encoding: encoding}
	for {
		row, readErr := reader.Read()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return Result{}, fmt.Errorf("read CSV row: %w", readErr)
		}
		get := func(column string) string {
			if column == "" {
				return ""
			}
			index := indices[column]
			if index >= len(row) {
				return ""
			}
			return strings.TrimSpace(row[index])
		}
		patientID, patientName, presentValue := get(resolved.PatientID), get(resolved.PatientName), get(resolved.IsPresent)
		record := Record{BedNumber: get(resolved.BedNumber), RoomCode: get(resolved.RoomCode), BedCode: get(resolved.BedCode), PatientID: patientID, PatientName: patientName, Present: parsePresent(presentValue), HasPresence: resolved.IsPresent != ""}
		if record.BedNumber == "" && record.RoomCode != "" && record.BedCode != "" {
			record.BedNumber = record.RoomCode + resolved.JoinChar + record.BedCode
		}
		result.Records = append(result.Records, record)
	}
	result.Rows = len(result.Records)
	return result, nil
}

func parsePresent(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y", "\u5728\u5e8a", "\u5728\u5ba4":
		return true
	default:
		return false
	}
}

func ReadHeaders(path string, encoding Encoding) ([]string, Encoding, error) {
	data, detected, err := ReadDecodedFile(path, encoding)
	if err != nil {
		return nil, "", err
	}
	reader := csv.NewReader(strings.NewReader(string(data)))
	headers, err := reader.Read()
	return headers, detected, err
}

func IsStable(path string, interval time.Duration) bool {
	first, err := os.Stat(path)
	if err != nil {
		return false
	}
	if interval > 0 {
		time.Sleep(interval)
	}
	second, err := os.Stat(path)
	return err == nil && first.Size() == second.Size() && first.ModTime() == second.ModTime()
}

type Pipeline struct {
	Mapping  Mapping
	OnImport func(context.Context, Result) error
	OnError  func(error)
}

func (p *Pipeline) Import(ctx context.Context, path string, encoding Encoding) error {
	if !IsStable(path, 100*time.Millisecond) {
		return fmt.Errorf("CSV file is still being written")
	}
	result, err := ParseCSV(path, encoding, p.Mapping)
	if err != nil {
		if p.OnError != nil {
			p.OnError(err)
		}
		return err
	}
	if p.OnImport != nil {
		if importErr := p.OnImport(ctx, result); importErr != nil {
			if p.OnError != nil {
				p.OnError(importErr)
			}
			return importErr
		}
	}
	return nil
}

func Archive(path, archiveDir string) (string, error) {
	if err := os.MkdirAll(archiveDir, 0700); err != nil {
		return "", err
	}
	name := filepath.Base(path)
	destination := filepath.Join(archiveDir, fmt.Sprintf("%d_%s", time.Now().UnixMilli(), name))
	if err := os.Rename(path, destination); err != nil {
		return "", fmt.Errorf("archive CSV: %w", err)
	}
	return destination, nil
}
