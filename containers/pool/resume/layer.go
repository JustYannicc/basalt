package main

import (
	"net/http"
	"net/url"
	"strings"
)

// Names fixed by the #1642 contract (v1) between the entry side and this layer.
const (
	resumableHeader     = "X-Basalt-Resumable"
	requestIDHeader     = "X-Basalt-Request-Id"
	resumeHeader        = "X-Basalt-Resume"
	resumeFromHeader    = "X-Basalt-Resume-From"
	resumeBootHeader    = "X-Basalt-Resume-Boot"
	resumeStateHeader   = "X-Basalt-Resume-State"
	upstreamStateHeader = "X-Basalt-Resume-Upstream"
	resumePrefix        = "/__basalt/resume/v1/"
	healthPath          = "/__basalt/resume/healthz"
)

// Layer sits in front of the node's model port. It receives only calls the controller marks
// resumable and resume reads; sockets and everything else go to the node directly.
type Layer struct {
	upstream  *url.URL
	transport http.RoundTripper
}

func NewLayer(upstream *url.URL) *Layer {
	return &Layer{upstream: upstream, transport: newUpstreamTransport()}
}

func (l *Layer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == healthPath:
		if r.Method != http.MethodGet {
			closedError(w, http.StatusMethodNotAllowed, "resume_layer_method")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	case strings.HasPrefix(r.URL.Path, resumePrefix):
		l.resume(w, r)
	case isUpgrade(r):
		// Model sockets stay on the node's port; one that arrives here is a routing fault.
		closedError(w, http.StatusBadRequest, "resume_layer_no_upgrade")
	default:
		l.passThrough(w, r)
	}
}

// resume answers "gone" until buffering exists: no id is ever held, which is the contract's
// answer for an unknown id.
func (l *Layer) resume(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		closedError(w, http.StatusMethodNotAllowed, "resume_layer_method")
		return
	}
	w.Header().Set(resumeStateHeader, "gone")
	closedError(w, http.StatusGone, "resume_gone")
}

func isUpgrade(r *http.Request) bool {
	if r.Header.Get("Upgrade") != "" {
		return true
	}
	for _, value := range r.Header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

func closedError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + code + `"}`))
}
