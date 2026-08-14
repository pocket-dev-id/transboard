package network

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocket-dev-id/transboard/internal/database"
	"github.com/pocket-dev-id/transboard/internal/domain/transfer"
	"github.com/pocket-dev-id/transboard/internal/security"
)

func (s *Server) handle(ctx context.Context, method, path string, headers http.Header, body io.Reader, external bool) map[string]any {
	if external && !AuthorizedHeader(headers, s.token) {
		return failure("UNAUTHORIZED", "API token is invalid")
	}
	payload, err := readJSON(body)
	if err != nil && method != http.MethodGet && method != http.MethodDelete {
		return failure("INVALID_REQUEST", "request body must be valid JSON")
	}
	cleanPath := strings.Trim(path, "/")
	cleanPath = strings.TrimPrefix(cleanPath, "api/")
	pathParts := strings.SplitN(cleanPath, "?", 2)
	basePath := pathParts[0]
	query := url.Values{}
	if len(pathParts) == 2 {
		query, _ = url.ParseQuery(pathParts[1])
	}
	parts := strings.Split(basePath, "/")
	if len(parts) >= 2 && parts[0] == "tables" {
		return s.handleTable(ctx, method, parts[1], parts[2:], query, payload, external)
	}
	if strings.HasPrefix(basePath, "parent-actions/") {
		if !external {
			return failure("FORBIDDEN", "parent actions require an external client")
		}
		if method != http.MethodGet && method != http.MethodPost {
			return failure("METHOD_NOT_ALLOWED", "method is not supported")
		}
		action := strings.TrimPrefix(basePath, "parent-actions/")
		s.mu.Lock()
		handler := s.parentAction
		s.mu.Unlock()
		if handler == nil {
			return failure("UNAVAILABLE", "parent action handler is unavailable")
		}
		return handler(ctx, method, action, payload, external)
	}
	switch basePath {
	case "auth/passcode-status":
		if method != http.MethodGet || s.passcodeStatus == nil {
			return failure("METHOD_NOT_ALLOWED", "method is not supported")
		}
		return s.passcodeStatus()
	case "auth/verify-passcode":
		if method != http.MethodPost || s.verifyPasscode == nil {
			return failure("METHOD_NOT_ALLOWED", "method is not supported")
		}
		return s.verifyPasscode(fmt.Sprint(payload["passcode"]))
	case "audit/write":
		return s.handleAuditWrite(method, payload, external)
	case "status/update":
		s.statusMu.Lock()
		defer s.statusMu.Unlock()
		return s.handleStatusUpdate(ctx, payload, external)
	case "status/note":
		return s.handleStatusNote(ctx, payload, external)
	case "status/ack":
		return s.handleStatusAck(ctx, payload, external)
	case "transfer/start":
		s.statusMu.Lock()
		defer s.statusMu.Unlock()
		return s.handleTransferStart(ctx, payload, external)
	case "maintenance/complete":
		return failure("UNAUTHORIZED", "maintenance endpoint requires a local authorization flow")
	case "webrtc/send", "webrtc/poll":
		return s.handleWebRTC(method, cleanPath, payload)
	case "device/heartbeat":
		return s.handleHeartbeat(payload)
	case "device/list":
		return map[string]any{"success": true, "devices": s.presence.List()}
	case "device/disconnect":
		s.presence.Disconnect(fmt.Sprint(payload["deviceId"]))
		return map[string]any{"success": true}
	default:
		return failure("NOT_FOUND", "endpoint was not found")
	}
}

func AuthorizedHeader(headers http.Header, provider TokenProvider) bool {
	if headers == nil || provider == nil {
		return false
	}
	expected, actual := provider(), headers.Get("X-API-Token")
	return expected != "" && actual != "" && len(expected) == len(actual) && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

func readJSON(reader io.Reader) (map[string]any, error) {
	if reader == nil {
		return map[string]any{}, nil
	}
	data, err := io.ReadAll(io.LimitReader(reader, 1<<20))
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]any{}, nil
	}
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	switch typed := raw.(type) {
	case map[string]any:
		return typed, nil
	case []any:
		return map[string]any{"__bulk": typed}, nil
	default:
		return nil, fmt.Errorf("JSON body must be an object or array")
	}
}

func failure(code, message string) map[string]any {
	return map[string]any{"success": false, "code": code, "message": message}
}

func cloneRecord(record map[string]any) map[string]any {
	clone := make(map[string]any, len(record))
	for key, value := range record {
		clone[key] = value
	}
	return clone
}

