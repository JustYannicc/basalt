package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct { uint32_t abi_version; void* host_ctx; cliproxy_host_call_fn call; cliproxy_host_free_fn free_buffer; } cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown; } cliproxy_plugin_api;
extern int typesafeCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void typesafeFree(void*, size_t);
extern void typesafeShutdown(void);
static int invoke_host(cliproxy_host_api* h, const char* m, const uint8_t* r, size_t n, cliproxy_buffer* out) { return h->call(h->host_ctx, m, r, n, out); }
static void free_host(cliproxy_host_api* h, void* p, size_t n) { h->free_buffer(p, n); }
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

var hostState struct {
	sync.RWMutex
	host *C.cliproxy_host_api
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if host == nil || plugin == nil || host.call == nil || host.free_buffer == nil {
		return 1
	}
	hostState.Lock()
	hostState.host = host
	hostState.Unlock()
	plugin.abi_version = 1
	plugin.call = C.cliproxy_plugin_call_fn(C.typesafeCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.typesafeFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.typesafeShutdown)
	return 0
}

//export typesafeCall
func typesafeCall(method *C.char, request *C.uint8_t, length C.size_t, response *C.cliproxy_buffer) C.int {
	if response == nil {
		return 1
	}
	response.ptr, response.len = nil, 0
	if method == nil || uint64(length) > 64*1024*1024 {
		return 1
	}
	raw := C.GoBytes(unsafe.Pointer(request), C.int(length))
	result, errCall := dispatch(context.Background(), C.GoString(method), raw)
	var encoded []byte
	if errCall != nil {
		encoded = errorEnvelope(errCall)
	} else {
		body, errMarshal := json.Marshal(result)
		if errMarshal != nil {
			encoded = errorEnvelope(fmt.Errorf("TypeSafe plugin response could not be encoded"))
		} else {
			encoded, _ = json.Marshal(pluginabi.Envelope{OK: true, Result: body})
		}
	}
	response.ptr = C.CBytes(encoded)
	response.len = C.size_t(len(encoded))
	return 0
}

//export typesafeFree
func typesafeFree(ptr unsafe.Pointer, _ C.size_t) { C.free(ptr) }

//export typesafeShutdown
func typesafeShutdown() {
	hostState.Lock()
	hostState.host = nil
	hostState.Unlock()
}

func callHost[T any](method string, request any) (T, error) {
	var zero T
	hostState.RLock()
	host := hostState.host
	hostState.RUnlock()
	if host == nil {
		return zero, fmt.Errorf("TypeSafe host transport is unavailable")
	}
	raw, errMarshal := json.Marshal(request)
	if errMarshal != nil {
		return zero, fmt.Errorf("TypeSafe host request could not be encoded")
	}
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))
	var ptr *C.uint8_t
	if len(raw) > 0 {
		ptr = (*C.uint8_t)(unsafe.Pointer(&raw[0]))
	}
	var response C.cliproxy_buffer
	code := C.invoke_host(host, cMethod, ptr, C.size_t(len(raw)), &response)
	if response.ptr != nil {
		defer C.free_host(host, response.ptr, response.len)
	}
	if code != 0 {
		return zero, fmt.Errorf("TypeSafe host transport failed")
	}
	var envelope pluginabi.Envelope
	if errDecode := json.Unmarshal(C.GoBytes(response.ptr, C.int(response.len)), &envelope); errDecode != nil || !envelope.OK {
		return zero, fmt.Errorf("TypeSafe host transport failed")
	}
	var result T
	if errDecode := json.Unmarshal(envelope.Result, &result); errDecode != nil {
		return zero, fmt.Errorf("TypeSafe host transport returned an invalid response")
	}
	return result, nil
}

type hostHTTP struct{ callbackID string }

func (h hostHTTP) Do(_ context.Context, req pluginapi.HTTPRequest) (pluginapi.HTTPResponse, error) {
	return callHost[pluginapi.HTTPResponse](pluginabi.MethodHostHTTPDo, struct {
		pluginapi.HTTPRequest
		CallbackID string `json:"host_callback_id"`
	}{req, h.callbackID})
}

func (h hostHTTP) DoStream(context.Context, pluginapi.HTTPRequest) (pluginapi.HTTPStreamResponse, error) {
	return pluginapi.HTTPStreamResponse{}, fmt.Errorf("TypeSafe System One does not stream")
}
