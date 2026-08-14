package network

import (
	"testing"
	"time"
)

func TestPresenceExpiresDevices(t *testing.T) {
	presence := NewPresence(time.Millisecond)
	presence.Heartbeat(Device{DeviceID: "device-1"})
	time.Sleep(5 * time.Millisecond)
	if len(presence.List()) != 0 {
		t.Fatal("expired device should be removed")
	}
}