func (s *Server) handleAuditWrite(method string, payload map[string]any, external bool) map[string]any {
	if method != http.MethodPost {
		return failure("METHOD_NOT_ALLOWED", "method is not supported")
	}
	if s.audit == nil {
		return failure("REQUEST_FAILED", "audit service is unavailable")
	}
	actor := actorFor(external, fmt.Sprint(payload["actorType"]))
	details, _ := payload["details"].(map[string]any)
	err := s.audit.Append(database.AuditEvent{Action: fmt.Sprint(payload["action"]), TargetType: fmt.Sprint(payload["targetType"]), TargetID: fmt.Sprint(payload["targetId"]), ActorType: actor, Details: details})
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	return map[string]any{"success": true}
}

func (s *Server) handleTable(ctx context.Context, method, table string, suffix []string, query url.Values, payload map[string]any, external bool) map[string]any {
	if !database.IsAllowedTable(table) {
		return failure("NOT_FOUND", "table was not found")
	}
	if table == "audit_logs" && method != http.MethodGet {
		return failure("METHOD_NOT_ALLOWED", "audit_logs is append-only")
	}
	if table == "bed_occupancy_log" && method != http.MethodGet {
		return failure("METHOD_NOT_ALLOWED", "bed_occupancy_log is server-managed")
	}
	if table == "transfer_status_logs" && method != http.MethodGet {
		return failure("METHOD_NOT_ALLOWED", "transfer_status_logs is server-managed")
	}
	id := ""
	if len(suffix) > 0 {
		id = suffix[0]
	}
	switch method {
	case http.MethodGet:
		if len(suffix) == 0 {
			var rows []map[string]any
			var err error
			if table == "audit_logs" && s.audit != nil {
				rows, err = s.audit.ListRows()
			} else if table == "system_settings" && !external {
				rows, err = s.store.ListRaw(ctx, table)
			} else {
				rows, err = s.store.List(ctx, table)
			}
			if err != nil {
				return failure("REQUEST_FAILED", err.Error())
			}
			if table == "system_settings" && !external {
				rows = decryptLocalSettings(rows)
			}
			return map[string]any{"success": true, "data": filterRows(table, rows, query)}
		}
		if table == "transfer_events" && id == "ward-status" {
			return s.wardStatus(ctx, query)
		}
		if table == "transfer_events" && id == "exam-room-grid-status" {
			return s.examRoomGridStatus(ctx)
		}
		if table == "transfer_events" && id == "exam-room-status" {
			return s.examRoomStatus(ctx, query)
		}
		if table == "system_settings" && protectedSetting(id) {
			if external || id == "admin_passcode" {
				return failure("FORBIDDEN", "protected setting is not readable")
			}
			row, err := s.store.GetRaw(ctx, table, id)
			if err != nil {
				return failure("NOT_FOUND", "record was not found")
			}
			return decryptLocalSettings([]map[string]any{row})[0]
		}
		row, err := s.store.Get(ctx, table, id)
		if err != nil {
			return failure("NOT_FOUND", "record was not found")
		}
		return row
	case http.MethodPost:
		if id == "bulk" {
			return s.handleBulkUpdate(ctx, table, payload, external, http.MethodPost)
		}
		if table == "transfer_events" {
			if value, exists := payload["current_status"]; exists && !transfer.Known(fmt.Sprint(value)) {
				return failure("VALIDATION_FAILED", "unknown transfer status")
			}
			if fmt.Sprint(payload["current_status"]) == string(transfer.DepartRegistered) {
				return failure("VALIDATION_FAILED", "DEPART_REGISTERED is legacy-only")
			}
		}
		prepared, prepareErr := prepareSystemSetting(payload, external, "")
		if prepareErr != nil {
			return failure("FORBIDDEN", prepareErr.Error())
		}
		payload = prepared
		if table == "beds" {
			if result := s.validateBed(ctx, "", payload); result != nil {
				return result
			}
		}
		var beforeMutation database.DB
		if s.audit != nil {
			var snapshotErr error
			beforeMutation, snapshotErr = s.store.Snapshot()
			if snapshotErr != nil {
				return failure("REQUEST_FAILED", snapshotErr.Error())
			}
		}
		row, err := s.store.Create(ctx, table, payload)
		if err != nil {
			return failure("REQUEST_FAILED", err.Error())
		}
		if auditErr := s.auditMutation("DB_CREATE", table, fmt.Sprint(row["id"]), external); auditErr != nil {
			return s.rollbackMutation(ctx, beforeMutation, auditErr)
		}
		return row
	case http.MethodPatch, http.MethodPut:
		if id == "bulk" {
			return s.handleBulkUpdate(ctx, table, payload, external, method)
		}
		if table == "transfer_events" {
			if _, exists := payload["current_status"]; exists {
				return failure("VALIDATION_FAILED", "use status/update for status changes")
			}
		}
		prepared, prepareErr := prepareSystemSetting(payload, external, id)
		if prepareErr != nil {
			return failure("FORBIDDEN", prepareErr.Error())
		}
		payload = prepared
		if expected := fmt.Sprint(payload["expectedStatus"]); table == "transfer_events" && expected != "" && expected != "<nil>" {
			current, err := s.store.Get(ctx, table, id)
			if err != nil {
				return failure("NOT_FOUND", "record was not found")
			}
			delete(payload, "expectedStatus")
			if fmt.Sprint(current["current_status"]) != expected {
				return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "expectedStatus": expected, "currentStatus": current["current_status"], "event": current, "message": "status changed by another terminal"}
			}
		}
		if conflict := s.checkMasterRevision(ctx, table, id, payload); conflict != nil {
			return conflict
		}
		if table == "beds" {
			if result := s.validateBed(ctx, id, payload); result != nil {
				return result
			}
		}
		var beforeMutation database.DB
		if s.audit != nil {
			var snapshotErr error
			beforeMutation, snapshotErr = s.store.Snapshot()
			if snapshotErr != nil {
				return failure("REQUEST_FAILED", snapshotErr.Error())
			}
		}
		row, err := s.store.Update(ctx, table, id, payload)
		if err != nil {
			return failure("REQUEST_FAILED", err.Error())
		}
		if auditErr := s.auditMutation("DB_UPDATE", table, id, external); auditErr != nil {
			return s.rollbackMutation(ctx, beforeMutation, auditErr)
		}
		return row
	case http.MethodDelete:
		if protectedSetting(id) && table == "system_settings" {
			return failure("FORBIDDEN", "protected setting is not writable")
		}
		if table == "wards" {
			db, _ := s.store.Snapshot()
			for _, bed := range database.Rows(db, "beds") {
				if fmt.Sprint(bed["ward_id"]) == id {
					return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "message": "ward still has beds"}
				}
			}
		}
		if table == "beds" {
			events, _ := s.store.List(ctx, "transfer_events")
			for _, event := range events {
				if fmt.Sprint(event["bed_id"]) == id && isActiveTransferStatus(event["current_status"]) {
					return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "message": "bed has an active transfer"}
				}
			}
		}
		var beforeMutation database.DB
		if s.audit != nil {
			var snapshotErr error
			beforeMutation, snapshotErr = s.store.Snapshot()
			if snapshotErr != nil {
				return failure("REQUEST_FAILED", snapshotErr.Error())
			}
		}
		row, err := s.store.Delete(ctx, table, id)
		if err != nil {
			return failure("REQUEST_FAILED", err.Error())
		}
		if auditErr := s.auditMutation("DB_DELETE", table, id, external); auditErr != nil {
			return s.rollbackMutation(ctx, beforeMutation, auditErr)
		}
		return row
	default:
		return failure("METHOD_NOT_ALLOWED", "method is not supported")
	}
}

