package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} sbm_host_buffer;

typedef int (*sbm_host_call_fn)(void*, const char*, const uint8_t*, size_t, sbm_host_buffer*);
typedef void (*sbm_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	sbm_host_call_fn call;
	sbm_host_free_fn free_buffer;
} sbm_host_api;

static int sbm_call_host(void* raw_host, const char* method, const uint8_t* request, size_t request_len, sbm_host_buffer* response) {
	sbm_host_api* host = (sbm_host_api*)raw_host;
	if (host == NULL || host->call == NULL) {
		return 1;
	}
	return host->call(host->host_ctx, method, request, request_len, response);
}

static void sbm_free_host_buffer(void* raw_host, sbm_host_buffer* response) {
	sbm_host_api* host = (sbm_host_api*)raw_host;
	if (host != NULL && host->free_buffer != NULL && response != NULL && response->ptr != NULL) {
		host->free_buffer(response->ptr, response->len);
		response->ptr = NULL;
		response->len = 0;
	}
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"sync/atomic"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
)

type hostAPIHandle struct {
	pointer unsafe.Pointer
}

var activeHostAPI atomic.Pointer[hostAPIHandle]

func setNativePolicyHostAPI(pointer unsafe.Pointer) {
	if pointer == nil {
		activeHostAPI.Store(nil)
		return
	}
	activeHostAPI.Store(&hostAPIHandle{pointer: pointer})
}

func emitNativePolicyProbeLog(nonce string) error {
	host := activeHostAPI.Load()
	if host == nil || host.pointer == nil {
		return errors.New("native policy host log is unavailable")
	}
	request, errMarshal := json.Marshal(map[string]any{
		"level":   "info",
		"message": nativePolicyProbeLogPrefix + nonce,
		"fields":  map[string]string{"plugin_id": pluginID},
	})
	if errMarshal != nil {
		return errors.New("native policy probe log could not be encoded")
	}
	method := C.CString(pluginabi.MethodHostLog)
	defer C.free(unsafe.Pointer(method))
	requestPointer := C.CBytes(request)
	if requestPointer == nil {
		return errors.New("native policy probe log could not be allocated")
	}
	defer C.free(requestPointer)

	var response C.sbm_host_buffer
	result := C.sbm_call_host(
		host.pointer,
		method,
		(*C.uint8_t)(requestPointer),
		C.size_t(len(request)),
		&response,
	)
	defer C.sbm_free_host_buffer(host.pointer, &response)
	if result != 0 || response.ptr == nil || response.len == 0 {
		return errors.New("native policy host log callback failed")
	}
	raw := C.GoBytes(response.ptr, C.int(response.len))
	var envelope struct {
		OK    bool `json:"ok"`
		Error any  `json:"error"`
	}
	if json.Unmarshal(raw, &envelope) != nil || !envelope.OK || envelope.Error != nil {
		return errors.New("native policy host log callback failed")
	}
	return nil
}
