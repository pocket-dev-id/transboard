package database

import (
	"fmt"
	"strings"
	"time"

	"github.com/pocket-dev-id/transboard/internal/domain/transfer"
)

type MigrationReport struct {
	FromVersion       int
	ToVersion         int
	Changed           bool
	RemovedBedTypes   int
	ConvertedStatuses int
}

func Migrate(input DB) (DB, MigrationReport, error) {
	if input == nil {
		return nil, MigrationReport{}, fmt.Errorf("database is nil")
	}
	db, err := Clone(input)
	if err != nil {
		return nil, MigrationReport{}, err
	}
	for _, table := range TableNames {
		if _, ok := db[table]; !ok {
			db[table] = []any{}
		}
	}
	fromVersion := 1
	if raw, ok := Setting(db, "schema_version"); ok {
		if _, scanErr := fmt.Sscan(raw, &fromVersion); scanErr != nil {
			fromVersion = 1
		}
	}
	report := MigrationReport{FromVersion: fromVersion, ToVersion: SchemaVersion}
	for _, table := range TableNames {
		if _, ok := input[table]; !ok {
			report.Changed = true
		}
	}
	defaults := map[string]string{
		"import_directory":              "",
		"demo_inserted":                 "false",
		"import_mapping":                `{"bed_number":"","room_code":"","bed_code":"","join_char":"-","patient_id":"","patient_name":"","is_present":""}`,
		"import_schedule":               `{"mode":"realtime","intervalMin":"10","times":[]}`,
		"import_retention_policy":       `{"action":"archive","retentionDays":"30","clearUnlisted":false}`,
		"import_connection_type":        "csv",
		"odbc_connection_string":        "",
		"odbc_sql_query":                "SELECT BED_NO, PATIENT_ID, PATIENT_NAME, IS_PRESENT FROM V_BED_STATUS",
		"notification_sounds":           `{"PICKUP_REQUIRED":{"enabled":true,"sound":"alarm"},"NEARLY_DONE":{"enabled":true,"sound":"chime"},"SOON":{"enabled":true,"sound":"chime"},"MOVING":{"enabled":false,"sound":"ding"},"ARRIVED":{"enabled":false,"sound":"ding"},"IN_EXAM":{"enabled":false,"sound":"ding"},"RETURNED":{"enabled":false,"sound":"ding"}}`,
		"incoming_ring_sound":           "ring",
		"share_mode":                    "parent",
		"parent_ip":                     "",
		"api_token":                     "",
		"enable_webrtc_call":            "true",
		"enable_patient_ic_association": "false",
		"default_zoom":                  "1.0",
		"font_style":                    "ud",
		"bed_card_size":                 "medium",
		"show_sync_time":                "true",
		"show_import_time":              "true",
		"smb_auth_mode":                 "current",
		"smb_username":                  "",
		"smb_password":                  "",
		"speech_templates":              `["連絡事項があります。","間もなく、患者が出発します。","患者が到着しました。","検査が終了しました。お迎えをお願いします。","移送をキャンセルします。","至急、ご連絡ください。"]`,
		"speech_include_patient_name":   "false",
		"admission_mode":                "csv",
		"notification_volume":           "80",
		"notification_scan_sound":       "true",
		"notification_auto_speech":      "true",
		"notification_mute":             `{"enabled":false,"start":"22:00","end":"06:00"}`,
		"notification_import_toast":     "true",
		"status_custom_labels":          "{}",
		"status_colors":                 "{}",
		"action_button_labels":          "{}",
		"hidden_statuses":               "[]",
		"event_retention_days":          "0",
		"bed_occupancy_retention_days":  "7",
		"nearly_done_minutes":           "10",
		"soon_threshold_min":            "15",
		"terminal_role":                 "ward",
		"wizard_completed":              "false",
		"admin_passcode":                "0000",
	}
	for id, value := range defaults {
		if _, ok := Setting(db, id); !ok {
			SetSetting(db, id, value)
			report.Changed = true
		}
	}

	if beds := Rows(db, "beds"); beds != nil {
		for _, bed := range beds {
			if _, ok := bed["bed_type"]; ok {
				delete(bed, "bed_type")
				report.RemovedBedTypes++
			}
		}
		SetRows(db, "beds", beds)
	}
	if _, ok := db["bed_types"]; ok {
		delete(db, "bed_types")
		report.Changed = true
	}

	events := Rows(db, "transfer_events")
	for _, event := range events {
		old := strings.TrimSpace(fmt.Sprint(event["current_status"]))
		if old == "" || old == "<nil>" {
			event["current_status"] = string(transfer.Moving)
			report.Changed = true
			continue
		}
		status, changed, statusErr := transfer.NormalizeLegacyStatus(old)
		if statusErr != nil {
			return nil, report, statusErr
		}
		if changed {
			event["current_status"] = string(status)
			report.ConvertedStatuses++
		}
	}
	SetRows(db, "transfer_events", events)
	logs := Rows(db, "transfer_status_logs")
	for _, log := range logs {
		for _, field := range []string{"from_status", "to_status"} {
			value := fmt.Sprint(log[field])
			if value == string(transfer.DepartRegistered) {
				log[field] = string(transfer.Moving)
				report.Changed = true
			}
		}
	}
	SetRows(db, "transfer_status_logs", logs)
	SetSetting(db, "schema_version", fmt.Sprint(SchemaVersion))
	if report.FromVersion != SchemaVersion || report.RemovedBedTypes > 0 || report.ConvertedStatuses > 0 {
		report.Changed = true
	}
	if report.Changed {
		SetSetting(db, "last_migration_at", fmt.Sprint(time.Now().UnixMilli()))
	}
	return db, report, nil
}
