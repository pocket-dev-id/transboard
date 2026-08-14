package network

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocket-dev-id/transboard/internal/database"
	"github.com/pocket-dev-id/transboard/internal/webrtc"
)

type Server struct {
	store          *database.Store
	audit          *database.AuditService
	token          TokenProvider
	signaling      *webrtc.Signaling
	presence       *Presence
	passcodeStatus func() map[string]any
	verifyPasscode func(string) map[string]any
	parentAction   func(context.Context, string, string, map[string]any, bool) map[string]any
	server         *http.Server
	listener       net.Listener
	updateDir      string
	mu             sync.Mutex
	statusMu       sync.Mutex
}

func (s *Server) SetPasscodeHandlers(status func() map[string]any, verify func(string) map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.passcodeStatus = status
	s.verifyPasscode = verify
}

func (s *Server) SetParentActionHandler(handler func(context.Context, string, string, map[string]any, bool) map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.parentAction = handler
}

func NewServer(store *database.Store, audit *database.AuditService, token TokenProvider) *Server {
	return &Server{
		store: store, audit: audit, token: token,
		signaling: webrtc.NewSignaling(256, 5*60*1000),
		presence:  NewPresence(90 * time.Second),
	}
}

func (s *Server) SetUpdateDirectory(directory string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updateDir = directory
}

func (s *Server) Start(ctx context.Context, port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		return nil
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return fmt.Errorf("listen parent API: %w", err)
	}
	s.listener = listener
	s.server = &http.Server{Handler: s.Handler(true)}
	go func() {
		_ = s.server.Serve(listener)
	}()
	go func() {
		<-ctx.Done()
		_ = s.Stop(context.Background())
	}()
	return nil
}

func (s *Server) Stop(ctx context.Context) error {
	s.mu.Lock()
	server := s.server
	if server == nil {
		s.mu.Unlock()
		return nil
	}
	s.server = nil
	s.listener = nil
	s.mu.Unlock()
	// Do not hold s.mu while waiting for active handlers. A parent action
	// handler may need that same mutex to read its callback, which would make
	// Shutdown wait forever during application exit.
	return server.Shutdown(ctx)
}

func (s *Server) Handler(external bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(strings.TrimPrefix(r.URL.Path, "/"), "updates/") {
			s.serveUpdateFile(w, r)
			return
		}
		requestPath := r.URL.Path
		if r.URL.RawQuery != "" {
			requestPath += "?" + r.URL.RawQuery
		}
		result := s.handle(r.Context(), r.Method, requestPath, r.Header, r.Body, external)
		writeJSONStatus(w, statusCode(result), result)
	})
}

func (s *Server) serveUpdateFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSONStatus(w, http.StatusMethodNotAllowed, failure("METHOD_NOT_ALLOWED", "method is not supported"))
		return
	}
	if !AuthorizedHeader(r.Header, s.token) {
		writeJSONStatus(w, http.StatusUnauthorized, failure("UNAUTHORIZED", "API token is invalid"))
		return
	}
	relative := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/"), "updates/")
	if relative == "" || filepath.Base(relative) != relative || strings.Contains(relative, "..") {
		writeJSONStatus(w, http.StatusNotFound, failure("NOT_FOUND", "update file was not found"))
		return
	}
	ext := strings.ToLower(filepath.Ext(relative))
	if ext != ".yml" && ext != ".json" && ext != ".exe" && ext != ".blockmap" {
		writeJSONStatus(w, http.StatusNotFound, failure("NOT_FOUND", "update file was not found"))
		return
	}
	s.mu.Lock()
	directory := s.updateDir
	s.mu.Unlock()
	if directory == "" {
		writeJSONStatus(w, http.StatusNotFound, failure("NOT_FOUND", "update distribution is not configured"))
		return
	}
	path := filepath.Join(directory, relative)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		writeJSONStatus(w, http.StatusNotFound, failure("NOT_FOUND", "update file was not found"))
		return
	}
	http.ServeFile(w, r, path)
}

func (s *Server) LocalRequest(ctx context.Context, request map[string]any) map[string]any {
	method := strings.TrimSpace(fmt.Sprint(request["method"]))
	if method == "" || method == "<nil>" {
		method = http.MethodGet
	}
	path := fmt.Sprint(request["url"])
	body := []byte(nil)
	if value := request["body"]; value != nil {
		if raw, ok := value.(string); ok {
			body = []byte(raw)
		} else if encoded, err := json.Marshal(value); err == nil {
			body = encoded
		}
	}
	return s.handle(ctx, method, "/"+strings.TrimPrefix(path, "/"), nil, bytes.NewReader(body), false)
}

func (s *Server) MaintenanceComplete(ctx context.Context, payload map[string]any) map[string]any {
	payload["newStatus"] = "RETURNED"
	payload["scope"] = "ward"
	payload["source"] = "maintenance"
	payload["extraFields"] = map[string]any{"patient_ic_tag_id": nil}
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	return s.handleStatusUpdateAuthorized(ctx, payload)
}

func writeJSONStatus(w http.ResponseWriter, status int, value map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