var masterRevisionTables = map[string]bool{"wards": true, "beds": true, "exam_rooms": true, "exam_types": true, "staffs": true, "system_settings": true}

func protectedSetting(id string) bool {
	switch id {
	case "admin_passcode", "api_token", "odbc_connection_string", "smb_password":
		return true
	default:
		return false
	}
}

func decryptLocalSettings(rows []map[string]any) []map[string]any {
	for _, row := range rows {
		if !protectedSetting(fmt.Sprint(row["id"])) || fmt.Sprint(row["id"]) == "admin_passcode" {
			continue
		}
		plain, err := security.DecryptSensitiveValue(fmt.Sprint(row["value"]))
		if err != nil {
			row["value"] = ""
		} else {
			row["value"] = plain
		}
	}
	return rows
}

func prepareSystemSetting(payload map[string]any, external bool, idOverride string) (map[string]any, error) {
	if payload == nil {
		return payload, nil
	}
	id := fmt.Sprint(payload["id"])
	if strings.TrimSpace(idOverride) != "" {
		id = idOverride
	}
	if !protectedSetting(id) {
		return payload, nil
	}
	if external || id == "admin_passcode" {
		return nil, fmt.Errorf("protected setting is not writable")
	}
	value, exists := payload["value"]
	if !exists {
		return payload, nil
	}
	protected, err := security.EncryptSensitiveValue(fmt.Sprint(value))
	if err != nil {
		return nil, err
	}
	copy := make(map[string]any, len(payload))
	for key, item := range payload {
		copy[key] = item
	}
	copy["value"] = protected
	return copy, nil
}

