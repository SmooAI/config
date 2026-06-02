package config

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeTokenSource struct {
	mu            sync.Mutex
	tokens        []string
	idx           int
	invalidations int
	calls         int
}

func (f *fakeTokenSource) GetAccessToken(_ context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	t := f.tokens[minIdx(f.idx, len(f.tokens)-1)]
	f.idx++
	return t, nil
}

func (f *fakeTokenSource) Invalidate() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invalidations++
}

func minIdx(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type recordingWriter struct {
	mu         sync.Mutex
	written    []string
	failOnCall int
	call       int
}

func (w *recordingWriter) PatchBearerToken(token string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.call++
	if w.call == w.failOnCall {
		return errors.New("simulated k8s patch failure")
	}
	w.written = append(w.written, token)
	return nil
}

func (w *recordingWriter) snapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.written...)
}

func TestRunEsoRefresherInitialWrite(t *testing.T) {
	ts := &fakeTokenSource{tokens: []string{"tok-1"}}
	w := &recordingWriter{}
	h, err := RunEsoRefresher(EsoRefresherOptions{TokenSource: ts, SecretWriter: w, Interval: time.Hour})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer h.Stop()
	if got := w.snapshot(); len(got) != 1 || got[0] != "tok-1" {
		t.Errorf("initial write = %v, want [tok-1]", got)
	}
}

func TestRunEsoRefresherForcesFreshEachCall(t *testing.T) {
	ts := &fakeTokenSource{tokens: []string{"tok-1", "tok-2", "tok-3"}}
	w := &recordingWriter{}
	h, err := RunEsoRefresher(EsoRefresherOptions{TokenSource: ts, SecretWriter: w, Interval: time.Hour})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer h.Stop()
	if err := h.RefreshNow(); err != nil {
		t.Fatalf("RefreshNow: %v", err)
	}
	// Startup + one forced refresh = two mints, each preceded by an invalidate.
	if ts.calls != 2 || ts.invalidations != 2 {
		t.Errorf("calls=%d invalidations=%d, want 2/2", ts.calls, ts.invalidations)
	}
	if got := w.snapshot(); len(got) != 2 || got[0] != "tok-1" || got[1] != "tok-2" {
		t.Errorf("written = %v, want [tok-1 tok-2]", got)
	}
}

func TestRunEsoRefresherFailLoudInitial(t *testing.T) {
	ts := &fakeTokenSource{tokens: []string{"tok-1"}}
	w := &recordingWriter{failOnCall: 1} // first (initial) write fails
	_, err := RunEsoRefresher(EsoRefresherOptions{TokenSource: ts, SecretWriter: w, Interval: time.Hour})
	if err == nil {
		t.Error("expected RunEsoRefresher to fail loud when the initial write fails")
	}
}

func TestRunEsoRefresherRequiredFields(t *testing.T) {
	if _, err := RunEsoRefresher(EsoRefresherOptions{SecretWriter: &recordingWriter{}}); err == nil {
		t.Error("expected error for missing TokenSource")
	}
	if _, err := RunEsoRefresher(EsoRefresherOptions{TokenSource: &fakeTokenSource{tokens: []string{"t"}}}); err == nil {
		t.Error("expected error for missing SecretWriter")
	}
}

func TestRunEsoRefresherLoopTicks(t *testing.T) {
	ts := &fakeTokenSource{tokens: []string{"t1", "t2", "t3", "t4", "t5"}}
	w := &recordingWriter{}
	h, err := RunEsoRefresher(EsoRefresherOptions{TokenSource: ts, SecretWriter: w, Interval: 10 * time.Millisecond})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer h.Stop()
	// Wait for the loop to tick at least once past the initial write.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(w.snapshot()) >= 2 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("loop did not tick; writes=%v", w.snapshot())
}
