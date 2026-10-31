package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
)

const (
	socketEnvironment = "POOL_NATIVE_POLICY_SOCKET"
	maxInstallBytes   = 1 << 20
)

var controlState struct {
	sync.Mutex
	server *controlServer
}

var activeControlInstance atomic.Pointer[string]

type controlServer struct {
	path     string
	instance string
	server   *http.Server
	done     chan struct{}
}

type installRequest struct {
	Projection string `json:"projection"`
}

type probeRequest struct {
	Nonce string `json:"nonce"`
}

func startControlServer() error {
	path := strings.TrimSpace(os.Getenv(socketEnvironment))
	if path == "" {
		return nil
	}
	if !filepath.IsAbs(path) || !strings.HasPrefix(filepath.Clean(path), "/dev/shm/cliproxy-pool/") {
		return errors.New("invalid native policy socket path")
	}
	if _, errKeys := signingKeysFromEnvironment(); errKeys != nil {
		return errKeys
	}

	controlState.Lock()
	defer controlState.Unlock()
	if controlState.server != nil && controlState.server.path == path {
		return nil
	}
	if controlState.server != nil {
		stopControlServerLocked()
	}
	if errPrepare := prepareSocketPath(path); errPrepare != nil {
		return errPrepare
	}
	instance, errInstance := randomNonce()
	if errInstance != nil {
		return errors.New("native policy instance identity failed")
	}
	listener, errListen := net.Listen("unix", path)
	if errListen != nil {
		return errors.New("native policy socket failed to start")
	}
	if errMode := os.Chmod(path, 0o600); errMode != nil {
		_ = listener.Close()
		_ = os.Remove(path)
		return errors.New("native policy socket permissions failed")
	}
	server := &controlServer{
		path:     path,
		instance: instance,
		server: &http.Server{
			Handler:  controlHandler(),
			ErrorLog: log.New(io.Discard, "", 0),
		},
		done: make(chan struct{}),
	}
	activeControlInstance.Store(&server.instance)
	controlState.server = server
	go func() {
		defer close(server.done)
		_ = server.server.Serve(listener)
		_ = os.Remove(server.path)
	}()
	return nil
}

func prepareSocketPath(path string) error {
	if errMkdir := os.MkdirAll(filepath.Dir(path), 0o700); errMkdir != nil {
		return errors.New("native policy socket directory failed")
	}
	if errChmod := os.Chmod(filepath.Dir(path), 0o700); errChmod != nil {
		return errors.New("native policy socket directory failed")
	}
	info, errStat := os.Lstat(path)
	if errors.Is(errStat, os.ErrNotExist) {
		return nil
	}
	if errStat != nil || info.Mode()&os.ModeSocket == 0 {
		return errors.New("native policy socket path is occupied")
	}
	conn, errDial := net.DialTimeout("unix", path, 50*time.Millisecond)
	if errDial == nil {
		_ = conn.Close()
		return errors.New("native policy socket is already active")
	}
	if errRemove := os.Remove(path); errRemove != nil {
		return errors.New("stale native policy socket could not be removed")
	}
	return nil
}

func stopControlServer() {
	controlState.Lock()
	stopControlServerLocked()
	controlState.Unlock()
}

func stopControlServerLocked() {
	server := controlState.server
	controlState.server = nil
	if server == nil {
		return
	}
	activeControlInstance.Store(nil)
	_ = server.server.Close()
	<-server.done
	_ = os.Remove(server.path)
}

func controlHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /install", handleInstall)
	mux.HandleFunc("POST /probe", handleProbe)
	return mux
}

func handleInstall(writer http.ResponseWriter, request *http.Request) {
	var body installRequest
	if !decodeControlBody(writer, request, maxInstallBytes, &body) || body.Projection == "" {
		writeControlJSON(writer, http.StatusBadRequest, map[string]any{"error": "invalid_projection"})
		return
	}
	keys, errKeys := signingKeysFromEnvironment()
	if errKeys != nil {
		writeControlJSON(writer, http.StatusServiceUnavailable, map[string]any{"error": "policy_unavailable"})
		return
	}
	revision, errInstall := installPolicyEnvelope(body.Projection, keys, timeNow())
	if errInstall != nil {
		status := http.StatusBadRequest
		if errors.Is(errInstall, errStaleProjection) {
			status = http.StatusConflict
		}
		writeControlJSON(writer, status, map[string]any{"error": "invalid_projection"})
		return
	}
	writeControlJSON(writer, http.StatusOK, map[string]any{"installed": true, "revision": revision})
}

func handleProbe(writer http.ResponseWriter, request *http.Request) {
	var body probeRequest
	if !decodeControlBody(writer, request, 1024, &body) || !validProbeNonce(body.Nonce) {
		writeControlJSON(writer, http.StatusBadRequest, map[string]any{"error": "invalid_probe"})
		return
	}
	runtime.LockOSThread()
	cpuBefore := currentThreadCPUTimeNS()
	raw, _ := handleMethod(pluginabi.MethodSchedulerPick, probePickRequest(body.Nonce))
	var result envelope
	probeValid := json.Unmarshal(raw, &result) == nil && !result.OK &&
		result.Error != nil && result.Error.Code == "native_policy_veto"
	instance := activeControlInstance.Load()
	logValid := probeValid && instance != nil && *instance != "" &&
		emitNativePolicyProbeLog(body.Nonce) == nil
	cpuAfter := currentThreadCPUTimeNS()
	runtime.UnlockOSThread()
	if !probeValid || !logValid {
		writeControlJSON(writer, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	response := map[string]any{"ok": true, "nonce": body.Nonce, "instance": *instance}
	if cpuBefore >= 0 && cpuAfter >= cpuBefore {
		response["cpu_ns"] = cpuAfter - cpuBefore
	}
	writeControlJSON(writer, http.StatusOK, response)
}

func currentThreadCPUTimeNS() int64 {
	var usage syscall.Rusage
	if syscall.Getrusage(1, &usage) != nil {
		return -1
	}
	return (usage.Utime.Sec+usage.Stime.Sec)*1_000_000_000 +
		int64(usage.Utime.Usec+usage.Stime.Usec)*1_000
}

func randomNonce() (string, error) {
	bytes := make([]byte, 24)
	if _, errRandom := rand.Read(bytes); errRandom != nil {
		return "", errRandom
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func probePickRequest(nonce string) []byte {
	req := map[string]any{
		"options": map[string]any{"metadata": map[string]any{probeNonceMetadata: nonce}},
	}
	raw, _ := json.Marshal(req)
	return raw
}

func validProbeNonce(nonce string) bool {
	if len(nonce) < 16 || len(nonce) > 96 {
		return false
	}
	for _, char := range nonce {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

func decodeControlBody(writer http.ResponseWriter, request *http.Request, maxBytes int64, target any) bool {
	if request == nil || request.Body == nil {
		return false
	}
	defer request.Body.Close()
	limited := http.MaxBytesReader(writer, request.Body, maxBytes)
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	var trailing any
	return errors.Is(decoder.Decode(&trailing), io.EOF)
}

func writeControlJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}

var timeNow = func() time.Time { return time.Now() }
