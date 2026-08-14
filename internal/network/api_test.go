package network

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pocket-dev-id/transboard/internal/database"
	"github.com/pocket-dev-id/transboard/internal/security"
)

func testServer(t *testing.T) (*Server, func()) {
	t.Helper()
	store := database.NewStore(filepath.Join(t.TempDir(), "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	audit := database.NewAuditService(filepath.Join(t.TempDir(), "audit-log.jsonl"))
	server := NewServer(store, audit, func() string { return "token" })
	return server, func() { _ = store.Close() }
}

func serverWithFailingAudit(t *testing.T) (*Server, *database.Store, func()) {
	t.Helper()
	root := t.TempDir()
	store := database.NewStore(filepath.Join(root, "db.json"))
	if err := store.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(root, "audit-parent")
	if err := os.WriteFile(parent, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	audit := database.NewAuditService(filepath.Join(parent, "audit-log.jsonl"))
	server := NewServer(store, audit, func() string { return "token" })
	return server, store, func() { _ = store.Close() }
}

func TestExternalAPITokenAndTransition(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()
	request := httptest.NewRequest(http.MethodPost, "/tables/transfer_events", strings.NewReader(`{"id":"e1","current_status":"MOVING"}`))
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected auth failure, got %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodPost, "/tables/transfer_events", strings.NewReader(`{"id":"e1","current_status":"MOVING"}`))
	request.Header.Set("X-API-Token", "token")
	response = httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPost, "/status/update", strings.NewReader(`{"eventId":"e1","newStatus":"RETURNED","scope":"ward"}`))
	request.Header.Set("X-API-Token", "token")
	response = httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid transition should fail: %d", response.Code)
	}
}

func TestLocalRequestDefaultsToGetWhenMethodIsOmitted(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()

	result := server.LocalRequest(context.Background(), map[string]any{
		"url": "tables/system_settings",
	})
	if result["success"] != true {
		t.Fatalf("local request without method should default to GET: %#v", result)
	}
}

func TestMaintenanceFlagCannotBypassTransition(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()
	header := func(request *http.Request) { request.Header.Set("X-API-Token", "token") }

	create := httptest.NewRequest(http.MethodPost, "/tables/transfer_events", strings.NewReader(`{"id":"e-maint","current_status":"MOVING"}`))
	header(create)
	created := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(created, create)
	if created.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", created.Code, created.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/status/update", strings.NewReader(`{"eventId":"e-maint","newStatus":"RETURNED","scope":"ward","maintenance":true}`))
	header(request)
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("maintenance flag should not bypass transition: %d %s", response.Code, response.Body.String())
	}
}

func TestStatusAuditFailureRollsBackEventAndHistory(t *testing.T) {
	server, store, cleanup := serverWithFailingAudit(t)
	defer cleanup()
	if _, err := store.Create(context.Background(), "transfer_events", map[string]any{"id": "e-audit", "current_status": "MOVING"}); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/status/update", strings.NewReader(`{"eventId":"e-audit","newStatus":"ARRIVED","scope":"ward","expectedStatus":"MOVING"}`))
	request.Header.Set("X-API-Token", "token")
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("audit failure should fail status update: %d %s", response.Code, response.Body.String())
	}
	event, err := store.Get(context.Background(), "transfer_events", "e-audit")
	if err != nil || fmt.Sprint(event["current_status"]) != "MOVING" {
		t.Fatalf("event was not rolled back after audit failure: %#v, %v", event, err)
	}
	logs, err := store.List(context.Background(), "transfer_status_logs")
	if err != nil || len(logs) != 0 {
		t.Fatalf("status history was not rolled back: %#v, %v", logs, err)
	}
}

func TestTransferStartAuditFailureRollsBackEventAndHistory(t *testing.T) {
	server, store, cleanup := serverWithFailingAudit(t)
	defer cleanup()
	if _, err := store.Create(context.Background(), "beds", map[string]any{"id": "bed-audit", "bed_number": "101"}); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/transfer/start", strings.NewReader(`{"eventId":"e-start-audit","bedId":"bed-audit","examTypeId":"exam","examRoomId":"room"}`))
	request.Header.Set("X-API-Token", "token")
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("audit failure should fail transfer start: %d %s", response.Code, response.Body.String())
	}
	if _, err := store.Get(context.Background(), "transfer_events", "e-start-audit"); err == nil {
		t.Fatal("transfer event remained after audit failure")
	}
	logs, err := store.List(context.Background(), "transfer_status_logs")
	if err != nil || len(logs) != 0 {
		t.Fatalf("initial status history remained after audit failure: %#v, %v", logs, err)
	}
}

func TestTableAuditFailureRollsBackDatabaseMutation(t *testing.T) {
	server, store, cleanup := serverWithFailingAudit(t)
	defer cleanup()
	request := httptest.NewRequest(http.MethodPost, "/tables/beds", strings.NewReader(`{"id":"bed-table-audit","bed_number":"101"}`))
	request.Header.Set("X-API-Token", "token")
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("audit failure should fail table mutation: %d %s", response.Code, response.Body.String())
	}
	if _, err := store.Get(context.Background(), "beds", "bed-table-audit"); err == nil {
		t.Fatal("table mutation remained after audit failure")
	}
}

