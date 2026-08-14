package bed

import (
	"fmt"
	"sort"
	"strings"
)

type Occupancy struct {
	PatientID   string
	PatientName string
	Present     bool
}

// SamePatient follows the legacy contract: patient IDs are authoritative only
// when both sides have one; otherwise names are used for compatibility with
// hospital exports that omit IDs.
func SamePatient(left, right Occupancy) bool {
	leftID, rightID := strings.TrimSpace(left.PatientID), strings.TrimSpace(right.PatientID)
	if leftID != "" && rightID != "" {
		return leftID == rightID
	}
	return strings.TrimSpace(left.PatientName) != "" && strings.TrimSpace(left.PatientName) == strings.TrimSpace(right.PatientName)
}

func Occupant(row map[string]any) Occupancy {
	return Occupancy{PatientID: text(row["patient_id"]), PatientName: text(row["patient_name"]), Present: hasOccupant(row)}
}

func HasOccupant(row map[string]any) bool {
	return hasOccupant(row)
}

// ApplyOccupancyTransition keeps one open stay per bed and follows the legacy
// rule that a patient-ID backfill does not split an existing stay when the name
// still identifies the same person.
func ApplyOccupancyTransition(log []map[string]any, bedID, wardID string, before, after, patch map[string]any, now int64, source string) []map[string]any {
	hadOccupant, hasOccupant := hasOccupant(before), hasOccupant(after)
	if !hadOccupant && !hasOccupant {
		return log
	}
	open := findOpen(log, bedID)
	if hadOccupant && hasOccupant && SamePatient(Occupant(before), Occupant(after)) {
		if open != nil {
			open["patient_id"] = nullable(after["patient_id"])
			open["patient_name"] = nullable(after["patient_name"])
			if _, exists := patch["admission_date"]; exists && patch["admission_date"] != nil {
				open["admission_date"] = patch["admission_date"]
			}
		}
		return log
	}
	if hadOccupant && open != nil {
		open["ended_at"] = now
		if source == "csv_clear" {
			open["end_reason"] = "csv_cleared"
		} else if hasOccupant {
			open["end_reason"] = "overwritten_by_new_admission"
		} else {
			open["end_reason"] = "discharged"
		}
	}
	if !hasOccupant {
		return log
	}
	log = append(log, map[string]any{
		"id":             fmt.Sprintf("bed-occ-%d-%d", now, len(log)),
		"bed_id":         bedID,
		"ward_id":        nullable(wardID),
		"patient_name":   nullable(after["patient_name"]),
		"patient_id":     nullable(after["patient_id"]),
		"admission_date": admissionDate(patch, now),
		"started_at":     now,
		"ended_at":       nil,
		"end_reason":     nil,
		"source":         defaultSource(source),
		"created_at":     now,
	})
	return log
}

func CloseOccupancyForDeletedBed(log []map[string]any, bedID string, now int64) bool {
	open := findOpen(log, bedID)
	if open == nil {
		return false
	}
	open["ended_at"] = now
	open["end_reason"] = "bed_deleted"
	return true
}

func PruneOccupancy(log []map[string]any, retentionDays, maxEntries int, now int64) ([]map[string]any, int) {
	if retentionDays < 1 {
		retentionDays = 1
	}
	cutoff := now - int64(retentionDays)*24*60*60*1000
	kept := make([]map[string]any, 0, len(log))
	removed := 0
	for _, entry := range log {
		ended := integer(entry["ended_at"])
		if ended > 0 && ended < cutoff {
			removed++
			continue
		}
		kept = append(kept, entry)
	}
	if maxEntries > 0 && len(kept) > maxEntries {
		closed := make([]int, 0, len(kept))
		for index, entry := range kept {
			if integer(entry["ended_at"]) > 0 {
				closed = append(closed, index)
			}
		}
		sort.SliceStable(closed, func(left, right int) bool {
			return integer(kept[closed[left]]["ended_at"]) < integer(kept[closed[right]]["ended_at"])
		})
		removeCount := len(kept) - maxEntries
		if removeCount > len(closed) {
			removeCount = len(closed)
		}
		removeSet := make(map[int]bool, removeCount)
		for _, index := range closed[:removeCount] {
			removeSet[index] = true
		}
		bounded := kept[:0]
		for index, entry := range kept {
			if removeSet[index] {
				removed++
				continue
			}
			bounded = append(bounded, entry)
		}
		kept = bounded
	}
	return kept, removed
}

func findOpen(log []map[string]any, bedID string) map[string]any {
	for _, entry := range log {
		if fmt.Sprint(entry["bed_id"]) == bedID && entry["ended_at"] == nil {
			return entry
		}
	}
	return nil
}

func hasOccupant(row map[string]any) bool {
	return row != nil && (text(row["patient_id"]) != "" || text(row["patient_name"]) != "")
}

func text(value any) string {
	if value == nil || fmt.Sprint(value) == "<nil>" {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func nullable(value any) any {
	if text(value) == "" {
		return nil
	}
	return value
}

func admissionDate(patch map[string]any, now int64) any {
	if value, exists := patch["admission_date"]; exists && value != nil {
		return value
	}
	return now
}

func defaultSource(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unknown"
	}
	return value
}

func integer(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case int32:
		return int64(typed)
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case string:
		var result int64
		_, _ = fmt.Sscan(strings.TrimSpace(typed), &result)
		return result
	default:
		return 0
	}
}
