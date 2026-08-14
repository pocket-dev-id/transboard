package database

import (
	"encoding/json"
	"fmt"
	"strings"
)

const SchemaVersion = 2

var TableNames = []string{
	"wards", "beds", "exam_rooms", "exam_types", "staffs", "system_settings",
	"transfer_events", "transfer_status_logs", "audit_logs", "calls", "import_logs",
	"schedule_feeds", "schedule_items", "bed_occupancy_log", "handover_notes",
}

type DB map[string]any

func NewEmptyDB() DB {
	db := make(DB, len(TableNames))
	for _, name := range TableNames {
		db[name] = []any{}
	}
	db["system_settings"] = []any{
		map[string]any{"id": "import_directory", "value": ""},
		map[string]any{"id": "demo_inserted", "value": "false"},
		map[string]any{"id": "import_mapping", "value": `{"bed_number":"","room_code":"","bed_code":"","join_char":"-","patient_id":"","patient_name":"","is_present":""}`},
		map[string]any{"id": "import_schedule", "value": `{"mode":"realtime","intervalMin":"10","times":[]}`},
		map[string]any{"id": "import_retention_policy", "value": `{"action":"archive","retentionDays":"30","clearUnlisted":false}`},
		map[string]any{"id": "import_connection_type", "value": "csv"},
		map[string]any{"id": "odbc_connection_string", "value": ""},
		map[string]any{"id": "odbc_sql_query", "value": "SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS"},
		map[string]any{"id": "notification_sounds", "value": `{"PICKUP_REQUIRED":{"enabled":true,"sound":"alarm"},"NEARLY_DONE":{"enabled":true,"sound":"chime"},"SOON":{"enabled":true,"sound":"chime"},"MOVING":{"enabled":false,"sound":"ding"},"ARRIVED":{"enabled":false,"sound":"ding"},"IN_EXAM":{"enabled":false,"sound":"ding"},"RETURNED":{"enabled":false,"sound":"ding"}}`},
		map[string]any{"id": "incoming_ring_sound", "value": "ring"},
		map[string]any{"id": "api_token", "value": ""},
		map[string]any{"id": "enable_webrtc_call", "value": "true"},
		map[string]any{"id": "enable_patient_ic_association", "value": "false"},
		map[string]any{"id": "default_zoom", "value": "1.0"},
		map[string]any{"id": "font_style", "value": "ud"},
		map[string]any{"id": "bed_card_size", "value": "medium"},
		map[string]any{"id": "show_sync_time", "value": "true"},
		map[string]any{"id": "show_import_time", "value": "true"},
		map[string]any{"id": "smb_auth_mode", "value": "current"},
		map[string]any{"id": "smb_username", "value": ""},
		map[string]any{"id": "smb_password", "value": ""},
		map[string]any{"id": "speech_templates", "value": `["連絡事項があります。","間もなく、患者が出発します。","患者が到着しました。","検査が終了しました。お迎えをお願いします。","移送をキャンセルします。","至急、ご連絡ください。"]`},
		map[string]any{"id": "speech_include_patient_name", "value": "false"},
		map[string]any{"id": "admission_mode", "value": "csv"},
		map[string]any{"id": "notification_volume", "value": "80"},
		map[string]any{"id": "notification_scan_sound", "value": "true"},
		map[string]any{"id": "notification_auto_speech", "value": "true"},
		map[string]any{"id": "notification_mute", "value": `{"enabled":false,"start":"22:00","end":"06:00"}`},
		map[string]any{"id": "notification_import_toast", "value": "true"},
		map[string]any{"id": "status_custom_labels", "value": "{}"},
		map[string]any{"id": "status_colors", "value": "{}"},
		map[string]any{"id": "action_button_labels", "value": "{}"},
		map[string]any{"id": "hidden_statuses", "value": "[]"},
		map[string]any{"id": "schema_version", "value": fmt.Sprint(SchemaVersion)},
		map[string]any{"id": "event_retention_days", "value": "0"},
		map[string]any{"id": "bed_occupancy_retention_days", "value": "7"},
		map[string]any{"id": "nearly_done_minutes", "value": "10"},
		map[string]any{"id": "soon_threshold_min", "value": "15"},
		map[string]any{"id": "share_mode", "value": "parent"},
		map[string]any{"id": "parent_ip", "value": ""},
		map[string]any{"id": "terminal_role", "value": "ward"},
		map[string]any{"id": "wizard_completed", "value": "false"},
		map[string]any{"id": "admin_passcode", "value": "0000"},
	}
	return db
}

