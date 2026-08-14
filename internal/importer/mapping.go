package importer

import (
	"fmt"
	"strings"
)

type Mapping struct {
	BedNumber   string `json:"bed_number"`
	RoomCode    string `json:"room_code"`
	BedCode     string `json:"bed_code"`
	JoinChar    string `json:"join_char"`
	PatientID   string `json:"patient_id"`
	PatientName string `json:"patient_name"`
	IsPresent   string `json:"is_present"`
}

func DefaultMapping() Mapping {
	return Mapping{BedNumber: "BED_NO", PatientID: "PATIENT_ID", PatientName: "PATIENT_NAME", IsPresent: "IS_PRESENT", JoinChar: "-"}
}

func NormalizeMapping(input map[string]any) Mapping {
	mapping := Mapping{JoinChar: "-"}
	if value := strings.TrimSpace(fmt.Sprint(input["bed_number"])); value != "" {
		mapping.BedNumber = value
	}
	if value := strings.TrimSpace(fmt.Sprint(input["room_code"])); value != "" {
		mapping.RoomCode = value
	}
	if value := strings.TrimSpace(fmt.Sprint(input["bed_code"])); value != "" {
		mapping.BedCode = value
	}
	if value, exists := input["join_char"]; exists && fmt.Sprint(value) != "<nil>" {
		mapping.JoinChar = fmt.Sprint(value)
	}
	if value := strings.TrimSpace(fmt.Sprint(input["patient_id"])); value != "" {
		mapping.PatientID = value
	}
	if value := strings.TrimSpace(fmt.Sprint(input["patient_name"])); value != "" {
		mapping.PatientName = value
	}
	if value := strings.TrimSpace(fmt.Sprint(input["is_present"])); value != "" {
		mapping.IsPresent = value
	}
	return mapping
}

func (m Mapping) Validate(headers []string) error {
	_, err := m.Resolve(headers)
	return err
}

// Resolve maps configured column names to the exact header spelling and fills
// optional empty settings using common hospital export aliases. Patient and
// presence columns are optional because some exports describe an empty bed
// using only the bed identifier.
func (m Mapping) Resolve(headers []string) (Mapping, error) {
	set := map[string]bool{}
	for _, header := range headers {
		set[strings.TrimSpace(header)] = true
	}
	resolve := func(name, configured string, aliases []string, required bool) (string, error) {
		if strings.TrimSpace(configured) != "" {
			for _, header := range headers {
				if strings.EqualFold(strings.TrimSpace(header), strings.TrimSpace(configured)) {
					return strings.TrimSpace(header), nil
				}
			}
			return "", fmt.Errorf("CSV mapping %s points to missing column %q", name, configured)
		}
		for _, alias := range aliases {
			if set[alias] {
				return alias, nil
			}
			for _, header := range headers {
				if strings.EqualFold(strings.TrimSpace(header), alias) {
					return strings.TrimSpace(header), nil
				}
			}
		}
		if required {
			return "", fmt.Errorf("CSV mapping %s has no matching column", name)
		}
		return "", nil
	}

	if m.JoinChar == "" && (m.RoomCode != "" || m.BedCode != "") {
		m.JoinChar = "-"
	}
	if m.RoomCode != "" || m.BedCode != "" {
		if m.RoomCode == "" || m.BedCode == "" {
			return Mapping{}, fmt.Errorf("CSV mapping requires both room_code and bed_code")
		}
		var err error
		if m.RoomCode, err = resolve("room_code", m.RoomCode, nil, true); err != nil {
			return Mapping{}, err
		}
		if m.BedCode, err = resolve("bed_code", m.BedCode, nil, true); err != nil {
			return Mapping{}, err
		}
	} else {
		var err error
		m.BedNumber, err = resolve("bed_number", m.BedNumber, []string{"bed_number", "BED_NO", "bed_no", "病床番号"}, true)
		if err != nil {
			return Mapping{}, err
		}
	}
	var err error
	m.PatientID, err = resolve("patient_id", m.PatientID, []string{"patient_id", "PATIENT_ID", "患者ID"}, false)
	if err != nil {
		return Mapping{}, err
	}
	m.PatientName, err = resolve("patient_name", m.PatientName, []string{"patient_name", "PATIENT_NAME", "患者氏名", "漢字氏名", "氏名"}, false)
	if err != nil {
		return Mapping{}, err
	}
	m.IsPresent, err = resolve("is_present", m.IsPresent, []string{"is_present", "IS_PRESENT", "在床", "在室"}, false)
	if err != nil {
		return Mapping{}, err
	}
	return m, nil
}
