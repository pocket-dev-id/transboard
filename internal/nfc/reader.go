package nfc

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type Reader interface {
	Run(context.Context, func(string)) error
}

type Service struct {
	reader  Reader
	mu      sync.Mutex
	lastUID string
	lastAt  time.Time
}

func New(reader Reader) *Service { return &Service{reader: reader} }

func (s *Service) Run(ctx context.Context, emit func(string)) error {
	if s.reader == nil {
		return fmt.Errorf("NFC reader is unavailable")
	}
	backoff := 500 * time.Millisecond
	for {
		err := s.reader.Run(ctx, func(uid string) {
			s.mu.Lock()
			if uid == s.lastUID && time.Since(s.lastAt) < 1500*time.Millisecond {
				s.mu.Unlock()
				return
			}
			s.lastUID, s.lastAt = uid, time.Now()
			s.mu.Unlock()
			if emit != nil {
				emit(uid)
			}
		})
		if ctx.Err() != nil {
			return nil
		}
		if err == nil {
			backoff = 500 * time.Millisecond
		} else if backoff < 5*time.Second {
			backoff *= 2
		}
		if waitForContext(ctx, backoff) != nil {
			return nil
		}
	}
}

func waitForContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