func Decode(data []byte) (DB, error) {
	var db DB
	if err := json.Unmarshal(data, &db); err != nil {
		return nil, fmt.Errorf("decode database JSON: %w", err)
	}
	if db == nil {
		return nil, fmt.Errorf("database root must be an object")
	}
	return db, nil
}

func Encode(db DB) ([]byte, error) {
	data, err := json.Marshal(db)
	if err != nil {
		return nil, fmt.Errorf("encode database JSON: %w", err)
	}
	return data, nil
}

func Clone(db DB) (DB, error) {
	data, err := Encode(db)
	if err != nil {
		return nil, err
	}
	return Decode(data)
}

func Rows(db DB, table string) []map[string]any {
	raw, ok := db[table]
	if !ok {
		return nil
	}
	var result []map[string]any
	data, err := json.Marshal(raw)
	if err != nil || json.Unmarshal(data, &result) != nil {
		return nil
	}
	return result
}

func SetRows(db DB, table string, rows []map[string]any) {
	values := make([]any, len(rows))
	for i, row := range rows {
		values[i] = row
	}
	db[table] = values
}

// RedactPatients removes patient-identifying fields and credentials from an
// export copy. The in-memory Store is never passed to this function directly;
// callers clone it first.
func RedactPatients(db DB) {
	for _, table := range []string{"beds", "transfer_events", "bed_occupancy_log"} {
		rows := Rows(db, table)
		for _, row := range rows {
			for _, field := range []string{"patient_name", "patient_id", "patient_ic_tag_id", "patient_name_kana"} {
				delete(row, field)
			}
		}
		SetRows(db, table, rows)
	}
	for _, row := range Rows(db, "system_settings") {
		switch fmt.Sprint(row["id"]) {
		case "admin_passcode", "api_token", "odbc_connection_string", "smb_password":
			row["value"] = "[REDACTED]"
		}
	}
	for _, row := range Rows(db, "audit_logs") {
		for _, field := range []string{"patient_name", "patient_id", "patient_ic_tag_id", "patient_name_kana", "patientName", "patientId", "patientIcTagId"} {
			delete(row, field)
		}
		for _, field := range []string{"before", "after", "details"} {
			row[field] = redactAuditValue(row[field])
		}
	}
}

func redactAuditValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(typed))
		for key, item := range typed {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "patient") || strings.Contains(lower, "patient_name") || strings.Contains(lower, "patient_id") {
				copy[key] = "[REDACTED]"
			} else {
				copy[key] = redactAuditValue(item)
			}
		}
		return copy
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = redactAuditValue(item)
		}
		return items
	case string:
		var parsed any
		if json.Unmarshal([]byte(typed), &parsed) == nil {
			redacted := redactAuditValue(parsed)
			if data, err := json.Marshal(redacted); err == nil {
				return string(data)
			}
		}
	}
	return value
}

func FindRow(db DB, table, id string) (map[string]any, int) {
	rows := Rows(db, table)
	for i, row := range rows {
		if fmt.Sprint(row["id"]) == id {
			return row, i
		}
	}
	return nil, -1
}

func Setting(db DB, id string) (string, bool) {
	for _, row := range Rows(db, "system_settings") {
		if fmt.Sprint(row["id"]) == id {
			return fmt.Sprint(row["value"]), true
		}
	}
	return "", false
}

func SetSetting(db DB, id, value string) {
	rows := Rows(db, "system_settings")
	for _, row := range rows {
		if fmt.Sprint(row["id"]) == id {
			row["value"] = value
			SetRows(db, "system_settings", rows)
			return
		}
	}
	SetRows(db, "system_settings", append(rows, map[string]any{"id": id, "value": value}))
}

func SettingValue(store *Store, id string) (string, bool) {
	db, err := store.Snapshot()
	if err != nil {
		return "", false
	}
	return Setting(db, id)
}

func SettingValueOr(store *Store, id, fallback string) string {
	if value, ok := SettingValue(store, id); ok && value != "" {
		return value
	}
	return fallback
}

func SettingValueFromDB(db DB, id, fallback string) string {
	if value, ok := Setting(db, id); ok && value != "" {
		return value
	}
	return fallback
}

func EnsureTables(db DB) {
	for _, name := range TableNames {
		if _, ok := db[name]; !ok {
			db[name] = []any{}
		}
	}
}
