package network

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func ParentRequest(ctx context.Context, request map[string]any) map[string]any {
	target := strings.TrimSpace(fmt.Sprint(request["url"]))
	if target == "<nil>" {
		target = ""
	}
	host := strings.TrimSpace(fmt.Sprint(request["parentIp"]))
	if host == "" || host == "<nil>" {
		host = strings.TrimSpace(fmt.Sprint(request["host"]))
		if host == "<nil>" {
			host = ""
		}
	}
	port := 3005
	if value, ok := request["port"].(float64); ok {
		port = int(value)
	} else if value, ok := request["port"].(int); ok {
		port = value
	}
	if parsed, parseErr := url.Parse(target); parseErr == nil && parsed.Hostname() != "" {
		host = parsed.Hostname()
		if parsed.Port() != "" {
			if parsedPort, parsePortErr := strconv.Atoi(parsed.Port()); parsePortErr == nil {
				port = parsedPort
			}
		}
	} else if target == "" {
		return failure("INVALID_REQUEST", "url is required")
	}
	if err := ValidateParentAddress(host, port); err != nil {
		return failure("INVALID_PARENT", err.Error())
	}
	method := strings.TrimSpace(fmt.Sprint(request["method"]))
	if method == "" || method == "<nil>" {
		method = http.MethodGet
	}
	body := []byte(nil)
	if value, ok := request["body"]; ok && value != nil {
		if raw, ok := value.(string); ok {
			body = []byte(raw)
		} else if encoded, err := json.Marshal(value); err == nil {
			body = encoded
		}
	}
	requestURL := target
	if parsed, parseErr := url.Parse(target); parseErr != nil || parsed.Hostname() == "" {
		requestURL = "http://" + host + ":" + strconv.Itoa(port) + "/" + strings.TrimPrefix(target, "/")
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(body))
	if err != nil {
		return failure("INVALID_REQUEST", err.Error())
	}
	if headers, ok := request["headers"].(map[string]any); ok {
		for key, value := range headers {
			if strings.EqualFold(key, "x-api-token") || strings.EqualFold(key, "x-terminal-role") || strings.EqualFold(key, "content-type") {
				req.Header.Set(key, fmt.Sprint(value))
			}
		}
	}
	if req.Header.Get("X-API-Token") == "" {
		if token := requestText(request["apiToken"]); token != "" {
			req.Header.Set("X-API-Token", token)
		}
	}
	if req.Header.Get("X-Terminal-Role") == "" {
		if role := requestText(request["terminalRole"]); role != "" {
			req.Header.Set("X-Terminal-Role", role)
		}
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return failure("NETWORK_ERROR", "parent request failed")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 5<<20))
	if err != nil {
		return failure("NETWORK_ERROR", "parent response could not be read")
	}
	return map[string]any{"ok": true, "status": response.StatusCode, "statusText": response.Status, "bodyText": string(responseBody)}
}

func requestText(value any) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}
