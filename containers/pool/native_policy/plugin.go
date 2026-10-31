package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	void* call;
	void* free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"strings"
	"time"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const (
	nativePolicyProbeLogPrefix = "pool-native-policy-probe:"
	pluginID                   = "basalt-native-policy"
	probeNonceMetadata         = "basalt.native-policy.probe-nonce"
	probeSentinelAuth          = "__basalt_native_policy_probe__"
)

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type registration struct {
	SchemaVersion uint32                 `json:"schema_version"`
	Metadata      pluginapi.Metadata     `json:"metadata"`
	Capabilities  registrationCapability `json:"capabilities"`
}

type registrationCapability struct {
	Scheduler bool `json:"scheduler"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if host == nil || plugin == nil {
		return 1
	}
	setNativePolicyHostAPI(unsafe.Pointer(host))
	if startControlServer() != nil {
		setNativePolicyHostAPI(nil)
		return 1
	}
	plugin.abi_version = C.uint32_t(pluginabi.ABIVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	var requestBytes []byte
	if request != nil && requestLen > 0 {
		requestBytes = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	raw, errHandle := handleMethod(C.GoString(method), requestBytes)
	if errHandle != nil {
		writeResponse(response, errorEnvelope("plugin_error", "plugin callback failed"))
		return 1
	}
	writeResponse(response, raw)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	stopControlServer()
	setNativePolicyHostAPI(nil)
	clearPolicyState()
}

func handleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		return okEnvelope(pluginRegistration())
	case pluginabi.MethodSchedulerPick:
		return pickAuth(request)
	default:
		return errorEnvelope("unknown_method", "unknown plugin method"), nil
	}
}

func pickAuth(raw []byte) ([]byte, error) {
	var req pluginapi.SchedulerPickRequest
	if json.Unmarshal(raw, &req) != nil {
		return errorEnvelope("native_policy_invalid", "scheduler request is invalid"), nil
	}
	if nonce := probeNonce(req); nonce != "" {
		return runSentinelProbe(nonce), nil
	}
	keys, errKeys := signingKeysFromEnvironment()
	if errKeys != nil {
		return errorEnvelope("native_policy_invalid", "native policy signing key is invalid"), nil
	}
	decision := evaluatePick(req, activePolicies.Load(), keys, time.Now())
	if decision.code != "" {
		return errorEnvelope(decision.code, policyErrorMessage(decision.code)), nil
	}
	return okEnvelope(pluginapi.SchedulerPickResponse{Handled: false})
}

func runSentinelProbe(nonce string) []byte {
	key, errKey := probeSigningKey()
	if errKey != nil {
		return errorEnvelope("native_policy_probe_failed", "sentinel veto probe failed")
	}
	now := time.Now()
	projectionExpiresAt := now.UnixMilli() + int64(maxProjectionTTL/time.Millisecond)
	assertionExpiresAt := now.UnixMilli() + int64(maxAssertionTTL/time.Millisecond)
	claims := projectionClaims{
		Pool:         "__basalt_probe_pool__",
		Organization: "__basalt_probe_organization__",
		Revision:     1,
		ExpiresAt:    projectionExpiresAt,
		Accounts:     []string{},
	}
	snapshot, errSnapshot := snapshotForProbe(claims, now)
	if errSnapshot != nil {
		return errorEnvelope("native_policy_probe_failed", "sentinel veto probe failed")
	}
	assertionJSON, errAssertion := json.Marshal(assertionClaims{
		Pool: claims.Pool, Revision: claims.Revision, ExpiresAt: assertionExpiresAt,
	})
	if errAssertion != nil {
		return errorEnvelope("native_policy_probe_failed", "sentinel veto probe failed")
	}
	assertion := signEnvelope(key, assertionPrefix, assertionJSON)
	req := pluginapi.SchedulerPickRequest{
		Options: pluginapi.SchedulerOptions{Headers: map[string][]string{
			"X-Signalbox-Native-Policy": {assertion},
		}},
		Candidates: []pluginapi.SchedulerAuthCandidate{{ID: probeSentinelAuth}},
	}
	decision := evaluatePick(req, &policyRegistry{byPool: map[string]*policySnapshot{claims.Pool: snapshot}}, signingKeys{current: key}, now)
	if decision.code == "native_policy_denied" {
		return errorEnvelope("native_policy_veto", "sentinel veto confirmed")
	}
	return errorEnvelope("native_policy_probe_failed", "sentinel veto probe failed")
}

func snapshotForProbe(claims projectionClaims, now time.Time) (*policySnapshot, error) {
	if !validProjection(claims) {
		return nil, errInvalidEnvelope
	}
	allowed := make(map[string]struct{}, len(claims.Accounts))
	for _, id := range claims.Accounts {
		allowed[id] = struct{}{}
	}
	return &policySnapshot{claims: claims, allowed: allowed, deadline: now.Add(time.Minute)}, nil
}

func probeNonce(req pluginapi.SchedulerPickRequest) string {
	if req.Options.Metadata == nil {
		return ""
	}
	nonce, ok := req.Options.Metadata[probeNonceMetadata].(string)
	if !ok || !validProbeNonce(nonce) {
		return ""
	}
	return nonce
}

func probeSigningKey() ([]byte, error) {
	keys, errKeys := signingKeysFromEnvironment()
	if errKeys != nil {
		return nil, errKeys
	}
	if len(keys.current) == 32 {
		return keys.current, nil
	}
	key := make([]byte, 32)
	if _, errRandom := rand.Read(key); errRandom != nil {
		return nil, errRandom
	}
	return key, nil
}

func signingKeysFromEnvironment() (signingKeys, error) {
	var keys signingKeys
	current := strings.TrimSpace(os.Getenv("POOL_APP_SIGNING_KEY"))
	previous := strings.TrimSpace(os.Getenv("POOL_APP_SIGNING_KEY_PREVIOUS"))
	var errDecode error
	if current != "" {
		keys.current, errDecode = decodeSigningKey(current)
		if errDecode != nil {
			return signingKeys{}, errInvalidEnvelope
		}
	}
	if previous != "" {
		keys.previous, errDecode = decodeSigningKey(previous)
		if errDecode != nil {
			return signingKeys{}, errInvalidEnvelope
		}
	}
	return keys, nil
}

func pluginRegistration() registration {
	return registration{
		SchemaVersion: pluginabi.SchemaVersion,
		Metadata: pluginapi.Metadata{
			Name:             "Basalt native policy",
			Version:          "1.0.0",
			Author:           "Basalt",
			GitHubRepository: "https://github.com/JustYannicc/basalt",
		},
		Capabilities: registrationCapability{Scheduler: true},
	}
}

func policyErrorMessage(code string) string {
	switch code {
	case "native_policy_denied":
		return "native account membership denied this pick"
	case "native_policy_unavailable":
		return "native account membership is not current"
	default:
		return "native policy assertion is invalid"
	}
}

func okEnvelope(value any) ([]byte, error) {
	raw, errMarshal := json.Marshal(value)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil {
		return
	}
	response.ptr = nil
	response.len = 0
	if len(raw) == 0 {
		return
	}
	response.ptr = C.CBytes(raw)
	response.len = C.size_t(len(raw))
}