func (s *Server) checkMasterRevision(ctx context.Context, table, id string, payload map[string]any) map[string]any {
	if !masterRevisionTables[table] || payload == nil {
		return nil
	}
	expected, exists := payload["_expectedUpdatedAt"]
	if !exists {
		return nil
	}
	current, err := s.store.Get(ctx, table, id)
	if err != nil {
		return failure("NOT_FOUND", "record was not found")
	}
	delete(payload, "_expectedUpdatedAt")
	if fmt.Sprint(current["updated_at"]) != fmt.Sprint(expected) {
		return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "message": "master was updated by another terminal", "current": current}
	}
	return nil
}

func (s *Server) validateBed(ctx context.Context, id string, payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	db, err := s.store.Snapshot()
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	current, _ := database.FindRow(db, "beds", id)
	merged := map[string]any{}
	if current != nil {
		for key, value := range current {
			merged[key] = value
		}
	}
	for key, value := range payload {
		if key != "bed_type" {
			merged[key] = value
		}
	}
	bedNumber := strings.TrimSpace(fmt.Sprint(merged["bed_number"]))
	if bedNumber == "" || bedNumber == "<nil>" {
		return failure("VALIDATION_FAILED", "bed_number is required")
	}
	wardID := strings.TrimSpace(fmt.Sprint(merged["ward_id"]))
	if wardID != "" && wardID != "<nil>" {
		if _, index := database.FindRow(db, "wards", wardID); index < 0 {
			return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "message": "ward does not exist"}
		}
	}
	for _, other := range database.Rows(db, "beds") {
		if fmt.Sprint(other["id"]) != id && strings.EqualFold(strings.TrimSpace(fmt.Sprint(other["bed_number"])), bedNumber) {
			return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "message": "bed_number already exists"}
		}
	}
	return nil
}

func (s *Server) handleTransferStart(ctx context.Context, payload map[string]any, external bool) map[string]any {
	eventID, bedID := strings.TrimSpace(fmt.Sprint(payload["eventId"])), strings.TrimSpace(fmt.Sprint(payload["bedId"]))
	examTypeID, examRoomID := strings.TrimSpace(fmt.Sprint(payload["examTypeId"])), strings.TrimSpace(fmt.Sprint(payload["examRoomId"]))
	if eventID == "" || eventID == "<nil>" || bedID == "" || bedID == "<nil>" || examTypeID == "" || examTypeID == "<nil>" || examRoomID == "" || examRoomID == "<nil>" {
		return failure("VALIDATION_FAILED", "transfer start fields are incomplete")
	}
	if _, err := s.store.Get(ctx, "beds", bedID); err != nil {
		return failure("NOT_FOUND", "bed was not found")
	}
	if existing, _ := s.store.Get(ctx, "transfer_events", eventID); existing != nil {
		return map[string]any{"success": true, "idempotent": true, "event": existing}
	}
	if events, err := s.store.List(ctx, "transfer_events"); err == nil {
		for _, existing := range events {
			if fmt.Sprint(existing["bed_id"]) == bedID && isActiveTransferStatus(existing["current_status"]) {
				return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "conflictType": "active_bed", "existingEventId": existing["id"], "message": "bed already has an active transfer"}
			}
		}
	}
	now, duration := time.Now().UnixMilli(), 30
	if raw, ok := payload["expectedDurationMin"].(float64); ok && raw >= 5 && raw <= 300 {
		duration = int(raw)
	}
	event := map[string]any{"id": eventID, "bed_id": bedID, "ward_id": payload["wardId"], "exam_type_id": examTypeID, "exam_room_id": examRoomID, "escort_staff_id": payload["escortStaffId"], "current_status": string(transfer.Moving), "expected_duration_min": duration, "estimated_pickup_at": now + int64(duration)*60*1000, "note": payload["note"], "patient_name": payload["patientName"], "patient_id": payload["patientId"], "patient_ic_tag_id": payload["patientIcTagId"], "registered_at": now, "created_at": now, "departed_at": now}
	logID := fmt.Sprintf("log-%d", time.Now().UnixNano())
	logRow := map[string]any{"id": logID, "transfer_event_id": eventID, "from_status": nil, "to_status": string(transfer.Moving), "changed_by": actorFor(external, "local_ui"), "changed_at": now, "note": ""}
	created, _, err := s.store.CreateAndCreate(ctx, "transfer_events", event, "transfer_status_logs", logRow)
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	if s.audit != nil {
		if auditErr := s.audit.Append(database.AuditEvent{Action: "TRANSFER_START", TargetType: "transfer_events", TargetID: eventID, ActorType: actorFor(external, "local_ui")}); auditErr != nil {
			rollbackErr := s.store.RollbackCreateAndCreate(ctx, "transfer_events", eventID, "transfer_status_logs", logID, string(transfer.Moving))
			if rollbackErr != nil {
				return failure("REQUEST_FAILED", fmt.Sprintf("audit transfer start: %v; rollback: %v", auditErr, rollbackErr))
			}
			return failure("REQUEST_FAILED", fmt.Sprintf("audit transfer start: %v", auditErr))
		}
	}
	return map[string]any{"success": true, "idempotent": false, "event": created}
}

