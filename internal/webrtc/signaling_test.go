package webrtc

import "testing"

func TestSignalingQueue(t *testing.T) {
	s := NewSignaling(4, 30000)
	if result := s.Handle("POST", "webrtc/send", map[string]any{"type": "offer", "from": "ward-1", "to": "room-1"}); result["success"] != true {
		t.Fatalf("send failed: %#v", result)
	}
	result := s.Handle("GET", "webrtc/poll?id=room-1&client=room-1", nil)
	if result["success"] != true || len(result["messages"].([]map[string]any)) != 1 {
		t.Fatalf("poll failed: %#v", result)
	}
	if result := s.Handle("POST", "webrtc/send", map[string]any{"type": "invalid", "to": "room-1"}); result["success"] != false {
		t.Fatal("invalid message should be rejected")
	}
}
