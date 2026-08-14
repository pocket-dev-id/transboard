package nfc

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeReader struct {
	calls int
}

func (r *fakeReader) Run(ctx context.Context, emit func(string)) error {
	r.calls++
	if r.calls == 1 {
		return errors.New("reader disconnected")
	}
	if emit != nil {
		emit("AABBCC")
		emit("AABBCC")
	}
	<-ctx.Done()
	return nil
}

func TestServiceRetriesReaderAndDeduplicatesUID(t *testing.T) {
	reader := &fakeReader{}
	service := New(reader)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	seen := make(chan string, 2)
	done := make(chan error, 1)
	go func() { done <- service.Run(ctx, func(uid string) { seen <- uid }) }()

	select {
	case uid := <-seen:
		if uid != "AABBCC" {
			t.Fatalf("unexpected UID: %s", uid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reader was not retried")
	}
	select {
	case duplicate := <-seen:
		t.Fatalf("duplicate UID was emitted: %s", duplicate)
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("service did not stop cleanly: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("service did not stop")
	}
	if reader.calls < 2 {
		t.Fatalf("expected a retry, calls=%d", reader.calls)
	}
}
