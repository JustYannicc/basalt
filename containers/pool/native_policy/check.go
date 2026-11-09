package main

import (
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// Exercise the admission predicate without selecting an account or dispatching inference.
func handleCheck(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Assertion string `json:"assertion"`
	}
	if !decodeControlBody(writer, request, 8192, &body) || body.Assertion == "" {
		writeControlJSON(writer, http.StatusBadRequest, map[string]any{"ok": false})
		return
	}
	keys, errKeys := signingKeysFromEnvironment()
	if errKeys != nil {
		writeControlJSON(writer, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	input := pluginapi.SchedulerPickRequest{}
	input.Options.Headers = map[string][]string{policyHeader: {body.Assertion}}
	decision := evaluatePick(input, activePolicies.Load(), keys, timeNow())
	if decision.handled || decision.code != "" {
		writeControlJSON(writer, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	writeControlJSON(writer, http.StatusOK, map[string]any{"ok": true})
}
