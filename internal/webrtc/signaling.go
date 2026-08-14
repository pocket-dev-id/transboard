package webrtc

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
var allowedTypes = map[string]bool{"offer": true, "answer": true, "ice": true, "hangup": true, "busy": true, "speech": true, "answered": true}
var broadcastTypes = map[string]bool{"offer": true, "speech": true, "answered": true}

type entry struct {
	message map[string]any
	created int64
	acked   map[string]bool
}

type Signaling struct {
	mu           sync.Mutex
	queues       map[string][]*entry
	maxKeys      int
	maxAge       int64
	maxBroadcast int
	maxUnicast   int
}

func NewSignaling(maxKeys int, maxAgeMilliseconds int64) *Signaling {
	if maxKeys <= 0 {
		maxKeys = 256
	}
	if maxAgeMilliseconds <= 0 {
		maxAgeMilliseconds = 30000
	}
	return &Signaling{queues: map[string][]*entry{}, maxKeys: maxKeys, maxAge: maxAgeMilliseconds, maxBroadcast: 100, maxUnicast: 50}
}

func (s *Signaling) cleanup(now int64) {
	for key, items := range s.queues {
		live := items[:0]
		for _, item := range items {
			if now-item.created < s.maxAge {
				live = append(live, item)
			}
		}
		if len(live) == 0 {
			delete(s.queues, key)
		} else {
			s.queues[key] = live
		}
	}
}

func (s *Signaling) Handle(method, path string, payload map[string]any) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	s.cleanup(now)
	clean := strings.TrimPrefix(path, "/")
	if strings.HasPrefix(clean, "webrtc/") {
		clean = strings.TrimPrefix(clean, "webrtc/")
	}
	if strings.HasPrefix(clean, "send") {
		if method != "POST" {
			return failure("METHOD_NOT_ALLOWED", "Method Not Allowed")
		}
		typ := fmt.Sprint(payload["type"])
		to := fmt.Sprint(payload["to"])
		from := fmt.Sprint(payload["from"])
		if !allowedTypes[typ] || !validID(to) || (from != "" && !validID(from)) {
			return failure("VALIDATION_FAILED", "Invalid signaling message")
		}
		if len(fmt.Sprint(payload)) > 256*1024 {
			return failure("VALIDATION_FAILED", "Signaling message too large")
		}
		key := to
		if broadcastTypes[typ] {
			key = "bc:" + to
		}
		if _, exists := s.queues[key]; !exists && len(s.queues) >= s.maxKeys {
			return failure("CONFLICT", "Signaling queue is busy")
		}
		if _, exists := s.queues[key]; !exists {
			s.queues[key] = []*entry{}
		}
		message := cloneMap(payload)
		message["msgId"] = fmt.Sprintf("%d-%d", now, len(s.queues[key]))
		max := s.maxUnicast
		if broadcastTypes[typ] {
			max = s.maxBroadcast
		}
		if len(s.queues[key]) >= max {
			s.queues[key] = s.queues[key][1:]
		}
		s.queues[key] = append(s.queues[key], &entry{message: message, created: now, acked: map[string]bool{}})
		return map[string]any{"success": true}
	}
	if strings.HasPrefix(clean, "poll") {
		if method != "GET" {
			return failure("METHOD_NOT_ALLOWED", "Method Not Allowed")
		}
		query := ""
		if index := strings.Index(clean, "?"); index >= 0 {
			query = clean[index+1:]
		}
		values, _ := url.ParseQuery(query)
		id, client := values.Get("id"), values.Get("client")
		if client == "" {
			client = id
		}
		if !validID(id) || !validID(client) {
			return failure("VALIDATION_FAILED", "Missing or invalid signaling id")
		}
		messages := []map[string]any{}
		bcKey := "bc:" + id
		for _, item := range s.queues[bcKey] {
			if item.acked[client] {
				continue
			}
			item.acked[client] = true
			messages = append(messages, cloneMap(item.message))
		}
		ucItems := s.queues[id]
		delete(s.queues, id)
		for _, item := range ucItems {
			messages = append(messages, cloneMap(item.message))
		}
		return map[string]any{"success": true, "messages": messages}
	}
	return failure("NOT_FOUND", "Not Found")
}

func validID(value string) bool {
	return len(value) > 0 && len(value) <= 128 && safeID.MatchString(value)
}

func cloneMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func failure(code, message string) map[string]any {
	return map[string]any{"success": false, "code": code, "message": message}
}