func TestChildTransitionRecordsActorAndExpectedStatus(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()
	header := func(request *http.Request) { request.Header.Set("X-API-Token", "token") }

	create := httptest.NewRequest(http.MethodPost, "/tables/transfer_events", strings.NewReader(`{"id":"e-child","current_status":"MOVING"}`))
	header(create)
	created := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(created, create)
	if created.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", created.Code, created.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/status/update", strings.NewReader(`{"eventId":"e-child","newStatus":"ARRIVED","scope":"ward","expectedStatus":"MOVING"}`))
	header(request)
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("child transition failed: %d %s", response.Code, response.Body.String())
	}

	logs := httptest.NewRequest(http.MethodGet, "/tables/transfer_status_logs?transfer_event_id=e-child", nil)
	header(logs)
	logResponse := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(logResponse, logs)
	if logResponse.Code != http.StatusOK {
		t.Fatalf("log read failed: %d", logResponse.Code)
	}
	if !strings.Contains(logResponse.Body.String(), `"changed_by":"child_api"`) {
		t.Fatalf("child actor was not recorded: %s", logResponse.Body.String())
	}
}

func TestConcurrentExpectedStatusAllowsOnlyOneTransition(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()
	header := func(request *http.Request) { request.Header.Set("X-API-Token", "token") }

	create := httptest.NewRequest(http.MethodPost, "/tables/transfer_events", strings.NewReader(`{"id":"e-race","current_status":"MOVING"}`))
	header(create)
	created := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(created, create)
	if created.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", created.Code, created.Body.String())
	}

	statuses := make(chan int, 2)
	var wait sync.WaitGroup
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			request := httptest.NewRequest(http.MethodPost, "/status/update", strings.NewReader(`{"eventId":"e-race","newStatus":"ARRIVED","scope":"ward","expectedStatus":"MOVING"}`))
			header(request)
			response := httptest.NewRecorder()
			server.Handler(true).ServeHTTP(response, request)
			statuses <- response.Code
		}()
	}
	wait.Wait()
	close(statuses)
	var succeeded, conflicted int
	for status := range statuses {
		if status == http.StatusOK {
			succeeded++
		}
		if status == http.StatusConflict {
			conflicted++
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("expected one success and one conflict, got success=%d conflict=%d", succeeded, conflicted)
	}
}

func TestUpdateDistributionRequiresToken(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), []byte(`{"version":"2.0.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	server.SetUpdateDirectory(directory)

	unauthorized := httptest.NewRequest(http.MethodGet, "/updates/manifest.json", nil)
	unauthorizedResponse := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("expected update auth failure, got %d", unauthorizedResponse.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/updates/manifest.json", nil)
	request.Header.Set("X-API-Token", "token")
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "2.0.0") {
		t.Fatalf("update manifest was not served: %d %s", response.Code, response.Body.String())
	}
}

func TestHeartbeatPreservesPresenceMetadata(t *testing.T) {
	server, cleanup := testServer(t)
	defer cleanup()
	heartbeat := httptest.NewRequest(http.MethodPost, "/device/heartbeat", strings.NewReader(`{"deviceId":"d1","name":"Exam PC","wardId":"w1","appVersion":"2.0.0","page":"exam-room"}`))
	heartbeat.Header.Set("X-API-Token", "token")
	response := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(response, heartbeat)
	if response.Code != http.StatusOK {
		t.Fatalf("heartbeat failed: %d %s", response.Code, response.Body.String())
	}
	list := httptest.NewRequest(http.MethodGet, "/device/list", nil)
	list.Header.Set("X-API-Token", "token")
	listResponse := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(listResponse, list)
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), `"name":"Exam PC"`) || !strings.Contains(listResponse.Body.String(), `"page":"exam-room"`) {
		t.Fatalf("heartbeat metadata was lost: %d %s", listResponse.Code, listResponse.Body.String())
	}
}

func TestLocalSensitiveSettingsAreEncryptedAndExternalValuesAreMasked(t *testing.T) {
	if !security.EncryptionAvailable() {
		t.Skip("sensitive setting contract requires Windows DPAPI")
	}
	server, cleanup := testServer(t)
	defer cleanup()

	request := httptest.NewRequest(http.MethodPatch, "/tables/system_settings/odbc_connection_string", strings.NewReader(`{"value":"DSN=TEST;PWD=secret"}`))
	response := httptest.NewRecorder()
	server.Handler(false).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("local sensitive setting update failed: %d %s", response.Code, response.Body.String())
	}

	local := httptest.NewRequest(http.MethodGet, "/tables/system_settings/odbc_connection_string", nil)
	localResponse := httptest.NewRecorder()
	server.Handler(false).ServeHTTP(localResponse, local)
	if localResponse.Code != http.StatusOK || !strings.Contains(localResponse.Body.String(), "DSN=TEST") || strings.Contains(localResponse.Body.String(), "ENCRYPTED:") {
		t.Fatalf("local setting was not returned in decrypted form: %d %s", localResponse.Code, localResponse.Body.String())
	}

	external := httptest.NewRequest(http.MethodGet, "/tables/system_settings", nil)
	external.Header.Set("X-API-Token", "token")
	externalResponse := httptest.NewRecorder()
	server.Handler(true).ServeHTTP(externalResponse, external)
	if externalResponse.Code != http.StatusOK || !strings.Contains(externalResponse.Body.String(), "********") || strings.Contains(externalResponse.Body.String(), "PWD=secret") {
		t.Fatalf("external settings leaked a secret: %d %s", externalResponse.Code, externalResponse.Body.String())
	}
}