func actorFor(external bool, source string) string {
	if external {
		return "child_api"
	}
	switch source {
	case "ic_scan", "system", "maintenance":
		return source
	default:
		return "local_ui"
	}
}
func (s *Server) handleStatusUpdate(ctx context.Context, payload map[string]any, external bool) map[string]any {
	return s.handleStatusUpdateInternal(ctx, payload, external, false)
}
func (s *Server) handleStatusUpdateAuthorized(ctx context.Context, payload map[string]any) map[string]any {
	return s.handleStatusUpdateInternal(ctx, payload, false, true)
}

func (s *Server) handleStatusUpdateInternal(ctx context.Context, payload map[string]any, external, maintenanceAuthorized bool) map[string]any {
	eventID := strings.TrimSpace(fmt.Sprint(payload["eventId"]))
	newStatus := transfer.Status(strings.TrimSpace(fmt.Sprint(payload["newStatus"])))
	if eventID == "" || !transfer.Known(string(newStatus)) {
		return failure("VALIDATION_FAILED", "status update fields are invalid")
	}
	scope := fmt.Sprint(payload["scope"])
	if scope != "exam" {
		scope = "ward"
	}
	source := fmt.Sprint(payload["source"])
	if external {
		source = "child_api"
	}
	if source == "maintenance" && !maintenanceAuthorized {
		return failure("UNAUTHORIZED", "maintenance authorization is required")
	}
	if maintenanceAuthorized && (source != "maintenance" || newStatus != transfer.Returned || scope != "ward") {
		return failure("VALIDATION_FAILED", "invalid maintenance transition")
	}
	current, err := s.store.Get(ctx, "transfer_events", eventID)
	if err != nil {
		return failure("NOT_FOUND", "transfer event was not found")
	}
	fromStatus := transfer.Status(fmt.Sprint(current["current_status"]))
	if expected := fmt.Sprint(payload["expectedStatus"]); expected != "" && expected != "<nil>" && expected != string(fromStatus) {
		return map[string]any{"success": false, "conflict": true, "code": "CONFLICT", "expectedStatus": expected, "currentStatus": fromStatus, "event": current, "message": "status changed by another terminal"}
	}
	if fromStatus == newStatus {
		return map[string]any{"success": true, "idempotent": true, "event": current}
	}
	previous := cloneRecord(current)
	allowed := transfer.Allowed(scope, fromStatus, newStatus)
	if maintenanceAuthorized && newStatus == transfer.Returned && scope == "ward" && isActiveTransferStatus(fromStatus) {
		allowed = true
	}
	if !allowed {
		return failure("VALIDATION_FAILED", fmt.Sprintf("invalid status transition: %s -> %s", fromStatus, newStatus))
	}
	now := time.Now().UnixMilli()
	patch := map[string]any{"current_status": string(newStatus)}
	if field := transfer.TimestampField(newStatus); field != "" {
		patch[field] = now
	}
	if newStatus == transfer.Returned || newStatus == transfer.Cancelled {
		patch["patient_ic_tag_id"] = nil
	}
	if extra, ok := payload["extraFields"].(map[string]any); ok {
		for _, key := range []string{"patient_ic_tag_id", "note", "escort_staff_id", "estimated_pickup_at"} {
			if value, exists := extra[key]; exists {
				patch[key] = value
			}
		}
	}
	logRow := map[string]any{"id": fmt.Sprintf("log-%d", time.Now().UnixNano()), "transfer_event_id": eventID, "from_status": string(fromStatus), "to_status": string(newStatus), "changed_by": actorFor(external, source), "changed_at": now, "note": ""}
	updated, _, err := s.store.UpdateAndCreate(ctx, "transfer_events", eventID, patch, "transfer_status_logs", logRow)
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	if s.audit != nil {
		if auditErr := s.audit.Append(database.AuditEvent{Action: "TRANSFER_STATUS_CHANGE", TargetType: "transfer_events", TargetID: eventID, ActorType: actorFor(external, source), Details: map[string]any{"from": fromStatus, "to": newStatus, "scope": scope}}); auditErr != nil {
			rollbackErr := s.store.RollbackUpdateAndCreate(ctx, "transfer_events", eventID, previous, "transfer_status_logs", fmt.Sprint(logRow["id"]), string(newStatus))
			if rollbackErr != nil {
				return failure("REQUEST_FAILED", fmt.Sprintf("audit status change: %v; rollback: %v", auditErr, rollbackErr))
			}
			return failure("REQUEST_FAILED", fmt.Sprintf("audit status change: %v", auditErr))
		}
	}
	return map[string]any{"success": true, "event": updated, "log": logRow}
}

