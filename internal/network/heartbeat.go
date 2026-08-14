package network

import (
	"sync"
	"time"
)

type Device struct {
	DeviceID     string `json:"deviceId"`
	Name         string `json:"name,omitempty"`
	Hostname     string `json:"hostname,omitempty"`
	WardID       string `json:"wardId,omitempty"`
	Mode         string `json:"mode,omitempty"`
	AppVersion   string `json:"appVersion,omitempty"`
	Page         string `json:"page,omitempty"`
	TerminalName string `json:"terminalName,omitempty"`
	TerminalRole string `json:"terminalRole,omitempty"`
	IP           string `json:"ip,omitempty"`
	LastSeen     int64  `json:"lastSeen"`
}

type Presence struct {
	mu      sync.Mutex
	devices map[string]Device
	ttl     time.Duration
}

func NewPresence(ttl time.Duration) *Presence {
	if ttl <= 0 {
		ttl = 90 * time.Second
	}
	return &Presence{devices: map[string]Device{}, ttl: ttl}
}

func (p *Presence) Heartbeat(device Device) {
	if device.DeviceID == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	device.LastSeen = time.Now().UnixMilli()
	p.devices[device.DeviceID] = device
}

func (p *Presence) List() []Device {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	result := make([]Device, 0, len(p.devices))
	for id, device := range p.devices {
		if now.Sub(time.UnixMilli(device.LastSeen)) > p.ttl {
			delete(p.devices, id)
			continue
		}
		result = append(result, device)
	}
	return result
}

func (p *Presence) Disconnect(deviceID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.devices, deviceID)
}