func (s *Server) handleStatusNote(ctx context.Context, payload map[string]any, external bool) map[string]any {
	eventID, note := strings.TrimSpace(fmt.Sprint(payload["eventId"])), strings.TrimSpace(fmt.Sprint(payload["note"]))
	if eventID == "" || note == "" {
		return failure("VALIDATION_FAILED", "eventId and note are required")
	}
	if _, err := s.store.Get(ctx, "transfer_events", eventID); err != nil {
		return failure("NOT_FOUND", "transfer event was not found")
	}
	row, err := s.store.Create(ctx, "transfer_status_logs", map[string]any{"id": fmt.Sprintf("note-%d", time.Now().UnixNano()), "transfer_event_id": eventID, "from_status": nil, "to_status": nil, "changed_by": actorFor(external, fmt.Sprint(payload["source"])), "changed_at": time.Now().UnixMilli(), "note": note})
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	return map[string]any{"success": true, "log": row}
}
func (s *Server) handleStatusAck(ctx context.Context, payload map[string]any, external bool) map[string]any {
	logID, wardID := strings.TrimSpace(fmt.Sprint(payload["logId"])), strings.TrimSpace(fmt.Sprint(payload["wardId"]))
	if logID == "" || wardID == "" {
		return failure("VALIDATION_FAILED", "logId and wardId are required")
	}
	row, err := s.store.Update(ctx, "transfer_status_logs", logID, map[string]any{"acknowledged_at": time.Now().UnixMilli(), "acknowledged_by": actorFor(external, "local_ui"), "acknowledged_ward_id": wardID})
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	return map[string]any{"success": true, "log": row}
}
func (s *Server) handleHeartbeat(payload map[string]any) map[string]any {
	deviceID := strings.TrimSpace(fmt.Sprint(payload["deviceId"]))
	if deviceID == "" || deviceID == "<nil>" {
		return failure("VALIDATION_FAILED", "deviceId is required")
	}
	s.presence.Heartbeat(Device{
		DeviceID:     deviceID,
		Name:         payloadText(payload, "name"),
		Hostname:     payloadText(payload, "hostname"),
		WardID:       payloadText(payload, "wardId"),
		Mode:         payloadText(payload, "mode"),
		AppVersion:   payloadText(payload, "appVersion"),
		Page:         payloadText(payload, "page"),
		TerminalName: payloadText(payload, "terminalName"),
		TerminalRole: payloadText(payload, "terminalRole"),
		IP:           payloadText(payload, "ip"),
	})
	return map[string]any{"success": true}
}

func payloadText(payload map[string]any, key string) string {
	value := strings.TrimSpace(fmt.Sprint(payload[key]))
	if value == "<nil>" {
		return ""
	}
	return value
}
func (s *Server) handleWebRTC(method, path string, payload map[string]any) map[string]any {
	return s.signaling.Handle(method, path, payload)
}

var activeTransferStatuses = map[string]bool{string(transfer.Moving): true, string(transfer.Arrived): true, string(transfer.InExam): true, string(transfer.NearlyDone): true, string(transfer.PickupRequired): true}

func isActiveTransferStatus(value any) bool { return activeTransferStatuses[fmt.Sprint(value)] }
func filterRows(table string, rows []map[string]any, query url.Values) []map[string]any {
	filtered := rows
	match := func(row map[string]any, key string) bool {
		value := query.Get(key)
		return value == "" || fmt.Sprint(row[key]) == value
	}
	switch table {
	case "transfer_events":
		filtered = make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if !match(row, "ward_id") || !match(row, "bed_id") {
				continue
			}
			if query.Get("completed_only") == "true" && fmt.Sprint(row["current_status"]) != "RETURNED" && fmt.Sprint(row["current_status"]) != "CANCELLED" {
				continue
			}
			if query.Get("active_only") == "true" && !isActiveTransferStatus(row["current_status"]) {
				continue
			}
			filtered = append(filtered, row)
		}
	case "transfer_status_logs":
		if value := query.Get("transfer_event_id"); value != "" {
			filtered = filterByValue(rows, "transfer_event_id", value)
		}
	case "bed_occupancy_log":
		if value := query.Get("bed_id"); value != "" {
			filtered = filterByValue(rows, "bed_id", value)
		}
	case "handover_notes":
		if value := query.Get("ward_id"); value != "" {
			filtered = filterByValue(rows, "ward_id", value)
		}
	case "schedule_items":
		start, end := parseInt64(query.Get("start_ms")), parseInt64(query.Get("end_ms"))
		if start > 0 && end > 0 {
			filtered = make([]map[string]any, 0, len(rows))
			for _, row := range rows {
				value := anyInt64(row["start_ms"])
				if value >= start && value < end {
					filtered = append(filtered, row)
				}
			}
		}
	case "system_settings":
		filtered = make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			copy := make(map[string]any, len(row))
			for key, value := range row {
				copy[key] = value
			}
			if fmt.Sprint(copy["id"]) == "admin_passcode" || fmt.Sprint(copy["id"]) == "api_token" {
				copy["value"] = "********"
			}
			filtered = append(filtered, copy)
		}
	}
	return filtered
}
func filterByValue(rows []map[string]any, key, expected string) []map[string]any {
	filtered := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if fmt.Sprint(row[key]) == expected {
			filtered = append(filtered, row)
		}
	}
	return filtered
}
func parseInt64(value string) int64 {
	parsed, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	return parsed
}
func anyInt64(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	case string:
		return parseInt64(typed)
	default:
		return parseInt64(fmt.Sprint(value))
	}
}

func (s *Server) wardStatus(ctx context.Context, query url.Values) map[string]any {
	events, err := s.store.List(ctx, "transfer_events")
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	wardID, today := query.Get("ward_id"), anyInt64(query.Get("today_ms"))
	scoped := make([]map[string]any, 0, len(events))
	for _, event := range events {
		if wardID == "" || fmt.Sprint(event["ward_id"]) == wardID {
			scoped = append(scoped, event)
		}
	}
	active, todayEvents := make([]map[string]any, 0), make([]map[string]any, 0)
	for _, event := range scoped {
		if isActiveTransferStatus(event["current_status"]) {
			active = append(active, event)
			todayEvents = append(todayEvents, event)
		} else if today > 0 && anyInt64(event["departed_at"]) >= today {
			todayEvents = append(todayEvents, event)
		}
	}
	return map[string]any{"success": true, "activeEvents": active, "todayEvents": todayEvents, "recentStatusLogs": s.recentLogs(ctx, scoped, today, false)}
}
func (s *Server) examRoomGridStatus(ctx context.Context) map[string]any {
	events, err := s.store.List(ctx, "transfer_events")
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	data := make([]map[string]any, 0, len(events))
	for _, event := range events {
		if isActiveTransferStatus(event["current_status"]) {
			data = append(data, map[string]any{"exam_room_id": event["exam_room_id"], "current_status": event["current_status"]})
		}
	}
	return map[string]any{"success": true, "data": data}
}
func (s *Server) examRoomStatus(ctx context.Context, query url.Values) map[string]any {
	events, err := s.store.List(ctx, "transfer_events")
	if err != nil {
		return failure("REQUEST_FAILED", err.Error())
	}
	roomID, today := query.Get("exam_room_id"), anyInt64(query.Get("today_ms"))
	scoped := make([]map[string]any, 0, len(events))
	for _, event := range events {
		if roomID == "" || fmt.Sprint(event["exam_room_id"]) == roomID {
			scoped = append(scoped, event)
		}
	}
	active := make([]map[string]any, 0)
	for _, event := range scoped {
		if isActiveTransferStatus(event["current_status"]) {
			active = append(active, event)
		}
	}
	logs, _ := s.store.List(ctx, "transfer_status_logs")
	latest := map[string]map[string]any{}
	for _, log := range logs {
		key := fmt.Sprint(log["transfer_event_id"])
		for _, event := range active {
			if fmt.Sprint(event["id"]) == key && fmt.Sprint(log["from_status"]) != fmt.Sprint(log["to_status"]) && fmt.Sprint(log["to_status"]) == fmt.Sprint(event["current_status"]) && latest[key] == nil {
				latest[key] = log
			}
		}
	}
	data := make([]map[string]any, 0, len(active))
	for _, event := range active {
		copy := make(map[string]any, len(event)+1)
		for key, value := range event {
			copy[key] = value
		}
		copy["latest_status_log"] = latest[fmt.Sprint(event["id"])]
		data = append(data, copy)
	}
	return map[string]any{"success": true, "data": data, "recentStatusLogs": s.recentLogs(ctx, scoped, today, true)}
}
func (s *Server) recentLogs(ctx context.Context, events []map[string]any, today int64, includeWard bool) []map[string]any {
	logs, err := s.store.List(ctx, "transfer_status_logs")
	if err != nil {
		return []map[string]any{}
	}
	eventByID := map[string]map[string]any{}
	for _, event := range events {
		eventByID[fmt.Sprint(event["id"])] = event
	}
	filtered := make([]map[string]any, 0)
	for _, log := range logs {
		event := eventByID[fmt.Sprint(log["transfer_event_id"])]
		if event == nil || fmt.Sprint(log["from_status"]) == fmt.Sprint(log["to_status"]) {
			continue
		}
		changedToday := today <= 0 || anyInt64(log["changed_at"]) >= today
		if !changedToday && !(isActiveTransferStatus(event["current_status"]) && fmt.Sprint(log["to_status"]) == fmt.Sprint(event["current_status"])) {
			continue
		}
		copy := make(map[string]any, len(log)+4)
		for key, value := range log {
			copy[key] = value
		}
		copy["bed_id"], copy["exam_room_id"], copy["patient_name"] = event["bed_id"], event["exam_room_id"], event["patient_name"]
		if includeWard {
			copy["ward_id"] = event["ward_id"]
		}
		filtered = append(filtered, copy)
	}
	sort.SliceStable(filtered, func(i, j int) bool { return anyInt64(filtered[i]["changed_at"]) > anyInt64(filtered[j]["changed_at"]) })
	if len(filtered) > 20 {
		filtered = filtered[:20]
	}
	return filtered
}

func (s *Server) handleBulkUpdate(ctx context.Context, table string, payload map[string]any, external bool, method string) map[string]any {
	items, ok := payload["__bulk"].([]any)
	if !ok {
		return failure("VALIDATION_FAILED", "bulk body must be an array")
	}
	if len(items) > 1000 {
		return failure("VALIDATION_FAILED", "bulk request is too large")
	}
	updated := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			return failure("VALIDATION_FAILED", "bulk item must be an object")
		}
		if table == "system_settings" {
			prepared, prepareErr := prepareSystemSetting(item, external, "")
			if prepareErr != nil {
				return failure("FORBIDDEN", prepareErr.Error())
			}
			item = prepared
		}
		if table == "transfer_events" {
			if _, exists := item["current_status"]; exists {
				return failure("VALIDATION_FAILED", "use status/update for status changes")
			}
		}
		id := strings.TrimSpace(fmt.Sprint(item["id"]))
		if id == "" {
			return failure("VALIDATION_FAILED", "id is required")
		}
		if table == "beds" {
			if result := s.validateBed(ctx, id, item); result != nil {
				return result
			}
		}
		if method == http.MethodPatch {
			if result := s.checkMasterRevision(ctx, table, id, item); result != nil {
				return result
			}
		}
		var row map[string]any
		var err error
		if method == http.MethodPost {
			if _, getErr := s.store.Get(ctx, table, id); getErr == nil {
				row, err = s.store.Update(ctx, table, id, item)
			} else {
				row, err = s.store.Create(ctx, table, item)
			}
		} else {
			row, err = s.store.Update(ctx, table, id, item)
		}
		if err != nil {
			return failure("REQUEST_FAILED", err.Error())
		}
		updated = append(updated, row)
		if auditErr := s.auditMutation("DB_BULK_UPDATE", table, id, external); auditErr != nil {
			return failure("REQUEST_FAILED", auditErr.Error())
		}
	}
	return map[string]any{"success": true, "count": len(updated), "data": updated}
}
func (s *Server) auditMutation(action, table, id string, external bool) error {
	if s.audit == nil {
		return nil
	}
	actor := "local_ui"
	if external {
		actor = "child_api"
	}
	return s.audit.Append(database.AuditEvent{Action: action, TargetType: table, TargetID: id, ActorType: actor})
}

func (s *Server) rollbackMutation(ctx context.Context, before database.DB, auditErr error) map[string]any {
	if before == nil {
		return failure("REQUEST_FAILED", fmt.Sprintf("audit mutation: %v", auditErr))
	}
	data, encodeErr := database.Encode(before)
	if encodeErr != nil {
		return failure("REQUEST_FAILED", fmt.Sprintf("audit mutation: %v; encode rollback: %v", auditErr, encodeErr))
	}
	if rollbackErr := s.store.ReplaceFromJSON(ctx, data); rollbackErr != nil {
		return failure("REQUEST_FAILED", fmt.Sprintf("audit mutation: %v; rollback: %v", auditErr, rollbackErr))
	}
	return failure("REQUEST_FAILED", fmt.Sprintf("audit mutation: %v", auditErr))
}
func statusCode(result map[string]any) int {
	if result["success"] != false {
		return http.StatusOK
	}
	switch fmt.Sprint(result["code"]) {
	case "UNAUTHORIZED":
		return http.StatusUnauthorized
	case "FORBIDDEN":
		return http.StatusForbidden
	case "NOT_FOUND":
		return http.StatusNotFound
	case "CONFLICT":
		return http.StatusConflict
	case "METHOD_NOT_ALLOWED":
		return http.StatusMethodNotAllowed
	default:
		return http.StatusBadRequest
	}
}
func parseInt(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		if parsed, err := strconv.Atoi(typed); err == nil {
			return parsed
		}
	}
	return fallback
}
